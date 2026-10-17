import * as vscode from 'vscode';
import * as path from 'path';
import { containsPath, hasExplicitValue, legacySettings, parseConfiguration, SyncConfiguration } from './configuration';
import { canonicalPath, syncFile, validateGroupPaths } from './sync';
import { DirectorySyncCancelled, DirectorySyncPlan, inspectDirectorySync, syncDirectory } from './directorySync';
import { SyncCoordinator } from './syncCoordinator';

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
            throw new Error(`Hay cambios sin guardar en ${document.uri.fsPath}. Guarda o descarta los cambios del origen y del destino antes de sincronizar el directorio.`);
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
        const current = configuration;
        if (!current || document.uri.scheme !== 'file' || (automatic && !current.enableAutoSave)) {
            return;
        }
        if (current.groups.length === 0) {
            if (!automatic) {
                offerConfiguration('DualWriter: configura dualwriter.groups para empezar a sincronizar archivos.',
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
                vscode.window.setStatusBarMessage(`Archivo sincronizado (${result.groupName}).`, 5000);
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`DualWriter: error al sincronizar archivos: ${errorMessage(error)}`);
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
            offerConfiguration('DualWriter: configura dualwriter.groups para empezar a sincronizar directorios.',
                vscode.workspace.workspaceFolders?.length ? 'workspace' : 'user', false);
            return;
        }

        function assertConfigurationUnchanged(): void {
            if (currentRevision !== revision || current !== configuration) {
                throw new Error('La configuración ha cambiado. Vuelve a ejecutar el comando y confirma las rutas actuales.');
            }
        }

        try {
            const selected = await vscode.window.showQuickPick(current.groups.map((group, index) => ({
                label: group.name,
                description: 'main → copy',
                detail: `${group.mainDirectory} → ${group.secondaryDirectory}`,
                index
            })), { title: 'DualWriter: sincronizar directorio completo', placeHolder: 'Elige el grupo cuyo destino quieres reemplazar' });
            if (!selected) {
                return;
            }
            assertConfigurationUnchanged();
            const plan = await inspectDirectorySync(current.groups, selected.index);
            await assertDocumentsSaved(plan);
            const confirmation = await vscode.window.showWarningMessage(
                `Se reemplazará todo el contenido del destino del grupo "${selected.label}".`,
                {
                    modal: true,
                    detail: `Origen: ${plan.sourceDirectory}\nDestino: ${plan.targetDirectory}\n\nSe eliminarán los archivos exclusivos del destino y se copiará TODO el origen, incluidos archivos ocultos. No se modificará el origen.${plan.empty ? '\n\nATENCIÓN: el origen está vacío. El destino quedará vacío.' : ''}`
                },
                'Reemplazar destino'
            );
            if (confirmation !== 'Reemplazar destino') {
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
                            throw new Error('Se ha guardado un archivo del grupo durante la preparación. Vuelve a ejecutar el comando; el destino no se ha reemplazado.');
                        }
                        if (requireResolvedSaves && coordinator.hasPendingSaves(activity)) {
                            throw new Error('Hay cambios guardados pendientes de comprobar. Vuelve a ejecutar el comando; el destino no se ha reemplazado.');
                        }
                        const dirty = vscode.workspace.textDocuments.find((document) => document.isDirty &&
                            document.uri.scheme === 'file' && activity.directories.some((directory) => containsPath(directory, document.uri.fsPath)));
                        if (dirty) {
                            throw new Error(`Hay cambios sin guardar en ${dirty.uri.fsPath}. Guarda o descarta los cambios antes de sincronizar el directorio.`);
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
                void vscode.window.showWarningMessage(`DualWriter: directorio sincronizado, pero no se pudo eliminar el respaldo o temporal: ${result.retainedPath}`);
            } else {
                void vscode.window.showInformationMessage(`DualWriter: directorio sincronizado (${result.groupName}).`);
            }
        } catch (error) {
            if (error instanceof DirectorySyncCancelled) {
                void vscode.window.showInformationMessage(`DualWriter: ${error.message}`);
            } else {
                void vscode.window.showErrorMessage(`DualWriter: error al sincronizar el directorio: ${errorMessage(error)}`);
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
    // Este método se llama cuando la extensión se desactiva.
}

export { activate, deactivate };
