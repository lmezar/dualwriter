import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseConfiguration, SyncGroup } from '../configuration';
import { syncFile, validateGroupPaths } from '../sync';

suite('Isolated file synchronization', () => {
    let directory: string;
    let groups: SyncGroup[];

    async function write(filePath: string, content: string): Promise<void> {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
    }

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualwriter-sync-'));
        groups = parseConfiguration([
            { name: 'One', mainDirectory: 'main1', secondaryDirectory: 'copy1', bidirectionalSync: true },
            { name: 'Two', mainDirectory: 'main2', secondaryDirectory: 'copy2', bidirectionalSync: true }
        ], false, directory).groups;
    });

    teardown(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    test('copies in both directions within each group without touching the other group', async () => {
        for (let index = 0; index < groups.length; index++) {
            const group = groups[index];
            const other = groups[1 - index];
            for (const reverse of [false, true]) {
                const source = reverse ? group.secondaryDirectory : group.mainDirectory;
                const target = reverse ? group.mainDirectory : group.secondaryDirectory;
                const relativePath = path.join('src', 'nested', 'example.ts');
                const content = `${group.name}-${reverse}`;
                await write(path.join(source, relativePath), content);
                await write(path.join(other.mainDirectory, relativePath), 'other-main');
                await write(path.join(other.secondaryDirectory, relativePath), 'other-copy');

                const result = await syncFile(path.join(source, relativePath), groups);
                assert.deepStrictEqual(result, { groupName: group.name, targetPath: path.join(target, relativePath) });
                assert.strictEqual(await fs.readFile(path.join(target, relativePath), 'utf8'), content);
                assert.strictEqual(await fs.readFile(path.join(other.mainDirectory, relativePath), 'utf8'), 'other-main');
                assert.strictEqual(await fs.readFile(path.join(other.secondaryDirectory, relativePath), 'utf8'), 'other-copy');
            }
        }
    });

    test('one-way sync is per group and does not disable the other group reverse direction', async () => {
        groups[1].bidirectionalSync = false;
        const main = path.join(groups[1].mainDirectory, 'file.txt');
        const copy = path.join(groups[1].secondaryDirectory, 'file.txt');
        await write(main, 'main');
        await write(copy, 'secondary');
        assert.strictEqual(await syncFile(copy, groups), undefined);
        assert.strictEqual(await fs.readFile(main, 'utf8'), 'main');

        await syncFile(main, groups);
        assert.strictEqual(await fs.readFile(copy, 'utf8'), 'main');

        const reverseSource = path.join(groups[0].secondaryDirectory, 'file.txt');
        await write(reverseSource, 'reverse');
        await syncFile(reverseSource, groups);
        assert.strictEqual(await fs.readFile(path.join(groups[0].mainDirectory, 'file.txt'), 'utf8'), 'reverse');
    });

    test('ignores unrelated files and similarly prefixed sibling directories', async () => {
        for (const filePath of [path.join(directory, 'other.txt'), path.join(directory, 'main1-other', 'file.txt')]) {
            await write(filePath, 'unrelated');
            assert.strictEqual(await syncFile(filePath, groups), undefined);
        }
        await assert.rejects(fs.stat(groups[0].secondaryDirectory), { code: 'ENOENT' });
        assert.strictEqual(await syncFile(path.join(directory, 'other.txt'), []), undefined);
    });

    test('copies only the selected file, including filenames beginning with two dots', async () => {
        const filePath = path.join(groups[0].mainDirectory, '..local.ts');
        await write(filePath, 'selected');
        await write(path.join(groups[0].mainDirectory, 'sibling.ts'), 'not-selected');
        await syncFile(filePath, groups);
        assert.strictEqual(await fs.readFile(path.join(groups[0].secondaryDirectory, '..local.ts'), 'utf8'), 'selected');
        await assert.rejects(fs.stat(path.join(groups[0].secondaryDirectory, 'sibling.ts')), { code: 'ENOENT' });
    });

    test('allows directories that have not been created yet', async () => {
        assert.strictEqual((await validateGroupPaths(groups)).length, 2);
    });

    test('reports missing source files and invalid directory paths', async () => {
        await assert.rejects(syncFile(path.join(groups[0].mainDirectory, 'missing.txt'), groups), { code: 'ENOENT' });
        await write(groups[0].secondaryDirectory, 'not a directory');
        await assert.rejects(validateGroupPaths(groups), /no es un directorio/);
    });

    test('rejects root aliases, including aliases with nonexistent descendants', async () => {
        await fs.mkdir(groups[0].mainDirectory);
        await fs.symlink(groups[0].mainDirectory, groups[1].secondaryDirectory, 'junction');
        await assert.rejects(validateGroupPaths(groups), /solapan/);
        groups[1].secondaryDirectory = path.join(groups[1].secondaryDirectory, 'not-created');
        await assert.rejects(validateGroupPaths(groups), /solapan/);
    });

    test('does not follow a source link into another group', async () => {
        await write(path.join(groups[1].mainDirectory, 'file.txt'), 'other-group');
        await fs.mkdir(groups[0].mainDirectory);
        const link = path.join(groups[0].mainDirectory, 'linked');
        await fs.symlink(groups[1].mainDirectory, link, 'junction');
        await assert.rejects(syncFile(path.join(link, 'file.txt'), groups), /enlace simbólico/);
        await assert.rejects(fs.stat(groups[0].secondaryDirectory), { code: 'ENOENT' });
        await assert.rejects(fs.stat(groups[1].secondaryDirectory), { code: 'ENOENT' });
    });

    test('does not write through a destination link into another group', async () => {
        const filePath = path.join(groups[0].mainDirectory, 'linked', 'file.txt');
        await write(filePath, 'selected');
        await write(path.join(groups[1].mainDirectory, 'file.txt'), 'protected');
        await fs.mkdir(groups[0].secondaryDirectory);
        await fs.symlink(groups[1].mainDirectory, path.join(groups[0].secondaryDirectory, 'linked'), 'junction');
        await assert.rejects(syncFile(filePath, groups), /enlace simbólico/);
        assert.strictEqual(await fs.readFile(path.join(groups[1].mainDirectory, 'file.txt'), 'utf8'), 'protected');
    });

    test('rejects dangling destination file links pointing outside the group', async () => {
        const filePath = path.join(groups[0].mainDirectory, 'file.txt');
        const outsideFile = path.join(groups[1].mainDirectory, 'not-created.txt');
        await write(filePath, 'selected');
        await fs.mkdir(groups[0].secondaryDirectory);
        await fs.mkdir(groups[1].mainDirectory);
        await fs.symlink(outsideFile, path.join(groups[0].secondaryDirectory, 'file.txt'), 'file');
        await assert.rejects(syncFile(filePath, groups), /enlace simbólico/);
        await assert.rejects(fs.stat(outsideFile), { code: 'ENOENT' });
    });

    test('revalidates root links that change after configuration loading', async () => {
        const filePath = path.join(groups[0].mainDirectory, 'file.txt');
        await write(filePath, 'selected');
        await validateGroupPaths(groups);
        await fs.symlink(groups[0].mainDirectory, groups[1].secondaryDirectory, 'junction');
        await assert.rejects(syncFile(filePath, groups), /solapan/);
        await assert.rejects(fs.stat(groups[0].secondaryDirectory), { code: 'ENOENT' });
    });
});
