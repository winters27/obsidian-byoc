# Migrating from Remotely Save to Obsidian BYOC

This guide covers what changes when you switch from the upstream [remotely-save](https://github.com/remotely-save/remotely-save) plugin to Obsidian BYOC.

## TL;DR

1. Disable Remotely Save.
2. Install BYOC.
3. Re-enter your provider credentials in BYOC settings.
4. Run one sync and verify.

## Plugin ID change

| | Remotely Save | BYOC |
|---|---|---|
| Plugin ID | `remotely-save` | `obsidian-byoc` |
| Settings file | `.obsidian/plugins/remotely-save/data.json` | `.obsidian/plugins/obsidian-byoc/data.json` |

Because the plugin ID is different, Obsidian treats these as completely separate plugins. **Settings are not migrated automatically.** You will need to re-enter your configuration.

## Step-by-step migration

### 1. Note your current settings

Before disabling Remotely Save, open its settings and note:

- Which provider you are using
- Your remote folder / prefix setting
- Your encryption password (if any)
- Any skip-paths or skip-large-files settings
- Your conflict resolution strategy

### 2. Disable Remotely Save

In Obsidian → Settings → Community plugins, toggle off Remotely Save. **Do not uninstall it yet** in case you need to reference settings.

### 3. Install BYOC

Install via BRAT or manually (see [README](../README.md#installation)).

### 4. Re-enter your settings in BYOC

Open BYOC settings and configure the same provider with the same credentials and folder settings you noted in step 1.

**Important:** Use the same remote folder / prefix as before. If you change it, BYOC will treat the remote as empty and re-upload everything.

### 5. Re-enter your encryption password

If you used end-to-end encryption, enter the **exact same password** in BYOC. The encrypted files on the remote are in the same format (openssl / rclone crypt), so the same password will decrypt them.

If you enter a different password (or no password), BYOC will be unable to read the encrypted files and may overwrite them.

### 6. Run a test sync

Trigger a manual sync. On the first run, BYOC has no previous sync history, so it will treat all remote files as "created remotely" and download them. This is safe and expected.

### 7. Verify

Check that your vault files look correct. If everything looks good, you can uninstall Remotely Save.

## PRO features

If you were using Remotely Save PRO features (Google Drive, Box, pCloud, Yandex Disk, Koofr, Azure Blob Storage, OneDrive Full), those are fully unlocked in BYOC with no subscription required.

Re-authorize each provider in BYOC settings — your existing data on the remote is untouched.

## Sync history / prevSync database

Remotely Save stores sync history in a local SQLite database (`.obsidian/plugins/remotely-save/remotely-save.db`). BYOC uses a separate database at `.obsidian/plugins/obsidian-byoc/remotely-save.db`.

On the first sync after migration, BYOC has no prior sync history. It will:

- Download any remote-only files (treat them as "remote created")
- Upload any local-only files (treat them as "local created")
- Files present on both sides with the same content will sync without conflict

This is safe behavior — it essentially re-establishes the baseline. After the first sync, future incremental syncs will use the 3-way merge algorithm correctly.

## Rolling back

If you want to go back to Remotely Save:

1. Disable BYOC.
2. Re-enable Remotely Save.
3. Your remote files are unchanged — Remotely Save's database is also unchanged.
