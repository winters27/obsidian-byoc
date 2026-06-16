# Contributing to BYOC

Contributions are welcome. Bug reports, fixes, new provider support, documentation, and tests are all useful. There is no contributor license agreement to sign. By opening a pull request you agree that your contribution is licensed under the project's [MIT license](LICENSE).

## Reporting bugs and requesting features

Open an issue and include:

- Your operating system and Obsidian version
- The BYOC version (shown in Settings under Community plugins)
- The remote provider involved, and whether encryption (a password) is enabled
- Steps to reproduce, and what you expected versus what happened

Do not paste credentials, tokens, or other secrets into an issue.

## Development setup

```bash
git clone https://github.com/winters27/obsidian-byoc
cd obsidian-byoc
npm install
npm run build   # bundles main.js, manifest.json, styles.css into the repo root
npm test        # runs the test suite
```

`npm run build` also copies the three build outputs into a local Obsidian plugin folder if one is configured, so you can reload Obsidian (Ctrl/Cmd+R) and try your change against a real vault.

To test OAuth providers with your own credentials, copy `.env.example.txt` to `.env` and fill in the relevant `*_CLIENT_ID` / `*_CLIENT_SECRET` values before building.

## Project layout

- `src/sync/` — the 3-way merge engine. `planner.ts` decides push/pull/delete/conflict for each file, `syncer.ts` orders and executes those decisions, `conflict.ts` builds conflict copies.
- `src/fs*.ts` — one file system adapter per provider (for example `fsWebdav.ts`, `fsS3.ts`), all behind a common interface.
- `src/fsEncrypt.ts` — the encryption layer that wraps any provider with rclone-crypt or OpenSSL encryption.
- `src/settings*.ts` — the settings UI, with one panel per provider.
- `tests/` — the test suite, run with `npm test`.

## Pull requests

1. Fork the repository and create a branch off `master`.
2. Keep each pull request focused on one change.
3. Add or update tests when you change sync behavior. The decision matrix in `src/sync/planner.ts` is covered by `tests/syncPlanner.test.ts`; a sync logic change without a matching test is hard to review.
4. Run `npm test` and `npm run build` before pushing.
5. Describe the problem and the fix in the pull request, and link any related issue.

## Code style

Formatting is handled by Biome and linting by ESLint:

```bash
npm run format   # apply formatting
npm run lint     # check for lint issues
```

Match the style of the surrounding code rather than introducing new conventions.
