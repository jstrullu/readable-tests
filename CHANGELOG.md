# Changelog

All notable changes to this extension are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.1] — 2026-11-23

### Fixed

- .NET: large TRX reports failed with "Entity expansion limit exceeded: … > 1000" (XML parser security limit hit by ordinary `&lt;` / `&quot;` in messages, console output and stack traces).
- JavaScript: libraries copied into `wwwroot` (e.g. `wwwroot/lib/<package>`) or `dist` were detected as test projects. These folders are now excluded by default.
- "Run all" no longer fails on a JavaScript project whose dependencies are not installed: it is skipped and reported in the output, and marked "npm install required" in the tree.

### Changed

- README badges: Marketplace version and installs from vsmarketplacebadges.dev (shields.io retired them).
- Third-party notices are generated from the bundled dependencies at packaging time.

## [0.4.0] — 2026-11-22

First public release (preview).

### Added

- Dedicated test tree: Project › Class › Method › Case (.NET), Project › describe › test (JavaScript), with status, real elapsed time (parallel-aware) and one-line failure summaries.
- Failure details panel: assertion expression, expected/actual diff (character, line, whole value), mismatching member, `Assert.Multiple` support, inner exception chain, code excerpt, cleaned call stack, test output, raw message.
- Inline failure summary at the end of the assertion line, full message on hover.
- Microsoft.Testing.Platform support (TUnit, xUnit v3, MSTest/NUnit runners): direct launch of test binaries with TRX reporting, `--treenode-filter` / `--filter-class` / `--filter-method`.
- VSTest support (xUnit, NUnit, MSTest) through `dotnet test --no-build`.
- Fast runs: single build only when files changed, `--no-restore` when project files are unchanged, cached run commands, parallel projects, `launchSettings.json` environment variables, timing and build reason in the output.
- Run all, run project / class / method, rerun failures; filter by name, failures only.
- JavaScript support: Vitest (1–5), Jest (27+) and the Angular CLI (`@angular/build:unit-test`), through a reporter shipped with the extension (exact expected/actual values, stack traces, test locations, console output, files that fail to load).
- Run a single JavaScript test or `describe`, rerun failures, with only the selected tests updated.
- English and French UI.
