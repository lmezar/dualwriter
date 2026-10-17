import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseConfiguration, SyncGroup } from '../configuration';
import {
    DirectorySyncCancelled, DirectorySyncIO, DirectorySyncOptions, inspectDirectorySync, syncDirectory
} from '../directorySync';

suite('Complete directory replacement', () => {
    let directory: string;
    let groups: SyncGroup[];
    let source: string;
    let target: string;

    async function write(filePath: string, content: string | Buffer): Promise<void> {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
    }

    function operations(overrides: Partial<DirectorySyncIO> = {}): DirectorySyncIO {
        return {
            copyFile: fs.copyFile,
            rename: fs.rename,
            remove: (filePath) => fs.rm(filePath, { recursive: true, force: true }),
            ...overrides
        };
    }

    async function replace(options: DirectorySyncOptions = {}, overrides: Partial<DirectorySyncIO> = {}) {
        return syncDirectory(await inspectDirectorySync(groups, 0), options, operations(overrides));
    }

    async function assertOriginalDestination(): Promise<void> {
        assert.deepStrictEqual(await fs.readdir(target), ['old.txt']);
        assert.strictEqual(await fs.readFile(path.join(target, 'old.txt'), 'utf8'), 'previous');
    }

    async function assertNoTemporaryDirectories(): Promise<void> {
        assert.deepStrictEqual((await fs.readdir(directory)).filter((name) => name.startsWith('.dualwriter-')), []);
    }

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualwriter-directory-'));
        groups = parseConfiguration([
            { name: 'One', mainDirectory: 'main1', secondaryDirectory: 'copy1', bidirectionalSync: true },
            { name: 'Two', mainDirectory: 'main2', secondaryDirectory: 'copy2', bidirectionalSync: true }
        ], false, directory).groups;
        source = groups[0].mainDirectory;
        target = groups[0].secondaryDirectory;
        await fs.mkdir(source);
        await write(path.join(target, 'old.txt'), 'previous');
        await write(path.join(groups[1].mainDirectory, 'protected.txt'), 'other-main');
        await write(path.join(groups[1].secondaryDirectory, 'protected.txt'), 'other-copy');
    });

    teardown(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    test('mirrors the entire tree, removes destination-only files and never copies back or across groups', async () => {
        await write(path.join(source, 'src', 'nested', 'file.txt'), 'new');
        await write(path.join(source, '.hidden'), 'hidden');
        await write(path.join(source, '.gitignore'), 'ignored.txt');
        await write(path.join(source, 'ignored.txt'), 'included');
        await write(path.join(source, 'binary.bin'), Buffer.from([0, 255, 1, 128]));
        await fs.mkdir(path.join(source, 'empty'));
        await write(path.join(source, 'file-to-directory', 'child.txt'), 'child');
        await write(path.join(target, 'file-to-directory'), 'old file');
        await write(path.join(source, 'directory-to-file'), 'new file');
        await write(path.join(target, 'directory-to-file', 'old.txt'), 'old child');
        await write(path.join(target, 'src', 'nested', 'file.txt'), 'old');

        const result = await replace();
        assert.strictEqual(result.groupName, 'One');
        assert.strictEqual(await fs.readFile(path.join(target, 'src', 'nested', 'file.txt'), 'utf8'), 'new');
        assert.strictEqual(await fs.readFile(path.join(target, '.hidden'), 'utf8'), 'hidden');
        assert.strictEqual(await fs.readFile(path.join(target, 'ignored.txt'), 'utf8'), 'included');
        assert.deepStrictEqual(await fs.readFile(path.join(target, 'binary.bin')), Buffer.from([0, 255, 1, 128]));
        assert.deepStrictEqual(await fs.readdir(path.join(target, 'empty')), []);
        assert.strictEqual(await fs.readFile(path.join(target, 'file-to-directory', 'child.txt'), 'utf8'), 'child');
        assert.strictEqual(await fs.readFile(path.join(target, 'directory-to-file'), 'utf8'), 'new file');
        await assert.rejects(fs.stat(path.join(target, 'old.txt')), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(source, 'old.txt')), { code: 'ENOENT' });
        assert.strictEqual(await fs.readFile(path.join(groups[1].mainDirectory, 'protected.txt'), 'utf8'), 'other-main');
        assert.strictEqual(await fs.readFile(path.join(groups[1].secondaryDirectory, 'protected.txt'), 'utf8'), 'other-copy');
        await assertNoTemporaryDirectories();
    });

    test('creates a missing destination and missing parent directories without nesting the source name', async () => {
        groups[0].secondaryDirectory = path.join(directory, 'not-created', 'nested', 'destination');
        await write(path.join(source, 'file.txt'), 'new');
        await replace();
        assert.deepStrictEqual(await fs.readdir(groups[0].secondaryDirectory), ['file.txt']);
    });

    test('an existing empty source intentionally produces an empty destination', async () => {
        const plan = await inspectDirectorySync(groups, 0);
        assert.strictEqual(plan.empty, true);
        await syncDirectory(plan);
        assert.deepStrictEqual(await fs.readdir(target), []);
        await assertNoTemporaryDirectories();
    });

    test('a missing source must never be treated as an empty source', async () => {
        await fs.rmdir(source);
        await assert.rejects(inspectDirectorySync(groups, 0), /origen no existe/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('rejects non-directory roots and invalid group indices before changing data', async () => {
        await fs.rmdir(source);
        await fs.writeFile(source, 'not a directory');
        await assert.rejects(inspectDirectorySync(groups, 0), /no es un directorio/);
        await assertOriginalDestination();
        await assert.rejects(inspectDirectorySync(groups, -1), /grupo seleccionado/);
    });

    test('rejects overlapping roots and disk-root destinations', async () => {
        groups[0].secondaryDirectory = source;
        await assert.rejects(inspectDirectorySync(groups, 0), /solapan/);
        groups[0].secondaryDirectory = path.parse(directory).root;
        await assert.rejects(inspectDirectorySync(groups, 0), /solapan|raíz/);
        await assertOriginalDestination();
    });

    test('a copy/read error leaves the original destination intact and removes staging', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({}, {
            copyFile: async () => { throw new Error('read failed'); }
        }), /read failed/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('failure to move the previous destination does not delete it', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({}, {
            rename: async () => { throw new Error('destination busy'); }
        }), /destination busy/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('failure to publish the prepared tree restores the previous destination', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        let cancelled = false;
        await assert.rejects(replace({ isCancellationRequested: () => cancelled }, {
            rename: async (from, to) => {
                if (path.basename(from) === 'staged') {
                    throw new Error('publish failed');
                }
                await fs.rename(from, to);
                cancelled = true;
            }
        }), /publish failed/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('a failed restore keeps the backup and reports its location instead of deleting it', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({}, {
            rename: async (from, to) => {
                if (from !== target) {
                    throw new Error('publish or restore failed');
                }
                await fs.rename(from, to);
            }
        }), /El respaldo se conserva en/);
        const temporary = (await fs.readdir(directory)).find((name) => name.startsWith('.dualwriter-'));
        assert.ok(temporary);
        assert.strictEqual(await fs.readFile(path.join(directory, temporary, 'previous', 'old.txt'), 'utf8'), 'previous');
        assert.strictEqual(await fs.readFile(path.join(source, 'file.txt'), 'utf8'), 'new');
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    });

    test('cleanup failure after success keeps the old backup and reports success with its path', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        const result = await replace({}, { remove: async () => { throw new Error('cleanup failed'); } });
        assert.ok(result.retainedPath);
        assert.strictEqual(await fs.readFile(path.join(result.retainedPath, 'previous', 'old.txt'), 'utf8'), 'previous');
        assert.strictEqual(await fs.readFile(path.join(target, 'file.txt'), 'utf8'), 'new');
    });

    test('cleanup failure before publication reports the temporary path without losing the old destination', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({}, {
            copyFile: async () => { throw new Error('copy failed'); },
            remove: async () => { throw new Error('cleanup failed'); }
        }), /copy failed.*No se pudo eliminar el temporal/);
        await assertOriginalDestination();
        assert.ok((await fs.readdir(directory)).some((name) => name.startsWith('.dualwriter-')));
    });

    test('cancellation before starting or during preparation never clears the destination', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({ isCancellationRequested: () => true }), DirectorySyncCancelled);
        let cancelled = false;
        await assert.rejects(replace({
            isCancellationRequested: () => cancelled,
            onProgress: () => { cancelled = true; }
        }), DirectorySyncCancelled);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('once publication starts, cancellation cannot interrupt replacement or recovery', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        let cancelled = false;
        await replace({
            isCancellationRequested: () => cancelled,
            onProgress: (message) => { cancelled = message.startsWith('Reemplazando'); }
        });
        assert.strictEqual(await fs.readFile(path.join(target, 'file.txt'), 'utf8'), 'new');
        await assertNoTemporaryDirectories();
    });

    test('rejects source links into another group without reading them into the destination', async () => {
        await fs.symlink(groups[1].mainDirectory, path.join(source, 'external'), 'junction');
        await assert.rejects(replace(), /enlace simbólico sale del origen/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('internal relative and absolute links point to the copied tree, never back to the source', async () => {
        await write(path.join(source, 'nested', 'file.txt'), 'new');
        await fs.symlink('nested', path.join(source, 'relative'), 'dir');
        await fs.symlink(path.join(source, 'nested'), path.join(source, 'absolute'), 'junction');
        await fs.symlink(path.join(source, 'nested', 'file.txt'), path.join(source, 'file-link'), 'file');
        await replace();
        for (const name of ['relative', 'absolute']) {
            assert.strictEqual(await fs.realpath(path.join(target, name)), path.join(target, 'nested'));
        }
        assert.strictEqual(await fs.realpath(path.join(target, 'file-link')), path.join(target, 'nested', 'file.txt'));
        await fs.writeFile(path.join(target, 'file-link'), 'destination-only');
        assert.strictEqual(await fs.readFile(path.join(source, 'nested', 'file.txt'), 'utf8'), 'new');
    });

    test('preserves safe dangling internal links but rejects dangling links outside the source', async () => {
        await fs.symlink('not-created.txt', path.join(source, 'internal'), 'file');
        await replace();
        assert.strictEqual(await fs.readlink(path.join(target, 'internal')), 'not-created.txt');
        await fs.symlink(path.join(groups[1].mainDirectory, 'not-created.txt'), path.join(source, 'external'), 'file');
        await assert.rejects(replace(), /enlace simbólico sale del origen/);
        assert.strictEqual(await fs.readlink(path.join(target, 'internal')), 'not-created.txt');
    });

    test('cyclic links fail without deleting the destination', async () => {
        await fs.symlink('second', path.join(source, 'first'), 'file');
        await fs.symlink('first', path.join(source, 'second'), 'file');
        await assert.rejects(replace(), { code: 'ELOOP' });
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('deleting old destination links does not delete their external targets', async () => {
        await fs.symlink(groups[1].mainDirectory, path.join(target, 'old-link'), 'junction');
        await write(path.join(source, 'file.txt'), 'new');
        await replace();
        assert.strictEqual(await fs.readFile(path.join(groups[1].mainDirectory, 'protected.txt'), 'utf8'), 'other-main');
        await assert.rejects(fs.lstat(path.join(target, 'old-link')), { code: 'ENOENT' });
    });

    test('distinct root aliases remain links while their physical destination is replaced', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        groups[0].mainDirectory = path.join(directory, 'source-alias');
        groups[0].secondaryDirectory = path.join(directory, 'target-alias');
        await fs.symlink(source, groups[0].mainDirectory, 'junction');
        await fs.symlink(target, groups[0].secondaryDirectory, 'junction');
        await replace();
        assert.strictEqual((await fs.lstat(groups[0].secondaryDirectory)).isSymbolicLink(), true);
        assert.strictEqual(await fs.readFile(path.join(groups[0].secondaryDirectory, 'file.txt'), 'utf8'), 'new');
    });

    test('a destination replaced since confirmation is not overwritten', async () => {
        const plan = await inspectDirectorySync(groups, 0);
        await fs.rename(target, path.join(directory, 'moved-destination'));
        await write(path.join(target, 'unconfirmed.txt'), 'protected');
        await assert.rejects(syncDirectory(plan), /han cambiado desde la confirmación/);
        assert.strictEqual(await fs.readFile(path.join(target, 'unconfirmed.txt'), 'utf8'), 'protected');
        await assertNoTemporaryDirectories();
    });

    test('a retargeted root alias is revalidated before publication', async () => {
        groups[0].secondaryDirectory = path.join(directory, 'target-alias');
        await fs.symlink(target, groups[0].secondaryDirectory, 'junction');
        const plan = await inspectDirectorySync(groups, 0);
        await fs.unlink(groups[0].secondaryDirectory);
        await fs.symlink(groups[1].mainDirectory, groups[0].secondaryDirectory, 'junction');
        await assert.rejects(syncDirectory(plan), /solapan/);
        await assertOriginalDestination();
        assert.strictEqual(await fs.readFile(path.join(groups[1].mainDirectory, 'protected.txt'), 'utf8'), 'other-main');
    });

    test('root links retargeted during preparation are rejected before either destination is moved', async () => {
        groups[0].secondaryDirectory = path.join(directory, 'target-alias');
        await fs.symlink(target, groups[0].secondaryDirectory, 'junction');
        await assert.rejects(replace({ beforeCommit: async () => {
            await fs.unlink(groups[0].secondaryDirectory);
            await fs.symlink(groups[1].mainDirectory, groups[0].secondaryDirectory, 'junction');
        } }), /solapan/);
        await assertOriginalDestination();
        assert.strictEqual(await fs.readFile(path.join(groups[1].mainDirectory, 'protected.txt'), 'utf8'), 'other-main');
        await assertNoTemporaryDirectories();
    });

    test('source writes during preparation invalidate the copy', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({}, {
            copyFile: async (from, to) => {
                await fs.copyFile(from, to);
                await fs.appendFile(from, '-changed');
            }
        }), /origen cambió durante la copia/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('a configuration or editor guard failure aborts before replacement', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({ beforeCommit: () => { throw new Error('settings changed'); } }), /settings changed/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('source changes during asynchronous pre-publication guards are still detected', async () => {
        const filePath = path.join(source, 'file.txt');
        await write(filePath, 'new');
        await assert.rejects(replace({ beforeCommit: () => fs.appendFile(filePath, '-changed') }), /origen cambió durante la copia/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });

    test('the final synchronous guard can veto publication after filesystem validation', async () => {
        await write(path.join(source, 'file.txt'), 'new');
        await assert.rejects(replace({ assertCanCommit: () => { throw new Error('late editor change'); } }), /late editor change/);
        await assertOriginalDestination();
        await assertNoTemporaryDirectories();
    });
});
