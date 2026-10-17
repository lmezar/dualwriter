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
    let originalSettings: string | undefined;
    let previousSettings: Record<string, unknown> = {};
    const showErrorMessage = vscode.window.showErrorMessage;
    const showInformationMessage = vscode.window.showInformationMessage;

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
        vscode.window.showErrorMessage = ((message: string, ...actions: string[]) => {
            errors.push(message);
            errorActions.push(actions);
            return Promise.resolve(openSettingsOnError ? actions[0] : undefined);
        }) as unknown as typeof vscode.window.showErrorMessage;
        vscode.window.showInformationMessage = ((message: string) => {
            information.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showInformationMessage;
        directory = await fs.mkdtemp(path.join(workspaceDirectory, 'case-'));
        externalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualwriter-external-'));
        await configure({});
    });

    teardown(async () => {
        await configure({});
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        vscode.window.showErrorMessage = showErrorMessage;
        vscode.window.showInformationMessage = showInformationMessage;
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
        assert.match(errors[0], /anterior ya no es compatible/);
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
        assert.deepStrictEqual(errorActions[0], ['Abrir configuración']);
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
        assert.match(errors[1], /solapan/);
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
        assert.match(information[0], /configura dualwriter.groups/);
    });

    test('ignores files outside all groups', async () => {
        await configure({ 'dualwriter.groups': groups() });
        await edit(path.join(directory, 'outside.txt'), 'unrelated');
        await command();
        assert.strictEqual(await read(path.join(directory, 'copy1', 'outside.txt')), undefined);
        assert.strictEqual(await read(path.join(directory, 'copy2', 'outside.txt')), undefined);
        assert.deepStrictEqual(errors, []);
    });
});
