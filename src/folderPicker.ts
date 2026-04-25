import { type App, Modal, Notice, Setting, setIcon } from "obsidian";
import type { FakeFs } from "./fsAll";
import { getClient } from "./fsGetter";

/**
 * Default folder name to suggest in the picker's create input.
 *
 * - If the user already has a configured remoteBaseDir, that wins (they're
 *   re-picking and the current value is the right starting point).
 * - Otherwise we prefix the vault name with "Obsidian - " so the folder is
 *   self-describing in their cloud's root listing. Multiple vaults from
 *   the same user cluster together alphabetically.
 * - Skip the prefix when the vault name already starts with "obsidian"
 *   (case-insensitive) — avoids "Obsidian - Obsidian Vault" etc.
 */
export function suggestedFolderName(app: App, currentValue?: string): string {
  const trimmed = currentValue?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  const vault = app.vault.getName();
  return /^obsidian/i.test(vault) ? vault : `Obsidian - ${vault}`;
}

/**
 * Render the current remote folder location as a styled breadcrumb in a
 * Setting's description area: `Provider › segment › leaf`.
 *
 * Splits on "/" so nested paths are forward-compatible with future tree
 * navigation. The final leaf gets the accent color so it reads as the
 * "current location" rather than just a label.
 */
export function renderFolderBreadcrumb(
  setting: Setting,
  providerLabel: string,
  currentFolder: string
): void {
  const breadcrumb = setting.descEl.createDiv({
    cls: "byoc-folder-breadcrumb",
  });
  breadcrumb.createSpan({
    cls: "byoc-folder-breadcrumb__root",
    text: providerLabel,
  });
  const segments = currentFolder.split("/").filter((s) => s.length > 0);
  for (const seg of segments) {
    breadcrumb.createSpan({ cls: "byoc-folder-breadcrumb__sep", text: "›" });
    breadcrumb.createSpan({ cls: "byoc-folder-breadcrumb__leaf", text: seg });
  }
}

/**
 * Single helper for opening the folder picker for any provider. Used by:
 *   1. Post-OAuth callbacks in main.ts (run after auth completes)
 *   2. Settings → Change folder buttons in each provider's settings panel
 *
 * Sets `awaitingFolderSelection` while the picker is open so sync triggers
 * bail out, then clears it on pick. Refreshes the settings tab on pick so
 * the breadcrumb display reflects the new folder immediately.
 *
 * `plugin: any` avoids a circular import on BYOCPlugin.
 */
export function openFolderPickerForProvider(opts: {
  app: App;
  plugin: any;
  providerKey: string;
  providerLabel: string;
}): void {
  const { app, plugin, providerKey, providerLabel } = opts;
  plugin.awaitingFolderSelection = true;
  const fs = getClient(plugin.settings, app.vault.getName(), () =>
    plugin.saveSettings()
  );
  const current = plugin.settings[providerKey]?.remoteBaseDir;
  new RemoteFolderPickerModal(
    app,
    fs,
    providerLabel,
    suggestedFolderName(app, current),
    async (folderName) => {
      plugin.settings[providerKey].remoteBaseDir = folderName;
      await plugin.saveSettings();
      plugin.awaitingFolderSelection = false;
      plugin.settingTab?.display();
      new Notice(`BYOC will sync to "${folderName}".`);
    }
  ).open();
}

/**
 * Post-OAuth folder picker. Opens immediately after a successful auth
 * exchange so the user can choose where their vault lives in their cloud
 * before the first sync runs. Without this, the plugin defaults
 * remoteBaseDir to the vault name — which usually points at an empty
 * folder, making the first sync plan look like "delete everything locally".
 *
 * The caller is responsible for blocking sync triggers while this modal
 * is open (see `BYOCPlugin.awaitingFolderSelection`).
 */
export class RemoteFolderPickerModal extends Modal {
  private busy = false;
  /** Folders at the cloud root, populated after listFoldersAtRoot resolves.
   *  Used by the Create & use button to detect when the typed name matches
   *  an existing folder — in that case we just pick the existing one
   *  instead of trying to create a duplicate. */
  private folders: string[] = [];

  constructor(
    app: App,
    private readonly fs: FakeFs,
    private readonly providerLabel: string,
    private readonly suggestedName: string,
    private readonly onPicked: (folderName: string) => void
  ) {
    super(app);
  }

  async onOpen() {
    this.titleEl.setText(`Choose ${this.providerLabel} folder`);
    this.modalEl.addClass("byoc-folder-picker");

    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("p", {
      cls: "byoc-folder-picker__desc",
      text: "Pick a folder in your cloud, or create a new one.",
    });

    // Create section first — keeps the input above the on-screen keyboard
    // on mobile. Visually this trades the "existing first" convention for
    // a layout that just works under iOS without scroll-into-view tricks.
    contentEl.createEl("div", {
      cls: "byoc-folder-picker__section-label",
      text: "Create new",
    });
    this.renderCreate(contentEl);

    contentEl.createEl("div", {
      cls: "byoc-folder-picker__section-label",
      text: "Existing folders",
    });

    const listWrap = contentEl.createDiv({ cls: "byoc-folder-picker__list" });
    this.renderLoading(listWrap);

    try {
      this.folders = await this.fs.listFoldersAtRoot();
      this.renderList(listWrap, this.folders);
    } catch (err) {
      console.error("[BYOC] listFoldersAtRoot failed:", err);
      this.renderError(listWrap, err);
    }
  }

  private renderLoading(host: HTMLElement) {
    host.empty();
    host.addClass("byoc-folder-picker__list--state");
    const wrap = host.createDiv({ cls: "byoc-folder-picker__loading" });
    wrap.createDiv({ cls: "byoc-folder-picker__loader" });
    wrap.createSpan({ text: "Loading folders…" });
  }

  private renderError(host: HTMLElement, err: any) {
    host.empty();
    host.addClass("byoc-folder-picker__list--state");
    const wrap = host.createDiv({ cls: "byoc-folder-picker__error" });
    wrap.createEl("p", {
      cls: "byoc-folder-picker__error-msg",
      text: `Could not list folders: ${err?.message ?? err}`,
    });
    const retry = wrap.createEl("button", {
      cls: "byoc-folder-picker__retry",
      text: "Retry",
    });
    retry.addEventListener("click", async () => {
      this.renderLoading(host);
      try {
        const folders = await this.fs.listFoldersAtRoot();
        this.renderList(host, folders);
      } catch (e) {
        this.renderError(host, e);
      }
    });
  }

  private renderList(host: HTMLElement, folders: string[]) {
    host.empty();
    if (folders.length === 0) {
      host.addClass("byoc-folder-picker__list--state");
      host.createDiv({
        cls: "byoc-folder-picker__empty",
        text: "No folders at the root yet. Create one below.",
      });
      return;
    }
    host.removeClass("byoc-folder-picker__list--state");
    for (const name of folders) {
      const row = host.createEl("button", { cls: "byoc-folder-picker__row" });
      const iconEl = row.createDiv({ cls: "byoc-folder-picker__row-icon" });
      setIcon(iconEl, "folder");
      row.createDiv({ cls: "byoc-folder-picker__row-name", text: name });
      const chev = row.createDiv({ cls: "byoc-folder-picker__row-chev" });
      setIcon(chev, "chevron-right");
      row.addEventListener("click", () => this.pick(name));
    }
  }

  private renderCreate(host: HTMLElement) {
    const wrap = host.createDiv({ cls: "byoc-folder-picker__create" });
    const input = wrap.createEl("input", {
      cls: "byoc-folder-picker__input",
      attr: { type: "text", placeholder: "Folder name" },
    });
    input.value = this.suggestedName;
    const btn = wrap.createEl("button", {
      cls: "byoc-folder-picker__create-btn mod-cta",
      text: "Create & use",
    });
    btn.addEventListener("click", async () => {
      if (this.busy) return;
      const name = input.value.trim();
      if (!name) {
        new Notice("Folder name is required.");
        input.focus();
        return;
      }

      // If a folder with this name already exists, just use it instead of
      // calling the create API. The user's intent is "I want this folder
      // name" — whether it's pre-existing or freshly created is plumbing.
      // Case-insensitive so "Obsidian - Vault" and "obsidian - vault" don't
      // collide on case-sensitive providers and still resolve to the right
      // folder on case-insensitive ones.
      const existing = this.folders.find(
        (f) => f.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        new Notice(`Using existing folder "${existing}".`);
        this.pick(existing);
        return;
      }

      this.busy = true;
      btn.disabled = true;
      btn.textContent = "Creating…";
      try {
        await this.fs.createFolderAtRoot(name);
        this.pick(name);
      } catch (err) {
        // Provider returned "already exists" — race condition or hidden
        // folder we couldn't enumerate. Treat it as success and use the
        // name; the next sync will resolve to whatever's there.
        const msg = String(err?.message ?? err).toLowerCase();
        if (
          msg.includes("already exists") ||
          msg.includes("already_exists") ||
          msg.includes("exist")
        ) {
          new Notice(`Folder "${name}" already exists. Using it.`);
          this.pick(name);
          return;
        }
        console.error("[BYOC] createFolderAtRoot failed:", err);
        new Notice(`Could not create folder: ${err?.message ?? err}`);
        this.busy = false;
        btn.disabled = false;
        btn.textContent = "Create & use";
      }
    });
  }

  private pick(folderName: string) {
    this.onPicked(folderName);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
