import * as fs from 'fs/promises';
import * as path from 'path';
import { assertSeparateDirectories, containsPath, SyncGroup } from './configuration';

// Resolve existing ancestors too, so a destination need not exist yet and
// symbolic links cannot disguise shared or nested group directories.
export async function canonicalPath(filePath: string): Promise<string> {
    try {
        return await fs.realpath(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        // realpath also reports ENOENT for a dangling link. Resolve its target
        // explicitly rather than mistaking the link itself for a missing path.
        let link: string | undefined;
        try {
            link = await fs.readlink(filePath);
        } catch (linkError) {
            if (!['ENOENT', 'EINVAL'].includes((linkError as NodeJS.ErrnoException).code ?? '')) {
                throw linkError;
            }
        }
        if (link !== undefined) {
            return canonicalPath(path.resolve(path.dirname(filePath), link));
        }
        const parent = path.dirname(filePath);
        if (parent === filePath) {
            throw error;
        }
        return path.join(await canonicalPath(parent), path.basename(filePath));
    }
}

async function resolveGroupDirectory(directory: string): Promise<string> {
    try {
        if (!(await fs.stat(directory)).isDirectory()) {
            throw new Error(`The configured path is not a directory: ${directory}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    return canonicalPath(directory);
}

export async function validateGroupPaths(groups: readonly SyncGroup[]): Promise<SyncGroup[]> {
    const resolvedGroups = await Promise.all(groups.map(async (group) => ({
        ...group,
        mainDirectory: await resolveGroupDirectory(group.mainDirectory),
        secondaryDirectory: await resolveGroupDirectory(group.secondaryDirectory)
    })));
    assertSeparateDirectories(resolvedGroups);
    return resolvedGroups;
}

export interface SyncResult {
    groupName: string;
    targetPath: string;
}

export async function syncFile(filePath: string, groups: readonly SyncGroup[]): Promise<SyncResult | undefined> {
    const matches = groups.flatMap((group, index) => {
        if (containsPath(group.mainDirectory, filePath)) {
            return [{ index, source: group.mainDirectory, target: group.secondaryDirectory, reverse: false }];
        }
        if (containsPath(group.secondaryDirectory, filePath)) {
            return [{ index, source: group.secondaryDirectory, target: group.mainDirectory, reverse: true }];
        }
        return [];
    });

    if (matches.length === 0) {
        return undefined;
    }
    if (matches.length > 1) {
        throw new Error('The file belongs to multiple groups. Check dualwriter.groups.');
    }
    const match = matches[0];
    const group = groups[match.index];
    if (match.reverse && !group.bidirectionalSync) {
        return undefined;
    }

    // Recheck on each copy: links may have changed since configuration loading.
    const canonicalGroups = await validateGroupPaths(groups);
    const canonicalGroup = canonicalGroups[match.index];
    const sourceDirectory = match.reverse ? canonicalGroup.secondaryDirectory : canonicalGroup.mainDirectory;
    const targetDirectory = match.reverse ? canonicalGroup.mainDirectory : canonicalGroup.secondaryDirectory;
    const sourceFile = await fs.realpath(filePath);
    const relativePath = path.relative(match.source, filePath);
    const targetPath = path.join(match.target, relativePath);
    const targetFile = await canonicalPath(targetPath);

    if (!containsPath(sourceDirectory, sourceFile) || !containsPath(targetDirectory, targetFile)) {
        throw new Error(`A symbolic link causes the file to leave group "${group.name}". No file was copied.`);
    }

    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.copyFile(sourceFile, targetFile);
    return { groupName: group.name, targetPath };
}
