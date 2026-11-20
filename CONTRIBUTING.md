# Contributing

```bash
npm install
npm test          # unit tests (TRX/message parsing, diff, filters, detection, build tracker, translations)
npm run package   # builds the .vsix
```

Press **F5** in VS Code to start an Extension Development Host.

- User-facing strings go through `t('English message {0}', arg)` (`src/i18n.ts`) and need a French entry in `l10n/bundle.l10n.fr.json`; manifest strings live in `package.nls.json` / `package.nls.fr.json`. `npm test` fails on any missing or orphan translation.
- Releases: bump `version` in `package.json`, add a `CHANGELOG.md` entry, then push a `vX.Y.Z` tag. The `Release` workflow publishes to the VS Code Marketplace and Open VSX.
