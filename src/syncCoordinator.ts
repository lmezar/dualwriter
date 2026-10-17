import { containsPath, SyncGroup } from './configuration';
import { canonicalPath } from './sync';

interface FileOperation {
    directories: readonly string[];
    completion: Promise<unknown>;
}

export interface DirectoryActivity {
    directories: readonly string[];
    changed: boolean;
}

function overlaps(first: readonly string[], second: readonly string[]): boolean {
    return first.some((left) => second.some((right) => containsPath(left, right) || containsPath(right, left)));
}

export class SyncCoordinator {
    private readonly files = new Set<FileOperation>();
    private readonly replacements = new Set<DirectoryActivity>();
    private readonly saveChecks = new Map<DirectoryActivity, Set<Promise<void>>>();

    private isPaused(directories: readonly string[]): boolean {
        return [...this.replacements].some((activity) => overlaps(activity.directories, directories));
    }

    noteSave(filePath: string): void {
        const unresolved: DirectoryActivity[] = [];
        for (const activity of this.replacements) {
            if (activity.directories.some((directory) => containsPath(directory, filePath))) {
                activity.changed = true;
            } else {
                unresolved.push(activity);
            }
        }
        if (unresolved.length === 0) {
            return;
        }
        // An editor may have opened the same file through an unconfigured alias.
        const check = canonicalPath(filePath).then((resolved) => {
            for (const activity of unresolved) {
                if (activity.directories.some((directory) => containsPath(directory, resolved))) {
                    activity.changed = true;
                }
            }
        }, () => {
            // If a saved path can no longer be resolved, fail conservatively.
            for (const activity of unresolved) {
                activity.changed = true;
            }
        }).then(() => {
            for (const activity of unresolved) {
                this.saveChecks.get(activity)?.delete(check);
            }
        });
        for (const activity of unresolved) {
            this.saveChecks.get(activity)?.add(check);
        }
    }

    async waitForSaves(activity: DirectoryActivity): Promise<void> {
        await Promise.all([...(this.saveChecks.get(activity) ?? [])]);
    }

    hasPendingSaves(activity: DirectoryActivity): boolean {
        return (this.saveChecks.get(activity)?.size ?? 0) > 0;
    }

    async runFile<T>(group: SyncGroup, operation: () => Promise<T>): Promise<T | undefined> {
        const directories = [group.mainDirectory, group.secondaryDirectory];
        if (this.isPaused(directories)) {
            return undefined;
        }
        directories.push(...await Promise.all(directories.map(canonicalPath)));
        if (this.isPaused(directories)) {
            return undefined;
        }

        const completion = Promise.resolve().then(operation);
        const activity = { directories, completion };
        this.files.add(activity);
        try {
            return await completion;
        } finally {
            this.files.delete(activity);
        }
    }

    async runDirectory<T>(directories: readonly string[], operation: (activity: DirectoryActivity) => Promise<T>): Promise<T> {
        if (this.isPaused(directories)) {
            throw new Error('Ya hay una sincronización completa en curso para este grupo.');
        }
        const activity = { directories, changed: false };
        this.replacements.add(activity);
        this.saveChecks.set(activity, new Set());
        try {
            // Reserve the group before draining copies, so no new file copy can
            // enter while a previously started one is still finishing.
            await Promise.allSettled([...this.files]
                .filter((file) => overlaps(file.directories, directories))
                .map((file) => file.completion));
            return await operation(activity);
        } finally {
            this.replacements.delete(activity);
            this.saveChecks.delete(activity);
        }
    }
}
