# DualWriter

At work I ran into the problem of having the project divided into a custom library and the main application. When making changes in the library I had to go to the main application to paste the changes to test them, with the danger of leaving something out and not knowing where the error came from.

Tedious, isn't it? So I got tired and I started to make my first extension for VSCode.

In a nutshell, it copies the active or saved file between independent pairs of
directories. Each pair is a group: files never sync to another group's directories.

## Extension Settings

Configure DualWriter in your user or workspace settings. Changes take effect
without restarting VS Code.

* `dualwriter.enableAutoSave`: Copy files when saving. Defaults to `false` and applies to all groups.
* `dualwriter.groups`: Independent directory pairs. Defaults to `[]` (no synchronization).
  * `name`: Optional label used in messages.
  * `mainDirectory`: Required main directory.
  * `secondaryDirectory`: Required destination for this group only.
  * `bidirectionalSync`: Also copy from this group's secondary directory to its main directory. Defaults to `false`.

```json
{
  "dualwriter.enableAutoSave": true,
  "dualwriter.groups": [
    {
      "name": "Library",
      "mainDirectory": "./main1",
      "secondaryDirectory": "./copy1",
      "bidirectionalSync": true
    },
    {
      "name": "Application",
      "mainDirectory": "./main2",
      "secondaryDirectory": "./copy2",
      "bidirectionalSync": false
    }
  ]
}
```

Here, `main1 ↔ copy1` and `main2 → copy2`. Neither group can write to the other.
Relative file paths are preserved: `main1/src/example.ts` copies to
`copy1/src/example.ts`.

In a single-folder workspace, relative directory paths use that folder as their
base. In a multi-root workspace, they use the directory containing the saved
`.code-workspace` file. Use absolute paths in an untitled multi-root workspace or
an empty window. Absolute destinations can be outside the workspace; their files
can also sync back when that group is bidirectional. Configure groups at user or
workspace level, not separately in each workspace folder.

### Migrating from 1.x — breaking change

Version 2 does **not** support or automatically migrate the old configuration.
Remove these top-level settings from **all** user, workspace and workspace-folder
settings, and replace them with `dualwriter.groups` as shown above:

* `dualwriter.mainDirectory`
* `dualwriter.secondaryDirectory`
* `dualwriter.bidirectionalSync` (now belongs inside each group)

If any old setting is explicitly present (even `bidirectionalSync: false`), all
synchronization is disabled and an error offers to open the settings. This also
applies when valid new groups are present. Correcting the settings re-enables
synchronization without restarting; the error is not repeated on every save.

## How to use

- **Visual command name**: Sync Files
- **Shortcut:** Windows: Ctrl+Alt+F | Mac: CMD+Alt+F
- **Autosave:** Everyone loves this (even if it can be a little bit dangerous...) but you need to enable this at your settings.json

Only the active file (manual command) or saved file (automatic mode) is copied.
The manual command copies the version on disk, so save your edits first. Files
outside configured groups are ignored. Whole directories, deletions and renames
are not synchronized. With no groups, the manual command offers to configure them;
automatic mode stays inactive without an error.

## Validation and limitations

* Directories must be distinct and must not contain one another, within a group or
  across groups. Shared directories and symbolic-link aliases are rejected.
* A symbolic link inside a group cannot redirect a copied file outside that group's
  source or destination directory.
* Invalid settings disable all synchronization until corrected. There is no
  fallback to a previous configuration or to the 1.x format.
* Destination subdirectories are created as needed, and existing destination files
  are overwritten. Choose your directories carefully; there is no conflict merge.

## Tests

```sh
pnpm test
```

This compiles, lints and runs configuration, filesystem and extension-host tests in
an isolated workspace under `.vscode-test/`. A graphical display is required for
VS Code; on headless Linux, use `xvfb-run -a pnpm test` when available.

## Package and install locally

```sh
pnpm install --frozen-lockfile
pnpm run package
code --install-extension ./dualwriter-2.0.0.vsix
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

### 2.0.0

Independent directory groups with per-group bidirectional sync, strict isolation
and validation. The 1.x configuration is no longer supported; see the migration
instructions above.

### 1.0.0

Initial release of DualWriter for use at work, I'm tired of copy/pasting!

### 1.1.0

Bidirectional sync added

### 1.1.1

Update dependencies

© [2024] lmezar
