import * as vscode from 'vscode';
import * as path from 'path';
import { containsPath, hasExplicitValue, legacySettings, parseConfiguration, SyncConfiguration } from './configuration';
import { canonicalPath, syncFile, validateGroupPaths } from './sync';
import { DirectorySyncCancelled, DirectorySyncPlan, inspectDirectorySync, syncDirectory } from './directorySync';
import { SyncCoordinator } from './syncCoordinator';

const extName = 'dualwriter';
const openSettingsLabel = 'Open Settings';
type SettingsLocation = 'user' | 'workspace' | vscode.Uri;

function workspaceDirectory(): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1 && folders[0].uri.scheme === 'file') {
        return folders[0].uri.fsPath;
    }
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile?.scheme === 'file') {
        return path.dirname(workspaceFile.fsPath);
    }
    return undefined;
}

async function openConfiguration(location: SettingsLocation): Promise<void> {
    if (location instanceof vscode.Uri) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(location));
    } else {
        await vscode.commands.executeCommand(location === 'user'
            ? 'workbench.action.openSettingsJson'
            : 'workbench.action.openWorkspaceSettingsFile');
    }
}

function offerConfiguration(message: string, location: SettingsLocation, error: boolean): void {
    const notification = error
        ? vscode.window.showErrorMessage(message, openSettingsLabel)
        : vscode.window.showInformationMessage(message, openSettingsLabel);
    void notification.then(async (selection) => {
        if (selection === openSettingsLabel) {
            await openConfiguration(location);
        }
    }).then(undefined, (reason: unknown) => {
        void vscode.window.showErrorMessage(`DualWriter: Could not open settings: ${errorMessage(reason)}`);
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function assertDocumentsSaved(plan: DirectorySyncPlan): Promise<void> {
    const group = plan.groups[plan.groupIndex];
    const directories = [group.mainDirectory, group.secondaryDirectory, plan.sourceDirectory, plan.targetDirectory];
    for (const document of vscode.workspace.textDocuments) {
        if (!document.isDirty || document.uri.scheme !== 'file') {
            continue;
        }
        let related = directories.some((directory) => containsPath(directory, document.uri.fsPath));
        if (!related) {
            try {
                const resolved = await canonicalPath(document.uri.fsPath);
                related = directories.some((directory) => containsPath(directory, resolved));
            } catch {
                // An inaccessible unrelated document is not part of this group.
            }
        }
        if (related) {
            throw new Error(`There are unsaved changes in ${document.uri.fsPath}. Save or discard changes in the source and destination before syncing the directory.`);
        }
    }
}

function activate(context: vscode.ExtensionContext) {
    let configuration: SyncConfiguration | undefined;
    let lastConfigurationError: string | undefined;
    let revision = 0;
    const coordinator = new SyncCoordinator();

    async function reloadConfiguration(): Promise<void> {
        const currentRevision = ++revision;
        configuration = undefined;
        const settings = vscode.workspace.getConfiguration(extName);
        let location: SettingsLocation = vscode.workspace.workspaceFolders?.length ? 'workspace' : 'user';

        try {
            const scopedSettings = [settings, ...(vscode.workspace.workspaceFolders ?? []).map((folder) =>
                vscode.workspace.getConfiguration(extName, folder.uri))];
            const configuredLegacySettings = legacySettings.filter((key) =>
                scopedSettings.some((scope) => hasExplicitValue(scope.inspect(key))));

            if (configuredLegacySettings.length > 0) {
                for (const key of configuredLegacySettings) {
                    if (settings.inspect(key)?.globalValue !== undefined) {
                        location = 'user';
                        break;
                    }
                    const folder = vscode.workspace.workspaceFolders?.find((candidate) =>
                        vscode.workspace.getConfiguration(extName, candidate.uri).inspect(key)?.workspaceFolderValue !== undefined);
                    if (folder) {
                        location = vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json');
                        break;
                    }
                }
                throw new Error(`The legacy configuration is no longer supported. Configure dualwriter.groups and remove these settings from user, workspace, and folder settings: ${configuredLegacySettings.map((key) => `${extName}.${key}`).join(', ')}. Sync is disabled.`);
            }

            if (settings.inspect('groups')?.workspaceValue === undefined && settings.inspect('groups')?.globalValue !== undefined) {
                location = 'user';
            }
            const next = parseConfiguration(settings.get('groups', []), settings.get('enableAutoSave', false), workspaceDirectory());
            await validateGroupPaths(next.groups);
            if (currentRevision !== revision) {
                return;
            }
            configuration = next;
            lastConfigurationError = undefined;
        } catch (error) {
            if (currentRevision !== revision) {
                return;
            }
            const message = `DualWriter: ${errorMessage(error)}`;
            if (message !== lastConfigurationError) {
                lastConfigurationError = message;
                offerConfiguration(message, location, true);
            }
        }
    }

    let ready = reloadConfiguration();

    async function syncDocument(document: vscode.TextDocument, automatic: boolean): Promise<void> {
        await ready;
        const current = configuration;
        if (!current || document.uri.scheme !== 'file' || (automatic && !current.enableAutoSave)) {
            return;
        }
        if (current.groups.length === 0) {
            if (!automatic) {
                offerConfiguration('DualWriter: Configure dualwriter.groups to start syncing files.',
                    vscode.workspace.workspaceFolders?.length ? 'workspace' : 'user', false);
            }
            return;
        }
        const group = current.groups.find((candidate) => containsPath(candidate.mainDirectory, document.uri.fsPath) ||
            containsPath(candidate.secondaryDirectory, document.uri.fsPath));
        if (!group) {
            return;
        }
        try {
            const result = await coordinator.runFile(group, () => syncFile(document.uri.fsPath, current.groups));
            if (result) {
                vscode.window.setStatusBarMessage(`File synced (${result.groupName}).`, 5000);
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`DualWriter: Could not sync files: ${errorMessage(error)}`);
        }
    }

    async function syncDirectories(): Promise<void> {
        await ready;
        const current = configuration;
        const currentRevision = revision;
        if (!current) {
            return;
        }
        if (current.groups.length === 0) {
            offerConfiguration('DualWriter: Configure dualwriter.groups to start syncing directories.',
                vscode.workspace.workspaceFolders?.length ? 'workspace' : 'user', false);
            return;
        }

        function assertConfigurationUnchanged(): void {
            if (currentRevision !== revision || current !== configuration) {
                throw new Error('The configuration has changed. Run the command again and confirm the current paths.');
            }
        }

        try {
            const selected = await vscode.window.showQuickPick(current.groups.map((group, index) => ({
                label: group.name,
                description: 'main → copy',
                detail: `${group.mainDirectory} → ${group.secondaryDirectory}`,
                index
            })), { title: 'DualWriter: Sync Entire Directory', placeHolder: 'Choose the group whose destination you want to replace' });
            if (!selected) {
                return;
            }
            assertConfigurationUnchanged();
            const plan = await inspectDirectorySync(current.groups, selected.index);
            await assertDocumentsSaved(plan);
            const confirmation = await vscode.window.showWarningMessage(
                `All contents of the destination directory for group "${selected.label}" will be replaced.`,
                {
                    modal: true,
                    detail: `Source: ${plan.sourceDirectory}\nDestination: ${plan.targetDirectory}\n\nFiles that exist only in the destination will be deleted, and the ENTIRE source will be copied, including hidden files. The source will not be modified.${plan.empty ? '\n\nWARNING: The source is empty. The destination will be emptied.' : ''}`
                },
                'Replace Destination'
            );
            if (confirmation !== 'Replace Destination') {
                return;
            }
            assertConfigurationUnchanged();

            const group = current.groups[selected.index];
            const result = await coordinator.runDirectory(
                [group.mainDirectory, group.secondaryDirectory, plan.sourceDirectory, plan.targetDirectory],
                async (activity) => {
                    function assertState(requireResolvedSaves = false): void {
                        assertConfigurationUnchanged();
                        if (activity.changed) {
                            throw new Error('A file in this group was saved during preparation. Run the command again; the destination has not been replaced.');
                        }
                        if (requireResolvedSaves && coordinator.hasPendingSaves(activity)) {
                            throw new Error('Saved changes are still being checked. Run the command again; the destination has not been replaced.');
                        }
                        const dirty = vscode.workspace.textDocuments.find((document) => document.isDirty &&
                            document.uri.scheme === 'file' && activity.directories.some((directory) => containsPath(directory, document.uri.fsPath)));
                        if (dirty) {
                            throw new Error(`There are unsaved changes in ${dirty.uri.fsPath}. Save or discard changes before syncing the directory.`);
                        }
                    }
                    async function assertReady(): Promise<void> {
                        await coordinator.waitForSaves(activity);
                        assertState();
                        await assertDocumentsSaved(plan);
                        await coordinator.waitForSaves(activity);
                        assertState(true);
                    }
                    await assertReady();
                    return vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `DualWriter: ${group.name} (main → copy)`,
                        cancellable: true
                    }, (progress, token) => syncDirectory(plan, {
                        isCancellationRequested: () => token.isCancellationRequested,
                        onProgress: (message) => {
                            assertState();
                            progress.report({ message });
                        },
                        beforeCommit: assertReady,
                        assertCanCommit: () => assertState(true)
                    }));
                }
            );
            if (result.retainedPath) {
                void vscode.window.showWarningMessage(`DualWriter: Directory synced, but the backup or temporary directory could not be removed: ${result.retainedPath}`);
            } else {
                void vscode.window.showInformationMessage(`DualWriter: Directory synced (${result.groupName}).`);
            }
        } catch (error) {
            if (error instanceof DirectorySyncCancelled) {
                void vscode.window.showInformationMessage(`DualWriter: ${error.message}`);
            } else {
                void vscode.window.showErrorMessage(`DualWriter: Could not sync directory: ${errorMessage(error)}`);
            }
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(`${extName}.syncFiles`, async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (document) {
                await syncDocument(document, false);
            }
        }),
        vscode.commands.registerCommand(`${extName}.syncDirectories`, syncDirectories),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme === 'file') {
                coordinator.noteSave(document.uri.fsPath);
            }
            return syncDocument(document, true);
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(extName)) {
                ready = reloadConfiguration();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            ready = reloadConfiguration();
        })
    );
}

function deactivate() {
    // Called when the extension is deactivated.
}

export { activate, deactivate };
