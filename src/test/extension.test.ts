import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
    let workspaceDirectory: string;
    let directory: string;
    let externalDirectory: string;
    let settingsPath: string;
    let errors: string[];
    let information: string[];
    let errorActions: string[][];
    let openSettingsOnError: boolean;
    let selectedGroup: number | undefined;
    let confirmReplacement: boolean;
    let warnings: { message: string; options: vscode.MessageOptions | undefined; actions: string[] }[];
    let pickerOptions: vscode.QuickPickOptions | undefined;
    let progressOptions: vscode.ProgressOptions[];
    let progressMessages: string[];
    let statusMessages: string[];
    let pickerCount: number;
    let progressCount: number;
    let beforeProgress: (() => Promise<void>) | undefined;
    let beforeConfirmation: (() => Promise<void>) | undefined;
    let cancellation: vscode.CancellationTokenSource;
    let originalSettings: string | undefined;
    let previousSettings: Record<string, unknown> = {};
    const showErrorMessage = vscode.window.showErrorMessage;
    const showInformationMessage = vscode.window.showInformationMessage;
    const showWarningMessage = vscode.window.showWarningMessage;
    const showQuickPick = vscode.window.showQuickPick;
    const withProgress = vscode.window.withProgress;
    const setStatusBarMessage = vscode.window.setStatusBarMessage;

    async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
        const deadline = Date.now() + 5000;
        while (!(await condition())) {
            if (Date.now() > deadline) {
                assert.fail('Timed out waiting for the extension');
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }

    async function configure(settings: Record<string, unknown>): Promise<void> {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
        const keys = new Set([...Object.keys(previousSettings), ...Object.keys(settings)]);
        await waitFor(() => [...keys].every((key) => {
            const inspection = vscode.workspace.getConfiguration().inspect(key);
            return JSON.stringify(inspection?.workspaceValue) === JSON.stringify(settings[key]);
        }));
        previousSettings = settings;
    }

    function groups(): Record<string, unknown>[] {
        return [1, 2].map((number) => ({
            name: `Group ${number}`,
            mainDirectory: path.relative(workspaceDirectory, path.join(directory, `main${number}`)),
            secondaryDirectory: path.relative(workspaceDirectory, path.join(directory, `copy${number}`)),
            bidirectionalSync: true
        }));
    }

    async function edit(filePath: string, content: string): Promise<vscode.TextDocument> {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document);
        return document;
    }

    async function command(): Promise<void> {
        await vscode.commands.executeCommand('dualwriter.syncFiles');
    }

    async function directoryCommand(): Promise<void> {
        await vscode.commands.executeCommand('dualwriter.syncDirectories');
    }

    async function write(filePath: string, content: string): Promise<void> {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
    }

    async function save(document: vscode.TextDocument, content: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(await document.save(), true);
    }

    async function read(filePath: string): Promise<string | undefined> {
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            return undefined;
        }
    }

    suiteSetup(async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'Tests require the isolated workspace from .vscode-test.mjs');
        workspaceDirectory = folder.uri.fsPath;
        settingsPath = path.join(workspaceDirectory, '.vscode', 'settings.json');
        originalSettings = await read(settingsPath);
        const extension = vscode.extensions.getExtension('lmezar.dualwriter');
        assert.ok(extension, 'DualWriter should be available in the extension host');
        await extension.activate();
        assert.ok(extension.isActive);
    });

    setup(async () => {
        errors = [];
        information = [];
        errorActions = [];
        openSettingsOnError = false;
        selectedGroup = undefined;
        confirmReplacement = false;
        warnings = [];
        pickerOptions = undefined;
        progressOptions = [];
        progressMessages = [];
        statusMessages = [];
        pickerCount = 0;
        progressCount = 0;
        beforeProgress = undefined;
        beforeConfirmation = undefined;
        cancellation = new vscode.CancellationTokenSource();
        vscode.window.showErrorMessage = ((message: string, ...actions: string[]) => {
            errors.push(message);
            errorActions.push(actions);
            return Promise.resolve(openSettingsOnError ? actions[0] : undefined);
        }) as unknown as typeof vscode.window.showErrorMessage;
        vscode.window.showInformationMessage = ((message: string) => {
            information.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showInformationMessage;
        vscode.window.showQuickPick = ((items: readonly vscode.QuickPickItem[], options?: vscode.QuickPickOptions) => {
            pickerCount++;
            pickerOptions = options;
            return Promise.resolve(selectedGroup === undefined ? undefined : items[selectedGroup]);
        }) as unknown as typeof vscode.window.showQuickPick;
        vscode.window.showWarningMessage = (async (message: string, options?: vscode.MessageOptions, ...actions: string[]) => {
            warnings.push({ message, options, actions });
            await beforeConfirmation?.();
            return confirmReplacement ? actions[0] : undefined;
        }) as unknown as typeof vscode.window.showWarningMessage;
        vscode.window.withProgress = (async (options: vscode.ProgressOptions, task: (
            progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken
        ) => Thenable<unknown>) => {
            progressCount++;
            progressOptions.push(options);
            await beforeProgress?.();
            return task({ report: ({ message }) => {
                if (message) {
                    progressMessages.push(message);
                }
            } }, cancellation.token);
        }) as typeof vscode.window.withProgress;
        vscode.window.setStatusBarMessage = ((message: string) => {
            statusMessages.push(message);
            return { dispose: () => undefined };
        }) as typeof vscode.window.setStatusBarMessage;
        directory = await fs.mkdtemp(path.join(workspaceDirectory, 'case-'));
        externalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualwriter-external-'));
        await configure({});
    });

    teardown(async () => {
        await configure({});
        for (const document of vscode.workspace.textDocuments) {
            if (document.isDirty && document.uri.scheme === 'file' &&
                (document.uri.fsPath.startsWith(directory + path.sep) || document.uri.fsPath.startsWith(externalDirectory + path.sep))) {
                await vscode.window.showTextDocument(document);
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        vscode.window.showErrorMessage = showErrorMessage;
        vscode.window.showInformationMessage = showInformationMessage;
        vscode.window.showWarningMessage = showWarningMessage;
        vscode.window.showQuickPick = showQuickPick;
        vscode.window.withProgress = withProgress;
        vscode.window.setStatusBarMessage = setStatusBarMessage;
        cancellation.dispose();
        await fs.rm(directory, { recursive: true, force: true });
        await fs.rm(externalDirectory, { recursive: true, force: true });
    });

    suiteTeardown(async () => {
        if (originalSettings === undefined) {
            await fs.rm(settingsPath, { force: true });
        } else {
            await fs.writeFile(settingsPath, originalSettings);
        }
    });

    test('registers the sync command', async () => {
        assert.ok((await vscode.commands.getCommands(true)).includes('dualwriter.syncFiles'));
        assert.ok((await vscode.commands.getCommands(true)).includes('dualwriter.syncDirectories'));
    });

    test('the manual command copies only within the active file group', async () => {
        await configure({ 'dualwriter.groups': groups() });
        for (const number of [1, 2]) {
            for (const reverse of [false, true]) {
                const source = path.join(directory, `${reverse ? 'copy' : 'main'}${number}`, 'src', 'file.txt');
                const target = path.join(directory, `${reverse ? 'main' : 'copy'}${number}`, 'src', 'file.txt');
                const content = `group-${number}-${reverse}`;
                await edit(source, content);
                await command();
                assert.strictEqual(await read(target), content);
                if (number === 1) {
                    assert.strictEqual(await read(path.join(directory, 'main2', 'src', 'file.txt')), undefined);
                    assert.strictEqual(await read(path.join(directory, 'copy2', 'src', 'file.txt')), undefined);
                } else {
                    assert.strictEqual(await read(path.join(directory, 'main1', 'src', 'file.txt')), 'group-1-true');
                    assert.strictEqual(await read(path.join(directory, 'copy1', 'src', 'file.txt')), 'group-1-true');
                }
            }
        }
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(statusMessages[0], 'File synced (Group 1).');
        assert.strictEqual(statusMessages[statusMessages.length - 1], 'File synced (Group 2).');
    });

    test('automatic sync respects each group direction and the global enable switch', async () => {
        const configuredGroups = groups();
        configuredGroups[1].bidirectionalSync = false;
        await configure({ 'dualwriter.groups': configuredGroups, 'dualwriter.enableAutoSave': true });
        const first = await edit(path.join(directory, 'main1', 'file.txt'), 'original');
        await save(first, 'automatic');
        await waitFor(async () => (await read(path.join(directory, 'copy1', 'file.txt'))) === 'automatic');
        assert.strictEqual(await read(path.join(directory, 'copy2', 'file.txt')), undefined);

        const reverse = await edit(path.join(directory, 'copy1', 'reverse.txt'), 'original');
        await save(reverse, 'reverse');
        await waitFor(async () => (await read(path.join(directory, 'main1', 'reverse.txt'))) === 'reverse');

        const oneWay = await edit(path.join(directory, 'copy2', 'file.txt'), 'original');
        await save(oneWay, 'not-copied');
        await command();
        assert.strictEqual(await read(path.join(directory, 'main2', 'file.txt')), undefined);

        await configure({ 'dualwriter.groups': configuredGroups, 'dualwriter.enableAutoSave': false });
        await save(first, 'auto-disabled');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'automatic');
        await vscode.window.showTextDocument(first);
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'auto-disabled');
    });

    test('rejects explicit legacy settings even alongside valid groups and does not repeat the error on saves', async () => {
        const configuredGroups = groups();
        await configure({
            'dualwriter.groups': configuredGroups,
            'dualwriter.bidirectionalSync': false,
            'dualwriter.enableAutoSave': true
        });
        const document = await edit(path.join(directory, 'main1', 'file.txt'), 'original');
        await command();
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /legacy configuration is no longer supported/);
        assert.match(errors[0], /dualwriter.bidirectionalSync/);
        await save(document, 'blocked');
        await command();
        await command();
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), undefined);

        await configure({
            'dualwriter.groups': configuredGroups,
            'dualwriter.bidirectionalSync': false,
            'dualwriter.enableAutoSave': false
        });
        await command();
        assert.strictEqual(errors.length, 1, 'Unrelated setting changes must not repeat the same configuration error');

        await configure({ 'dualwriter.groups': configuredGroups });
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'blocked');
        assert.strictEqual(errors.length, 1);
    });

    test('rejects the old directory pair without converting it to a group', async () => {
        await configure({
            'dualwriter.mainDirectory': path.join(directory, 'main1'),
            'dualwriter.secondaryDirectory': path.join(directory, 'copy1')
        });
        await edit(path.join(directory, 'main1', 'file.txt'), 'legacy');
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), undefined);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /dualwriter.mainDirectory/);
        assert.match(errors[0], /dualwriter.secondaryDirectory/);
    });

    test('the migration error offers to open the settings that need correcting', async () => {
        openSettingsOnError = true;
        await configure({ 'dualwriter.bidirectionalSync': false });
        await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === settingsPath);
        assert.strictEqual(errors.length, 1);
        assert.deepStrictEqual(errorActions[0], ['Open Settings']);
    });

    test('invalid configuration disables all groups and recovers without restarting', async () => {
        const configuredGroups = groups();
        await configure({ 'dualwriter.groups': configuredGroups });
        const document = await edit(path.join(directory, 'main1', 'file.txt'), 'initial');
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'initial');

        await configure({ 'dualwriter.groups': [configuredGroups[0], { mainDirectory: 'incomplete' }] });
        await save(document, 'invalid');
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'initial');
        assert.strictEqual(errors.length, 1);

        await configure({ 'dualwriter.groups': configuredGroups });
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'invalid');

        await configure({ 'dualwriter.groups': [configuredGroups[0], { ...configuredGroups[1], mainDirectory: configuredGroups[0].secondaryDirectory }] });
        await command();
        assert.strictEqual(errors.length, 2);
        assert.match(errors[1], /overlap/);
    });

    test('allows reverse synchronization from a configured directory outside the workspace', async () => {
        const configuredGroups = groups();
        configuredGroups[0].secondaryDirectory = externalDirectory;
        await configure({ 'dualwriter.groups': configuredGroups, 'dualwriter.enableAutoSave': true });
        const document = await edit(path.join(externalDirectory, 'file.txt'), 'external');
        await command();
        assert.strictEqual(await read(path.join(directory, 'main1', 'file.txt')), 'external');
        await save(document, 'external-saved');
        await waitFor(async () => (await read(path.join(directory, 'main1', 'file.txt'))) === 'external-saved');
    });

    test('no groups is not an error and the manual command offers configuration', async () => {
        await configure({ 'dualwriter.groups': [], 'dualwriter.enableAutoSave': true });
        const document = await edit(path.join(directory, 'file.txt'), 'unconfigured');
        await save(document, 'still-unconfigured');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepStrictEqual(information, []);
        await command();
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(information.length, 1);
        assert.match(information[0], /Configure dualwriter.groups/);
    });

    test('ignores files outside all groups', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await edit(path.join(directory, 'outside.txt'), 'unrelated');
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'outside.txt')), undefined);
        assert.strictEqual(await read(path.join(directory, 'copy2', 'outside.txt')), undefined);
        assert.deepStrictEqual(errors, []);
    });

    test('full replacement selects one group, confirms the paths and needs no active editor', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'protected.txt'), 'main-one');
        await write(path.join(directory, 'copy1', 'protected.txt'), 'copy-one');
        await write(path.join(directory, 'main2', 'nested', 'file.txt'), 'new');
        await write(path.join(directory, 'main2', '.hidden'), 'hidden');
        await write(path.join(directory, 'copy2', 'old.txt'), 'old');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        selectedGroup = 1;
        confirmReplacement = true;
        await directoryCommand();

        assert.strictEqual(await read(path.join(directory, 'copy2', 'nested', 'file.txt')), 'new');
        assert.strictEqual(await read(path.join(directory, 'copy2', '.hidden')), 'hidden');
        assert.strictEqual(await read(path.join(directory, 'copy2', 'old.txt')), undefined);
        assert.strictEqual(await read(path.join(directory, 'main2', 'old.txt')), undefined);
        assert.strictEqual(await read(path.join(directory, 'main1', 'protected.txt')), 'main-one');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'protected.txt')), 'copy-one');
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0].message, 'All contents of the destination directory for group "Group 2" will be replaced.');
        assert.strictEqual(warnings[0].options?.modal, true);
        assert.ok(warnings[0].options?.detail?.includes(`Source: ${path.join(directory, 'main2')}`));
        assert.ok(warnings[0].options?.detail?.includes(`Destination: ${path.join(directory, 'copy2')}`));
        assert.match(warnings[0].options?.detail ?? '', /Files that exist only in the destination will be deleted/);
        assert.deepStrictEqual(warnings[0].actions, ['Replace Destination']);
        assert.strictEqual(pickerOptions?.title, 'DualWriter: Sync Entire Directory');
        assert.strictEqual(pickerOptions?.placeHolder, 'Choose the group whose destination you want to replace');
        assert.strictEqual(progressCount, 1);
        assert.strictEqual(progressOptions[0].title, 'DualWriter: Group 2 (main → copy)');
        assert.strictEqual(progressMessages[0], 'Preparing: .');
        assert.strictEqual(progressMessages[progressMessages.length - 1], 'Replacing destination (this phase cannot be cancelled)…');
        assert.deepStrictEqual(information, ['DualWriter: Directory synced (Group 2).']);
        assert.deepStrictEqual(errors, []);
    });

    test('cancelling group selection or confirmation makes no filesystem changes', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'new.txt'), 'new');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        await directoryCommand();
        assert.strictEqual(warnings.length, 0);
        selectedGroup = 0;
        await directoryCommand();
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(progressCount, 0);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'new.txt')), undefined);
    });

    test('an empty source requires an explicit empty-destination warning', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await fs.mkdir(path.join(directory, 'main1'));
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        await directoryCommand();
        assert.match(warnings[0].options?.detail ?? '', /WARNING: The source is empty. The destination will be emptied./);
        assert.deepStrictEqual(await fs.readdir(path.join(directory, 'copy1')), []);
        assert.deepStrictEqual(errors, []);
    });

    test('a missing source never triggers destination cleanup', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        await directoryCommand();
        assert.match(errors[0], /source directory does not exist/);
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
    });

    test('full replacement also requires valid non-legacy configuration and configured groups', async () => {
        await directoryCommand();
        assert.match(information[0], /Configure dualwriter.groups/);
        await configure({ 'dualwriter.groups': groups(), 'dualwriter.bidirectionalSync': false });
        await directoryCommand();
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /legacy configuration is no longer supported/);
        assert.strictEqual(pickerCount, 0);
        assert.strictEqual(progressCount, 0);
    });

    test('dirty source and destination documents are neither saved nor overwritten automatically', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'file.txt'), 'main');
        await write(path.join(directory, 'copy1', 'file.txt'), 'copy');
        selectedGroup = 0;
        confirmReplacement = true;
        for (const name of ['main1', 'copy1']) {
            const filePath = path.join(directory, name, 'file.txt');
            const document = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(document);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved-');
            await vscode.workspace.applyEdit(edit);
            await directoryCommand();
            assert.strictEqual(document.isDirty, true);
            assert.match(errors[errors.length - 1], /unsaved changes/);
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(progressCount, 0);
        assert.strictEqual(await read(path.join(directory, 'main1', 'file.txt')), 'main');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'copy');
    });

    test('progress cancellation keeps the previous destination', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'new.txt'), 'new');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        beforeProgress = async () => { cancellation.cancel(); };
        await directoryCommand();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'new.txt')), undefined);
        assert.strictEqual(information[0], 'DualWriter: Sync cancelled. The previous destination has been preserved.');
        assert.deepStrictEqual(errors, []);
    });

    test('dirty documents opened through an external alias still block full replacement', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'file.txt'), 'main');
        await write(path.join(directory, 'copy1', 'file.txt'), 'copy');
        const alias = path.join(externalDirectory, 'destination-alias');
        await fs.symlink(path.join(directory, 'copy1'), alias, 'junction');
        const document = await vscode.workspace.openTextDocument(path.join(alias, 'file.txt'));
        await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved-');
        await vscode.workspace.applyEdit(edit);
        selectedGroup = 0;
        confirmReplacement = true;
        await directoryCommand();
        assert.match(errors[0], /unsaved changes/);
        assert.strictEqual(document.isDirty, true);
        assert.strictEqual(progressCount, 0);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'copy');
    });

    test('documents edited after confirmation are checked again before replacement', async () => {
        await configure({ 'dualwriter.groups': groups() });
        const document = await edit(path.join(directory, 'main1', 'file.txt'), 'main');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        beforeProgress = async () => {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved-');
            await vscode.workspace.applyEdit(edit);
        };
        await directoryCommand();
        assert.match(errors[0], /unsaved changes/);
        assert.strictEqual(document.isDirty, true);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), undefined);
    });

    test('changing configuration while the confirmation is open requires a new confirmation', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'new.txt'), 'new');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        beforeConfirmation = () => configure({ 'dualwriter.groups': groups(), 'dualwriter.enableAutoSave': true });
        await directoryCommand();
        assert.match(errors[0], /configuration has changed/);
        assert.strictEqual(progressCount, 0);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
    });

    test('changing settings during preparation aborts before the destination is replaced', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'new.txt'), 'new');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        beforeProgress = () => configure({ 'dualwriter.groups': groups(), 'dualwriter.enableAutoSave': true });
        await directoryCommand();
        assert.match(errors[0], /configuration has changed/);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'new.txt')), undefined);
    });

    test('saving during full preparation pauses file sync and aborts the stale replacement', async () => {
        await configure({ 'dualwriter.groups': groups(), 'dualwriter.enableAutoSave': true });
        const document = await edit(path.join(directory, 'main1', 'file.txt'), 'main');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        beforeProgress = async () => {
            await save(document, 'saved-during-copy');
            await command();
            assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), undefined);
        };
        await directoryCommand();
        assert.match(errors[0], /file in this group was saved/);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), undefined);
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'saved-during-copy');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), 'old');
    });

    test('automatic sync in other groups is not paused by full replacement', async () => {
        await configure({ 'dualwriter.groups': groups(), 'dualwriter.enableAutoSave': true });
        await write(path.join(directory, 'main1', 'file.txt'), 'main-one');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        const document = await edit(path.join(directory, 'main2', 'file.txt'), 'main-two');
        await write(path.join(directory, 'copy2', 'keep.txt'), 'keep');
        selectedGroup = 0;
        confirmReplacement = true;
        beforeProgress = async () => {
            await save(document, 'other-group-save');
            await waitFor(async () => (await read(path.join(directory, 'copy2', 'file.txt'))) === 'other-group-save');
        };
        await directoryCommand();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'main-one');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'old.txt')), undefined);
        assert.strictEqual(await read(path.join(directory, 'copy2', 'keep.txt')), 'keep');
        assert.deepStrictEqual(errors, []);
    });

    test('saving a destination alias during preparation aborts even when autosave sync is disabled', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'file.txt'), 'main');
        await write(path.join(directory, 'copy1', 'file.txt'), 'copy');
        const alias = path.join(externalDirectory, 'destination-alias');
        await fs.symlink(path.join(directory, 'copy1'), alias, 'junction');
        const document = await vscode.workspace.openTextDocument(path.join(alias, 'file.txt'));
        await vscode.window.showTextDocument(document);
        selectedGroup = 0;
        confirmReplacement = true;
        beforeProgress = () => save(document, 'saved-copy');
        await directoryCommand();
        assert.match(errors[0], /file in this group was saved/);
        assert.strictEqual(await read(path.join(directory, 'main1', 'file.txt')), 'main');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'saved-copy');
    });

    test('a second full replacement of the same group cannot run concurrently', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await write(path.join(directory, 'main1', 'file.txt'), 'main');
        await write(path.join(directory, 'copy1', 'old.txt'), 'old');
        selectedGroup = 0;
        confirmReplacement = true;
        beforeProgress = directoryCommand;
        await directoryCommand();
        assert.strictEqual(progressCount, 1);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /already in progress/);
        assert.strictEqual(await read(path.join(directory, 'copy1', 'file.txt')), 'main');
    });

    test('autosave and the original manual command never perform directory replacement', async () => {
        await configure({ 'dualwriter.groups': groups(), 'dualwriter.enableAutoSave': true });
        const document = await edit(path.join(directory, 'main1', 'file.txt'), 'main');
        await write(path.join(directory, 'main1', 'not-selected.txt'), 'not-selected');
        await write(path.join(directory, 'copy1', 'keep.txt'), 'keep');
        await save(document, 'saved');
        await waitFor(async () => (await read(path.join(directory, 'copy1', 'file.txt'))) === 'saved');
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'keep.txt')), 'keep');
        assert.strictEqual(await read(path.join(directory, 'copy1', 'not-selected.txt')), undefined);
        assert.strictEqual(pickerCount, 0);
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(progressCount, 0);
    });
});
