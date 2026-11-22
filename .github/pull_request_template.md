## What and why

<!-- What does this change, and which problem does it solve? Link the issue: Fixes #123 -->

## How it was tested

<!-- Unit tests, manual run on which framework / OS, screenshots for UI changes -->

## Checklist

- [ ] `npm test` passes (it also fails on missing or orphan French translations)
- [ ] New user-facing strings go through `t('…')` with an entry in `l10n/bundle.l10n.fr.json` (manifest strings: `package.nls*.json`)
- [ ] `CHANGELOG.md` updated under the next version
- [ ] README updated if a setting, a supported framework or a limitation changed
- [ ] No confidential code or data in tests, fixtures or screenshots
