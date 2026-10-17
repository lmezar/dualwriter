import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseConfiguration, SyncGroup } from '../configuration';
import { SyncCoordinator } from '../syncCoordinator';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => { resolve = complete; });
    return { promise, resolve };
}

suite('Synchronization coordination', () => {
    let directory: string;
    let groups: SyncGroup[];
    let coordinator: SyncCoordinator;

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualwriter-coordinator-'));
        groups = parseConfiguration([
            { mainDirectory: 'main1', secondaryDirectory: 'copy1' },
            { mainDirectory: 'main2', secondaryDirectory: 'copy2' }
        ], false, directory).groups;
        coordinator = new SyncCoordinator();
    });

    teardown(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    function directories(index = 0): string[] {
        return [groups[index].mainDirectory, groups[index].secondaryDirectory];
    }

    test('waits for existing file copies and skips new ones only for the replacing group', async () => {
        const started = deferred();
        const finishFile = deferred();
        const finishDirectory = deferred();
        const directoryStarted = deferred();
        const file = coordinator.runFile(groups[0], async () => {
            started.resolve();
            await finishFile.promise;
        });
        await started.promise;
        let replacing = false;
        const replacement = coordinator.runDirectory(directories(), async () => {
            replacing = true;
            directoryStarted.resolve();
            await finishDirectory.promise;
        });
        assert.strictEqual(await coordinator.runFile(groups[0], async () => assert.fail('Copy must be paused')), undefined);
        assert.strictEqual(await coordinator.runFile(groups[1], async () => 'other group'), 'other group');
        assert.strictEqual(replacing, false);
        finishFile.resolve();
        await file;
        await directoryStarted.promise;
        assert.strictEqual(await coordinator.runFile(groups[0], async () => assert.fail('Copy must still be paused')), undefined);
        finishDirectory.resolve();
        await replacement;
        assert.strictEqual(await coordinator.runFile(groups[0], async () => 'resumed'), 'resumed');
    });

    test('rejects overlapping full replacements but permits other groups', async () => {
        const finish = deferred();
        const first = coordinator.runDirectory(directories(), async () => finish.promise);
        await assert.rejects(coordinator.runDirectory(directories(), async () => undefined), /already in progress/);
        assert.strictEqual(await coordinator.runDirectory(directories(1), async () => 'other'), 'other');
        finish.resolve();
        await first;
    });

    test('records concurrent saves in either direction, but not sibling paths or other groups', async () => {
        await coordinator.runDirectory(directories(), async (activity) => {
            coordinator.noteSave(path.join(groups[1].mainDirectory, 'file.txt'));
            coordinator.noteSave(`${groups[0].mainDirectory}-other/file.txt`);
            await coordinator.waitForSaves(activity);
            assert.strictEqual(activity.changed, false);
            coordinator.noteSave(path.join(groups[0].secondaryDirectory, 'file.txt'));
            assert.strictEqual(activity.changed, true);
        });
        await coordinator.runDirectory(directories(), async (activity) => {
            coordinator.noteSave(path.join(groups[0].mainDirectory, 'file.txt'));
            assert.strictEqual(activity.changed, true);
        });
    });

    test('errors release both file tracking and replacement locks', async () => {
        await assert.rejects(coordinator.runFile(groups[0], async () => { throw new Error('file failed'); }), /file failed/);
        await assert.rejects(coordinator.runDirectory(directories(), async () => { throw new Error('directory failed'); }), /directory failed/);
        assert.strictEqual(await coordinator.runFile(groups[0], async () => 'resumed'), 'resumed');
        assert.strictEqual(await coordinator.runDirectory(directories(), async () => 'resumed'), 'resumed');
    });

    test('canonical directory aliases cannot bypass a replacement lock', async () => {
        await fs.mkdir(groups[0].mainDirectory);
        const alias = { ...groups[0], mainDirectory: path.join(directory, 'alias') };
        await fs.symlink(groups[0].mainDirectory, alias.mainDirectory, 'junction');
        await coordinator.runDirectory(directories(), async () => {
            assert.strictEqual(await coordinator.runFile(alias, async () => assert.fail('Alias must be paused')), undefined);
        });
    });

    test('saves through unconfigured aliases are checked before publication', async () => {
        await fs.mkdir(groups[0].secondaryDirectory);
        const alias = path.join(directory, 'alias');
        await fs.symlink(groups[0].secondaryDirectory, alias, 'junction');
        await coordinator.runDirectory(directories(), async (activity) => {
            coordinator.noteSave(path.join(alias, 'file.txt'));
            assert.strictEqual(coordinator.hasPendingSaves(activity), true);
            await coordinator.waitForSaves(activity);
            assert.strictEqual(coordinator.hasPendingSaves(activity), false);
            assert.strictEqual(activity.changed, true);
        });
    });
});
