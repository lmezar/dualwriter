# DualWriter

At work I ran into the problem of having the project divided into a custom library and the main application. When making changes in the library I had to go to the main application to paste the changes to test them, with the danger of leaving something out and not knowing where the error came from.

Tedious, isn't it? So I got tired and I started to make my first extension for VSCode.

In a nutshell, it replicates changes made in one directory to another.

## Extension Settings

Before using it, make sure you set it up! No hot-swapping.

* `dualwriter.enableAutoSave`: Enable/disable the autosave feature.
* `dualwriter.mainDirectory`: The main directory where you will write your changes.
* `dualwriter.secondaryDirectory`: The secondary directory where the extension will write for you.
* `dualwriter.bidirectionalSync`: Enable/disable bidirectional sync between main and secondary directories.

## How to use

- **Visual command name**: Sync Files
- **Shortcut:** Windows: Ctrl+Alt+F | Mac: CMD+Alt+F
- **Autosave:** Everyone loves this (even if it can be a little bit dangerous...) but you need to enable this at your settings.json

## Known Issues

1. Now there is no error control, only if main and secondary directory are the same.
2. If the target directory is not the one you want, even if it does not have a similar structure, it will create the necessary folders without warning. Choose right.

## Package and install locally

```sh
pnpm install --frozen-lockfile
pnpm run package
code --install-extension ./dualwriter-1.1.1.vsix
```

Packaging compiles with TypeScript 7 and then bundles the extension and its runtime
dependencies with esbuild. VS Code's API remains external, as it is provided by the
extension host. Development with F5 still uses `pnpm run watch`.

The `vsce.dependencies` setting disables npm-based dependency detection, which
does not support pnpm's isolated dependency layout. Runtime dependencies are
included in the bundle; `node_modules` and tests are excluded from the VSIX.
Bundled dependency licenses are included in `THIRD_PARTY_NOTICES.md`.

To publish the version already set in `package.json`, run `pnpm exec vsce publish`
without `patch`, `minor`, or `major`. VSCE still invokes npm internally to run the
`vscode:prepublish` hook, which delegates the actual build to pnpm.

## Release Notes

### 1.0.0

Initial release of DualWriter for use at work, I'm tired of copy/pasting!

### 1.1.0

Bidirectional sync added

### 1.1.1

Update dependencies

© [2024] lmezar
