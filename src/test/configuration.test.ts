import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { containsPath, hasExplicitValue, parseConfiguration } from '../configuration';

suite('Group configuration', () => {
    const baseDirectory = path.join(os.tmpdir(), 'dualwriter-configuration');
    const pair = { mainDirectory: './main', secondaryDirectory: './copy' };

    test('resolves relative paths from the workspace and defaults each group to one-way sync', () => {
        const configuration = parseConfiguration([pair], true, baseDirectory);
        assert.deepStrictEqual(configuration, {
            enableAutoSave: true,
            groups: [{
                name: 'Grupo 1',
                mainDirectory: path.join(baseDirectory, 'main'),
                secondaryDirectory: path.join(baseDirectory, 'copy'),
                bidirectionalSync: false
            }]
        });
    });

    test('supports independent bidirectional settings and optional names', () => {
        const { groups } = parseConfiguration([
            { ...pair, name: 'Library', bidirectionalSync: true },
            { mainDirectory: './main2', secondaryDirectory: './copy2', bidirectionalSync: false }
        ], false, baseDirectory);
        assert.strictEqual(groups[0].name, 'Library');
        assert.strictEqual(groups[0].bidirectionalSync, true);
        assert.strictEqual(groups[1].bidirectionalSync, false);
    });

    test('accepts an empty list as an unconfigured, inactive extension', () => {
        assert.deepStrictEqual(parseConfiguration([], false), { groups: [], enableAutoSave: false });
    });

    test('accepts absolute paths without an open workspace', () => {
        const { groups } = parseConfiguration([{
            mainDirectory: path.join(baseDirectory, 'main'),
            secondaryDirectory: path.join(baseDirectory, 'copy')
        }], false);
        assert.strictEqual(groups.length, 1);
    });

    test('rejects relative paths without an unambiguous workspace base', () => {
        assert.throws(() => parseConfiguration([pair], false), /ruta absoluta/);
    });

    test('rejects malformed groups instead of silently ignoring them', () => {
        for (const groups of [null, {}, 'main', [null], [[]], [false], [{}], [pair, null]]) {
            assert.throws(() => parseConfiguration(groups, false, baseDirectory));
        }
        for (const value of ['', '   ', 4, null, 'main\0invalid']) {
            assert.throws(() => parseConfiguration([{ ...pair, mainDirectory: value }], false, baseDirectory));
            assert.throws(() => parseConfiguration([{ ...pair, secondaryDirectory: value }], false, baseDirectory));
        }
        for (const value of ['', '   ', 4, null]) {
            assert.throws(() => parseConfiguration([{ ...pair, name: value }], false, baseDirectory));
        }
        assert.throws(() => parseConfiguration([{ ...pair, bidirectionalSync: 'true' }], false, baseDirectory));
        assert.throws(() => parseConfiguration([{ ...pair, enableBidirectionalSync: true }], false, baseDirectory), /no es una opción válida/);
        assert.throws(() => parseConfiguration([pair], 'true', baseDirectory), /enableAutoSave/);
    });

    test('rejects equal, normalized-equal and nested directories within a pair', () => {
        for (const secondaryDirectory of ['./main', './main/../main', './main/nested', '.']) {
            assert.throws(() => parseConfiguration([{ ...pair, secondaryDirectory }], false, baseDirectory), /solapan/);
        }
    });

    test('rejects shared and nested roots across groups, regardless of direction', () => {
        for (const sharedDirectory of ['./main', './copy', './main/nested', './copy/nested']) {
            assert.throws(() => parseConfiguration([
                pair,
                { mainDirectory: sharedDirectory, secondaryDirectory: './other-copy' }
            ], false, baseDirectory), /solapan/);
            assert.throws(() => parseConfiguration([
                pair,
                { mainDirectory: './other-main', secondaryDirectory: sharedDirectory }
            ], false, baseDirectory), /solapan/);
        }
    });

    test('uses path boundaries, not string prefixes or dot-dot filename prefixes', () => {
        const directory = path.join(baseDirectory, 'main');
        assert.strictEqual(containsPath(directory, directory), true);
        assert.strictEqual(containsPath(directory, path.join(directory, '..local.ts')), true);
        assert.strictEqual(containsPath(directory, path.join(baseDirectory, 'main-other', 'file.ts')), false);
        assert.strictEqual(containsPath(directory, path.join(baseDirectory, 'file.ts')), false);
    });

    test('only explicit legacy values are incompatible, including false, empty strings and null', () => {
        assert.strictEqual(hasExplicitValue(undefined), false);
        assert.strictEqual(hasExplicitValue({ defaultValue: false }), false);
        assert.strictEqual(hasExplicitValue({ defaultValue: './' }), false);
        assert.strictEqual(hasExplicitValue({ globalValue: false }), true);
        assert.strictEqual(hasExplicitValue({ workspaceValue: '' }), true);
        assert.strictEqual(hasExplicitValue({ workspaceFolderValue: null }), true);
    });
});
