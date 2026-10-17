# Change Log

## [2.0.0] - 2026-10-17

### Breaking changes
- Replaced the top-level directory pair and bidirectional setting with `dualwriter.groups`.
- Explicit legacy settings disable all synchronization and show an actionable error. No automatic migration or compatibility fallback is provided.

### Added
- Multiple independent directory pairs with optional names and per-group bidirectional sync.
- Validation of group settings, equal/nested/shared directories and symbolic-link aliases to prevent cross-group copies.
- Live configuration reload, workspace-relative paths and reverse sync from configured directories outside the workspace.
- Configuration, filesystem and extension-host tests for group isolation, manual/automatic sync, invalid settings and migration errors.
- Manual `dualwriter.syncDirectories` command to replace one selected group's entire secondary directory with its main directory, regardless of per-file bidirectional mode.
- Mandatory confirmation showing absolute paths and an additional warning for an empty source. No automatic trigger or default shortcut.
- Staged recursive copying, cancellation before publication, temporary backup and rollback on publication errors, with retained recovery paths when restoration or cleanup fails.
- Validation of missing sources, changed roots, unsafe links, unsaved documents and changes during preparation. Internal links are remapped into the destination tree.
- Per-group coordination that drains in-flight file copies and pauses new ones during replacement without blocking other groups.
- Filesystem, coordination and extension-host tests for complete replacement, deletion, cancellation, recovery, group isolation and manual-only execution.

### Changed
- Translated all extension messages, validation errors, confirmations, progress text and default group names to English. Custom group names remain unchanged.

## [1.1.1] - 2026-10-17

### Changed
- Migrated development tooling to pnpm with its own lockfile.
- Updated the compiler to TypeScript 7 and migrated ESLint to flat configuration.
- Updated dependencies, including security fixes for test tooling.
- Bundled runtime dependencies for packaging and publishing with pnpm.

## [1.1.0] - 2024-07-26

### Added
- Added bidirectional sync feature. Changes in either the main or secondary directory will now be reflected in the other directory when `dualwriter.enableBidirectionalSync` is enabled.
- New configuration option `dualwriter.enableBidirectionalSync` to enable or disable bidirectional synchronization.

## [1.0.0]

- Initial release
