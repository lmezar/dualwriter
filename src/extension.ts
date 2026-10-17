import * as vscode from 'vscode';
import * as path from 'path';
import { hasExplicitValue, legacySettings, parseConfiguration, SyncConfiguration } from './configuration';
import { syncFile, validateGroupPaths } from './sync';

const extName = 'dualwriter';
const openSettingsLabel = 'Abrir configuración';
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
        void vscode.window.showErrorMessage(`DualWriter: no se pudo abrir la configuración: ${errorMessage(reason)}`);
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function activate(context: vscode.ExtensionContext) {
    let configuration: SyncConfiguration | undefined;
    let lastConfigurationError: string | undefined;
    let revision = 0;

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
                throw new Error(`La configuración anterior ya no es compatible. Configura dualwriter.groups y elimina estas opciones de los ajustes de usuario, workspace y carpeta: ${configuredLegacySettings.map((key) => `${extName}.${key}`).join(', ')}. La sincronización está desactivada.`);
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
        if (!configuration || document.uri.scheme !== 'file' || (automatic && !configuration.enableAutoSave)) {
            return;
        }
        if (configuration.groups.length === 0) {
            if (!automatic) {
                offerConfiguration('DualWriter: configura dualwriter.groups para empezar a sincronizar archivos.',
                    vscode.workspace.workspaceFolders?.length ? 'workspace' : 'user', false);
            }
            return;
        }
        try {
            const result = await syncFile(document.uri.fsPath, configuration.groups);
            if (result) {
                vscode.window.setStatusBarMessage(`Archivo sincronizado (${result.groupName}).`, 5000);
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`DualWriter: error al sincronizar archivos: ${errorMessage(error)}`);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(`${extName}.syncFiles`, async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (document) {
                await syncDocument(document, false);
            }
        }),
        vscode.workspace.onDidSaveTextDocument((document) => syncDocument(document, true)),
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
    // Este método se llama cuando la extensión se desactiva.
}

export { activate, deactivate };
