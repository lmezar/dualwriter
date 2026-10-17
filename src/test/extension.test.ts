import * as assert from 'assert';

import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('Extension activates and registers the sync command', async () => {
		const extension = vscode.extensions.getExtension('lmezar.dualwriter');
		assert.ok(extension, 'DualWriter should be available in the extension host');

		await extension.activate();
		assert.ok(extension.isActive);

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('dualwriter.syncFiles'));
	});
});
