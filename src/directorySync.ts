import { Stats } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { assertSeparateDirectories, containsPath, SyncGroup } from './configuration';
import { canonicalPath, validateGroupPaths } from './sync';

export interface DirectorySyncPlan {
    groups: readonly SyncGroup[];
    groupIndex: number;
    sourceDirectory: string;
    targetDirectory: string;
    sourceSignature: string;
    targetSignature: string | undefined;
    empty: boolean;
}

export interface DirectorySyncOptions {
    isCancellationRequested?: () => boolean;
    onProgress?: (message: string) => void;
    beforeCommit?: () => Promise<void> | void;
    assertCanCommit?: () => void;
}

export interface DirectorySyncResult {
    groupName: string;
    targetDirectory: string;
    retainedPath?: string;
}

// Injectable I/O keeps error/recovery tests deterministic, including on systems
// where permission errors cannot be reproduced by changing file permissions.
export interface DirectorySyncIO {
    copyFile: (source: string, target: string) => Promise<void>;
    rename: (source: string, target: string) => Promise<void>;
    remove: (directory: string) => Promise<void>;
}

const defaultIO: DirectorySyncIO = {
    copyFile: fs.copyFile,
    rename: fs.rename,
    remove: (directory) => fs.rm(directory, { recursive: true, force: true })
};

export class DirectorySyncCancelled extends Error {
    constructor() {
        super('Sincronización cancelada. El destino anterior se ha conservado.');
    }
}

function signature(stats: Stats): string {
    return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
}

async function directorySignature(directory: string): Promise<string | undefined> {
    try {
        const stats = await fs.stat(directory);
        if (!stats.isDirectory()) {
            throw new Error(`La ruta no es un directorio: ${directory}`);
        }
        return signature(stats);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        return undefined;
    }
}

export async function inspectDirectorySync(groups: readonly SyncGroup[], groupIndex: number): Promise<DirectorySyncPlan> {
    if (!groups[groupIndex]) {
        throw new Error('El grupo seleccionado ya no existe.');
    }
    assertSeparateDirectories(groups);
    const resolvedGroups = await validateGroupPaths(groups);
    const { mainDirectory: sourceDirectory, secondaryDirectory: targetDirectory } = resolvedGroups[groupIndex];
    if (targetDirectory === path.parse(targetDirectory).root) {
        throw new Error('No se puede reemplazar la raíz de un disco.');
    }
    const sourceSignature = await directorySignature(sourceDirectory);
    if (sourceSignature === undefined) {
        throw new Error(`El directorio origen no existe: ${sourceDirectory}. No se ha modificado el destino.`);
    }
    return {
        groups: groups.map((group) => ({ ...group })),
        groupIndex,
        sourceDirectory,
        targetDirectory,
        sourceSignature,
        targetSignature: await directorySignature(targetDirectory),
        empty: (await fs.readdir(sourceDirectory)).length === 0
    };
}

async function assertPlanUnchanged(plan: DirectorySyncPlan): Promise<void> {
    const current = await inspectDirectorySync(plan.groups, plan.groupIndex);
    if (current.sourceDirectory !== plan.sourceDirectory || current.targetDirectory !== plan.targetDirectory ||
        current.sourceSignature !== plan.sourceSignature || current.targetSignature !== plan.targetSignature) {
        throw new Error('El origen o el destino han cambiado desde la confirmación. Vuelve a ejecutar el comando.');
    }
}

export async function syncDirectory(
    plan: DirectorySyncPlan,
    options: DirectorySyncOptions = {},
    io: DirectorySyncIO = defaultIO
): Promise<DirectorySyncResult> {
    function checkCancellation(): void {
        if (options.isCancellationRequested?.()) {
            throw new DirectorySyncCancelled();
        }
    }

    checkCancellation();
    await assertPlanUnchanged(plan);
    const parent = path.dirname(plan.targetDirectory);
    await fs.mkdir(parent, { recursive: true });
    // The workspace may contain links; never stage beside a silently retargeted
    // destination. Staging and backup share its filesystem for rename recovery.
    await assertPlanUnchanged(plan);
    const temporary = await fs.mkdtemp(path.join(parent, '.dualwriter-'));
    const staged = path.join(temporary, 'staged');
    const backup = path.join(temporary, 'previous');
    const sourceEntries = new Map<string, string>();
    let backupMoved = false;
    let committed = false;
    let keepTemporary = false;
    let failure: unknown;

    async function copyEntry(relativePath: string): Promise<void> {
        checkCancellation();
        const source = path.join(plan.sourceDirectory, relativePath);
        const target = path.join(staged, relativePath);
        const stats = await fs.lstat(source);
        sourceEntries.set(source, signature(stats));
        options.onProgress?.(`Preparando: ${relativePath || '.'}`);

        if (stats.isDirectory()) {
            await fs.mkdir(target);
            for (const name of await fs.readdir(source)) {
                await copyEntry(path.join(relativePath, name));
            }
            await fs.chmod(target, stats.mode & 0o777);
        } else if (stats.isFile()) {
            await io.copyFile(source, target);
        } else if (stats.isSymbolicLink()) {
            const resolved = await canonicalPath(source);
            if (!containsPath(plan.sourceDirectory, resolved)) {
                throw new Error(`El enlace simbólico sale del origen: ${source}. No se ha modificado el destino.`);
            }
            const destination = path.join(plan.targetDirectory, path.relative(plan.sourceDirectory, resolved));
            let directoryLink = false;
            try {
                directoryLink = (await fs.stat(resolved)).isDirectory();
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            const linkTarget = process.platform === 'win32' && directoryLink
                ? destination
                : path.relative(path.dirname(path.join(plan.targetDirectory, relativePath)), destination) || '.';
            await fs.symlink(linkTarget, target, directoryLink ? 'junction' : 'file');
        } else {
            throw new Error(`Tipo de archivo no compatible con la copia completa: ${source}`);
        }
    }

    try {
        await copyEntry('');
        await options.beforeCommit?.();
        // Reading files changes atime, which is intentionally excluded. Writes,
        // additions, removals and link replacements invalidate the prepared copy.
        for (const [source, expected] of sourceEntries) {
            checkCancellation();
            if (signature(await fs.lstat(source)) !== expected) {
                throw new Error(`El origen cambió durante la copia: ${source}. Vuelve a ejecutar el comando.`);
            }
        }
        await assertPlanUnchanged(plan);
        checkCancellation();
        // A synchronous final guard catches saves/configuration changes that
        // arrived while the asynchronous filesystem checks were running.
        options.assertCanCommit?.();
        options.onProgress?.('Reemplazando destino (esta fase no se puede cancelar)…');

        // No cancellation once replacement starts: always finish publication or
        // restore the previous directory before releasing the group's lock.
        if (plan.targetSignature !== undefined) {
            await io.rename(plan.targetDirectory, backup);
            backupMoved = true;
        }
        try {
            await io.rename(staged, plan.targetDirectory);
        } catch (publishError) {
            if (backupMoved) {
                try {
                    await io.rename(backup, plan.targetDirectory);
                    backupMoved = false;
                } catch (restoreError) {
                    keepTemporary = true;
                    throw new Error(`No se pudo reemplazar ni restaurar el destino. El respaldo se conserva en ${backup}. Error de copia: ${String(publishError)}. Error de restauración: ${String(restoreError)}`);
                }
            }
            throw publishError;
        }
        committed = true;
    } catch (error) {
        failure = error;
    }

    let retainedPath: string | undefined;
    if (!keepTemporary) {
        try {
            await io.remove(temporary);
        } catch (cleanupError) {
            // Removal may already have deleted part of the backup. Report the
            // recovery container, not a child that might no longer exist.
            retainedPath = temporary;
            if (!committed) {
                failure = new Error(`${String(failure)}. No se pudo eliminar el temporal ${temporary}: ${String(cleanupError)}`);
            }
        }
    }
    if (!committed) {
        throw failure;
    }
    return { groupName: plan.groups[plan.groupIndex].name, targetDirectory: plan.targetDirectory, retainedPath };
}
