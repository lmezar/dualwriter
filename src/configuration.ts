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
                throw new Error(`Directories in "${current.name}" and "${other.name}" are identical or overlap: ${current.directory} / ${other.directory}. Each directory must belong exclusively to one pair, with no nested directories.`);
            }
        }
    }
}

function resolveDirectory(value: unknown, setting: string, baseDirectory: string | undefined): string {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
        throw new Error(`${setting} must be a non-empty path.`);
    }
    if (!path.isAbsolute(value) && !baseDirectory) {
        throw new Error(`${setting} must be an absolute path when no workspace folder or saved .code-workspace file is available.`);
    }
    return path.resolve(baseDirectory ?? '', value);
}

export function parseConfiguration(rawGroups: unknown, enableAutoSave: unknown, baseDirectory?: string): SyncConfiguration {
    if (typeof enableAutoSave !== 'boolean') {
        throw new Error('dualwriter.enableAutoSave must be a boolean.');
    }
    if (!Array.isArray(rawGroups)) {
        throw new Error('dualwriter.groups must be an array of groups.');
    }

    const groups = rawGroups.map((value: unknown, index): SyncGroup => {
        const setting = `dualwriter.groups[${index}]`;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error(`${setting} must be an object with mainDirectory and secondaryDirectory.`);
        }
        const group = value as Record<string, unknown>;
        const allowedKeys = ['name', 'mainDirectory', 'secondaryDirectory', 'bidirectionalSync'];
        const unknownKey = Object.keys(group).find((key) => !allowedKeys.includes(key));
        if (unknownKey) {
            throw new Error(`${setting}.${unknownKey} is not a valid setting.`);
        }
        if (group.name !== undefined && (typeof group.name !== 'string' || group.name.trim() === '')) {
            throw new Error(`${setting}.name must be a non-empty name.`);
        }
        if (group.bidirectionalSync !== undefined && typeof group.bidirectionalSync !== 'boolean') {
            throw new Error(`${setting}.bidirectionalSync must be a boolean.`);
        }

        return {
            name: typeof group.name === 'string' ? group.name : `Group ${index + 1}`,
            mainDirectory: resolveDirectory(group.mainDirectory, `${setting}.mainDirectory`, baseDirectory),
            secondaryDirectory: resolveDirectory(group.secondaryDirectory, `${setting}.secondaryDirectory`, baseDirectory),
            bidirectionalSync: group.bidirectionalSync === true
        };
    });

    assertSeparateDirectories(groups);
    return { groups, enableAutoSave };
}
