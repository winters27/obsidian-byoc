# Bring Your Own Cloud (BYOC)

> A clean, self-hosted synchronization plugin for [Obsidian](https://obsidian.md).

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

### Manual (Recommended)

1. Download the [latest release](../../releases/latest) — grab `main.js`, `manifest.json`, and `styles.css`
2. Copy them into your vault at `.obsidian/plugins/obsidian-byoc/`
3. In Obsidian → Settings → Community Plugins, enable **Bring Your Own Cloud**

### From Source

```bash
git clone https://github.com/obsidian-byoc/obsidian-byoc
cd obsidian-byoc
npm install
npm run build
# Copy main.js + manifest.json to your vault's .obsidian/plugins/obsidian-byoc/
```

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

BYOC automatically detects your Remotely Save `data.json` on first launch and imports all credentials and settings. A backup of your current config is created at `.obsidian/plugins/obsidian-byoc/data.json.byoc-backup` before any changes are made.

## Credits

BYOC is a fork of **Remotely Save**, originally created by [fyears](https://github.com/remotely-save). The core sync algorithm, multi-provider architecture, and foundational logic are the result of their exceptional work. 

We are incredibly grateful to the original developer for creating such a robust tool and making it open source. If you are looking for the original plugin, please visit the [Remotely Save Repository](https://github.com/remotely-save/remotely-save).

---

## License

[Apache 2.0](LICENSE) — inherited from the upstream Remotely Save project.
