# Change Log

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
