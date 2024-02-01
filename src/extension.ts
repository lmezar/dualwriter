import * as vscode from 'vscode';
import * as fsExtra from 'fs-extra';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs';

const extName = 'dualwriter';

let currentBranch: string | undefined;

function activate(context: vscode.ExtensionContext) {
    const configuration = vscode.workspace.getConfiguration(extName);
    let mainDirectory = configuration.get('mainDirectory', './');
    let secondaryDirectory = configuration.get('secondaryDirectory', './');
    let enableAutoSave = configuration.get('enableAutoSave', false);

    const syncFilesOnCommand = vscode.commands.registerCommand(`${extName}.syncFiles`, () => {
        const activeTextEditor = vscode.window.activeTextEditor;
        if (activeTextEditor) {
            const document = activeTextEditor.document;
            if (document && vscode.workspace.getWorkspaceFolder(document.uri)) {
                syncFiles(document.uri.fsPath, mainDirectory, secondaryDirectory);
            }
        }
    });

    const listenerConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${extName}.enableAutoSave`) ||
            event.affectsConfiguration(`${extName}.mainDirectory`) ||
            event.affectsConfiguration(`${extName}.secondaryDirectory`)) {
            enableAutoSave = configuration.get('enableAutoSave', false);
            mainDirectory = configuration.get('mainDirectory', './');
            secondaryDirectory = configuration.get('secondaryDirectory', './');
        }
    });

    const syncFilesOnSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (enableAutoSave && vscode.workspace.getWorkspaceFolder(document.uri)) {
            await syncFiles(document.uri.fsPath, mainDirectory, secondaryDirectory);
        }
    });

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const rootPath = workspaceFolders[0].uri.fsPath; // Assuming single-rooted workspace

        fs.watch(rootPath, (event, filename) => {
            if (event === 'change' && filename === '.git') {
                checkGitRepository(rootPath);
            }
        });
    }

    context.subscriptions.push(syncFilesOnCommand);
    context.subscriptions.push(listenerConfiguration);
    context.subscriptions.push(syncFilesOnSave);
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

async function checkGitRepository(rootPath: string) {
    const git: SimpleGit = simpleGit(rootPath);
    try {
        const branchSummary = await git.branch();
        const newBranch = branchSummary.current;

        if (newBranch && newBranch !== currentBranch) {
            currentBranch = newBranch;
            vscode.window.showInformationMessage(`Cambiaste a la rama: ${currentBranch}`);
        }
    } catch (error) {
        vscode.window.showWarningMessage('No se pudo obtener información de la rama actual.');
    }
}


function deactivate() {
    // Este método se llama cuando la extensión se desactiva.
}

export { activate, deactivate };
