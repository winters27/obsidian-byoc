<p align="center">
  <img src="assets/branding/256x256.png" alt="BYOC logo" width="200" />
</p>

<h1 align="center">Bring Your Own Cloud (BYOC)</h1>

<p align="center">
  <a href="https://bringyourowncloud.xyz"><strong>bringyourowncloud.xyz</strong></a><br><br>
  A clean, self-hosted synchronization plugin for <a href="https://obsidian.md">Obsidian</a>.
</p>

BYOC is a community-maintained fork of the excellent [Remotely Save](https://github.com/remotely-save/remotely-save) plugin. This version focuses on providing a clean, completely self-hosted experience while maintaining the robust sync engine created by the original developers.

---

## Features

- **12 cloud providers** — S3, WebDAV, Dropbox, OneDrive (AppFolder & Full), Google Drive, Box, pCloud, Yandex Disk, Koofr, Azure Blob Storage, Webdis
- **3-Way Merge Sync Engine** — tracks a local baseline to make correct push/pull/conflict decisions across sessions
- **Smart Conflict Resolution** — automatically creates timestamped conflict copies instead of silently overwriting
- **Independent Authorization** — connect your own cloud provider APIs with credentials that persist locally.
- **End-to-end encryption** — optional AES-256 / rclone-crypt encryption before data leaves your device
- **Auto-sync** — timed background sync and sync-on-save
- **Seamless migration** — automatically imports your existing Remotely Save config on first load

---

## Installation

### From the latest release (recommended)

1. Download `byoc.zip` from the [latest release](../../releases/latest).
2. Extract it into your vault's plugins folder so the files land at `<vault>/.obsidian/plugins/byoc/main.js` (alongside `manifest.json` and `styles.css`). The zip already contains a `byoc/` folder, so unzipping it directly into `.obsidian/plugins/` does the right thing.
3. In Obsidian, open **Settings → Community plugins**, click the refresh icon under "Installed plugins" if BYOC doesn't appear, and toggle **Bring Your Own Cloud** on.

If Community plugins is disabled (Restricted mode), turn it on first — Obsidian will warn you about third-party code, which is expected.

### Building from source

For developers who want to run a local build, or to use BYOC with their own OAuth client IDs:

```bash
git clone https://github.com/winters27/obsidian-byoc
cd obsidian-byoc
npm install
npm run build
```

The build emits `main.js`, `manifest.json`, and `styles.css` in the repo root. Copy those three files into `<vault>/.obsidian/plugins/byoc/` (create the folder if it doesn't exist), then reload Obsidian (Ctrl/Cmd+R) and enable the plugin under **Settings → Community plugins**.

To swap in your own OAuth credentials before building, copy `.env.example.txt` to `.env` and fill in the relevant `*_CLIENT_ID` / `*_CLIENT_SECRET` values — webpack's DefinePlugin bakes them into `main.js` at build time.

---

## Provider Setup

### S3-Compatible (AWS, Cloudflare R2, Backblaze B2, MinIO, etc.)

Enter your endpoint, region, access key ID, secret key, and bucket name in plugin settings.

### WebDAV

Enter your server URL, username, and password. Works with Nextcloud, ownCloud, Synology, and any WebDAV server.

### Dropbox / OneDrive / Google Drive / Box / Yandex Disk / Koofr

Click **Auth** in the provider settings panel. You'll be redirected to the provider's OAuth page, then back to Obsidian automatically.

### pCloud

Click **Auth** in pCloud settings. Select your region (US or EU) during the OAuth flow. Your access token is stored locally and never expires.

> **Note:** BYOC uses a registered pCloud application. If you have your own pCloud API key, you can override it by setting the `PCLOUD_CLIENT_ID` and `PCLOUD_CLIENT_SECRET` environment variables before building.

### Azure Blob Storage

Enter your container SAS URL and container name.

---

## Configuration

All settings are in Obsidian → Settings → **Bring Your Own Cloud**.

| Setting | Description |
|---------|-------------|
| **Service** | Which cloud provider to sync with |
| **Password** | Optional encryption passphrase |
| **Auto Sync Interval** | Sync every N milliseconds (−1 to disable) |
| **Sync on Save** | Sync N ms after the last file change |
| **Conflict Action** | `keep_newer`, `keep_larger`, or `smart_conflict` |
| **Protect Modify %** | Abort if more than N% of files would be changed |
| **Sync Config Dir** | Whether to sync `.obsidian/` settings |
| **Delete To** | Move deleted files to system trash or Obsidian trash |

---

## Migrating from Remotely Save

BYOC automatically detects your Remotely Save `data.json` on first launch and imports all credentials and settings. A backup of your current config is created at `.obsidian/plugins/byoc/data.json.byoc-backup` before any changes are made.

## Credits

BYOC is a fork of **Remotely Save**, originally created by [fyears](https://github.com/remotely-save). The core sync algorithm, multi-provider architecture, and foundational logic are the result of their exceptional work. 

We are incredibly grateful to the original developer for creating such a robust tool and making it open source. If you are looking for the original plugin, please visit the [Remotely Save Repository](https://github.com/remotely-save/remotely-save).

---

## License

[Apache 2.0](LICENSE) — inherited from the upstream Remotely Save project.
