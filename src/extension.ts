"use strict";
import * as vscode from 'vscode';
import * as fsExtra from 'fs-extra';
import * as path from 'path';

const extName = 'dualwriter';

function activate(context: vscode.ExtensionContext) {
    const configuration = vscode.workspace.getConfiguration(extName);
    let mainDirectory = configuration.get('mainDirectory', './');
    let secondaryDirectory = configuration.get('secondaryDirectory', './');
    let enableAutoSave = configuration.get('enableAutoSave', false);
    let enableBidirectionalSync = configuration.get('bidirectionalSync', false);

    const syncFilesOnCommand = vscode.commands.registerCommand(`${extName}.syncFiles`, () => {
        const activeTextEditor = vscode.window.activeTextEditor;
        if (activeTextEditor) {
            const document = activeTextEditor.document;
            if (document && vscode.workspace.getWorkspaceFolder(document.uri)) {
                sync(document.uri.fsPath, mainDirectory, secondaryDirectory, enableBidirectionalSync);
            }
        }
    });

    const listenerConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${extName}.enableAutoSave`) ||
            event.affectsConfiguration(`${extName}.mainDirectory`) ||
            event.affectsConfiguration(`${extName}.secondaryDirectory`) ||
            event.affectsConfiguration(`${extName}.bidirectionalSync`)
        ) {
            enableAutoSave = configuration.get('enableAutoSave', false);
            mainDirectory = configuration.get('mainDirectory', './');
            secondaryDirectory = configuration.get('secondaryDirectory', './');
            enableBidirectionalSync = configuration.get('bidirectionalSync', false);
        }
    });

    const syncFilesOnSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (enableAutoSave && vscode.workspace.getWorkspaceFolder(document.uri)) {
            await sync(document.uri.fsPath, mainDirectory, secondaryDirectory, enableBidirectionalSync);
        }
    });

    context.subscriptions.push(syncFilesOnCommand);
    context.subscriptions.push(listenerConfiguration);
    context.subscriptions.push(syncFilesOnSave);
}

async function sync(filePath: string, mainDirectory: string, secondaryDirectory: string, bidirectionalSync: boolean){
    await syncFiles(filePath, mainDirectory, secondaryDirectory);

    if(bidirectionalSync) {
        await syncFiles(filePath, secondaryDirectory, mainDirectory);
    }
}

async function syncFiles(filePath: string, sourcePath: string, targetPath: string) {
    try {
        const relativePath = path.relative(sourcePath, filePath);

		if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
			const sourceFilePath = path.join(sourcePath, relativePath);
			const targetFilePath = path.join(targetPath, relativePath);

			await fsExtra.ensureDir(path.dirname(targetFilePath));
			await fsExtra.copyFile(sourceFilePath, targetFilePath);

			vscode.window.setStatusBarMessage('Archivos sincronizados correctamente.', 5000);
		}
    } catch (error) {
        const errorMessage = (error as Error).message ?? 'Se produjo un error sin mensaje detallado.';
        vscode.window.showErrorMessage(`Error al sincronizar archivos: ${errorMessage}`);
    }
}

function deactivate() {
    // Este método se llama cuando la extensión se desactiva.
}

export { activate, deactivate };
