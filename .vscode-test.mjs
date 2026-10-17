import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const workspaceFolder = fileURLToPath(new URL('./.vscode-test/workspace/', import.meta.url));
mkdirSync(workspaceFolder, { recursive: true });

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	mocha: { timeout: 10000 },
});
