import * as path from 'path';

export interface SyncGroup {
    name: string;
    mainDirectory: string;
    secondaryDirectory: string;
    bidirectionalSync: boolean;
}

export interface SyncConfiguration {
    groups: SyncGroup[];
    enableAutoSave: boolean;
}

export const legacySettings = ['mainDirectory', 'secondaryDirectory', 'bidirectionalSync'] as const;

export interface SettingInspection {
    defaultValue?: unknown;
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
}

export function hasExplicitValue(inspection: SettingInspection | undefined): boolean {
    return inspection !== undefined && (
        inspection.globalValue !== undefined ||
        inspection.workspaceValue !== undefined ||
        inspection.workspaceFolderValue !== undefined
    );
}

export function containsPath(directory: string, filePath: string): boolean {
    const relativePath = path.relative(directory, filePath);
    return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

export function assertSeparateDirectories(groups: readonly SyncGroup[]): void {
    const directories = groups.flatMap((group) => [
        { name: group.name, directory: group.mainDirectory },
        { name: group.name, directory: group.secondaryDirectory }
    ]);

    for (let index = 0; index < directories.length; index++) {
        for (const other of directories.slice(index + 1)) {
            const current = directories[index];
            if (containsPath(current.directory, other.directory) || containsPath(other.directory, current.directory)) {
                throw new Error(`Los directorios de "${current.name}" y "${other.name}" coinciden o se solapan: ${current.directory} / ${other.directory}. Cada directorio debe pertenecer exclusivamente a una pareja sin directorios anidados.`);
            }
        }
    }
}

function resolveDirectory(value: unknown, setting: string, baseDirectory: string | undefined): string {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
        throw new Error(`${setting} debe ser una ruta no vacía.`);
    }
    if (!path.isAbsolute(value) && !baseDirectory) {
        throw new Error(`${setting} debe ser una ruta absoluta cuando no hay una carpeta de workspace o un archivo .code-workspace guardado.`);
    }
    return path.resolve(baseDirectory ?? '', value);
}

export function parseConfiguration(rawGroups: unknown, enableAutoSave: unknown, baseDirectory?: string): SyncConfiguration {
    if (typeof enableAutoSave !== 'boolean') {
        throw new Error('dualwriter.enableAutoSave debe ser un booleano.');
    }
    if (!Array.isArray(rawGroups)) {
        throw new Error('dualwriter.groups debe ser una lista de grupos.');
    }

    const groups = rawGroups.map((value: unknown, index): SyncGroup => {
        const setting = `dualwriter.groups[${index}]`;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error(`${setting} debe ser un objeto con mainDirectory y secondaryDirectory.`);
        }
        const group = value as Record<string, unknown>;
        const allowedKeys = ['name', 'mainDirectory', 'secondaryDirectory', 'bidirectionalSync'];
        const unknownKey = Object.keys(group).find((key) => !allowedKeys.includes(key));
        if (unknownKey) {
            throw new Error(`${setting}.${unknownKey} no es una opción válida.`);
        }
        if (group.name !== undefined && (typeof group.name !== 'string' || group.name.trim() === '')) {
            throw new Error(`${setting}.name debe ser un nombre no vacío.`);
        }
        if (group.bidirectionalSync !== undefined && typeof group.bidirectionalSync !== 'boolean') {
            throw new Error(`${setting}.bidirectionalSync debe ser un booleano.`);
        }

        return {
            name: typeof group.name === 'string' ? group.name : `Grupo ${index + 1}`,
            mainDirectory: resolveDirectory(group.mainDirectory, `${setting}.mainDirectory`, baseDirectory),
            secondaryDirectory: resolveDirectory(group.secondaryDirectory, `${setting}.secondaryDirectory`, baseDirectory),
            bidirectionalSync: group.bidirectionalSync === true
        };
    });

    assertSeparateDirectories(groups);
    return { groups, enableAutoSave };
}
