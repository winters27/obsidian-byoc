import { SVG_GDRIVE } from './icons';
import { setSvgTitle } from "./misc";
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import {
  DEFAULT_GOOGLEDRIVE_CONFIG,
  generateAuthUrl,
} from "./fsGoogleDrive";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

// Google Drive uses a bridge page on GitHub Pages to redirect the OAuth
// callback into Obsidian's protocol handler (obsidian://bring-your-own-cloud-cb-googledrive).
// The auth modal just opens the auth URL — identical UX to Dropbox/pCloud.

class GoogleDriveAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly t: (x: TransItemType, vars?: Record<string, string>) => string;

  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    t: (x: TransItemType, vars?: Record<string, string>) => string
  ) {
    super(app);
    this.plugin = plugin;
    this.t = t;
  }

  async onOpen() {
    setSvgTitle(this.titleEl, SVG_GDRIVE, "Connect Google Drive Account");
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;
    const authUrl = generateAuthUrl();

    contentEl.createEl("p", {
      text: "Click the button below to authorize with Google Drive. You will be redirected back to Obsidian automatically.",
      cls: "setting-item-description",
    });

    contentEl.createEl("button", {
      text: "Authorize with Google",
      cls: "mod-cta",
    }, (el) => {
      el.onclick = () => activeWindow.open(authUrl);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GoogleDriveRevokeAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly t: (x: TransItemType, vars?: Record<string, string>) => string;

  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    t: (x: TransItemType, vars?: Record<string, string>) => string
  ) {
    super(app);
    this.plugin = plugin;
    this.t = t;
  }

  async onOpen() {
    setSvgTitle(this.titleEl, SVG_GDRIVE, "Revoke Google Drive Account");
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "To fully revoke access, visit your Google account permissions page and remove this app.",
      cls: "setting-item-description",
    });

    contentEl.createEl("a", {
      href: "https://myaccount.google.com/permissions",
      text: "Open Google Account Permissions",
      cls: "external-link",
    });

    new Setting(contentEl)
      .setName(t("modal_googledriverevokeauth_clean"))
      .setDesc(t("modal_googledriverevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_googledriverevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.googledrive = cloneDeep(
              DEFAULT_GOOGLEDRIVE_CONFIG
            );
            await this.plugin.saveSettings();
            new Notice(t("modal_googledriverevokeauth_clean_notice"));
            (this.plugin as any).settingTab?.display();
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_googledriverevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const generateGoogleDriveSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const googleDriveDiv = containerEl.createEl("div", {
    cls: "googledrive-hide",
  });
  googleDriveDiv.toggleClass(
    "googledrive-hide",
    plugin.settings.serviceType !== "googledrive"
  );
  setSvgTitle(new Setting(googleDriveDiv).setHeading().nameEl, SVG_GDRIVE, "${t(\"settings_googledrive\")}");

  const googleDriveNotShowUpHintSetting = new Setting(googleDriveDiv);
  googleDriveNotShowUpHintSetting.settingEl.addClass(
    "googledrive-allow-to-use-hide"
  );

  const googleDriveAllowedToUsedDiv = googleDriveDiv.createDiv();

  const googleDriveSelectAuthDiv = googleDriveAllowedToUsedDiv.createDiv();
  const googleDriveAuthDiv = googleDriveSelectAuthDiv.createDiv({
    cls: "googledrive-auth-button-hide settings-auth-related",
  });
  const googleDriveRevokeAuthDiv = googleDriveSelectAuthDiv.createDiv({
    cls: "googledrive-revoke-auth-button-hide settings-auth-related",
  });

  const savedGDriveUsername = plugin.settings.googledrive?.username;

  const googleDriveRevokeAuthSetting = new Setting(googleDriveRevokeAuthDiv)
    .setName(savedGDriveUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText(t("settings_googledrive_revoke_button"));
      button.setWarning();
      button.onClick(async () => {
        new GoogleDriveRevokeAuthModal(
          app,
          plugin,
          t
        ).open();
      });
    });
  if (savedGDriveUsername) {
    googleDriveRevokeAuthSetting.setDesc(savedGDriveUsername);
  }

  new Setting(googleDriveAuthDiv)
    .setName(t("settings_googledrive_auth"))
    .setDesc(t("settings_googledrive_auth_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_googledrive_auth_button"));
      button.onClick(async () => {
        const m = new GoogleDriveAuthModal(
          app,
          plugin,
          t
        );
        // Store modal ref so the callback handler can close it
        plugin.oauth2Info = plugin.oauth2Info || {};
        plugin.oauth2Info.helperModal = m;
        m.open();
      });
    });

  const isConnected = !!plugin.settings.googledrive?.refreshToken;
  googleDriveAuthDiv.toggleClass("googledrive-auth-button-hide", isConnected);
  googleDriveRevokeAuthDiv.toggleClass(
    "googledrive-revoke-auth-button-hide",
    !isConnected
  );

  // Remote folder — picker button + breadcrumb display.
  const currentGDriveFolder =
    plugin.settings.googledrive.remoteBaseDir || app.vault.getName();
  const gdriveRemoteFolderSetting = new Setting(googleDriveAllowedToUsedDiv).setName(
    t("settings_remotebasedir")
  );
  renderFolderBreadcrumb(
    gdriveRemoteFolderSetting,
    "Google Drive",
    currentGDriveFolder
  );
  gdriveRemoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "googledrive",
        providerLabel: "Google Drive",
      })
    );
  });

  new Setting(googleDriveAllowedToUsedDiv)
    .setName(t("settings_checkonnectivity"))
    .setDesc(t("settings_checkonnectivity_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_checkonnectivity_button"));
      button.onClick(async () => {
        new Notice(t("settings_checkonnectivity_checking"));
        const client = getClient(plugin.settings, app.vault.getName(), () =>
          plugin.saveSettings()
        );
        const errors = { msg: "" };
        const res = await client.checkConnect((err: unknown) => {
          errors.msg = err instanceof Error ? err.message : String(err);
        });
        if (res) {
          new Notice(t("settings_googledrive_connect_succ"));
        } else {
          new Notice(t("settings_googledrive_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return {
    googleDriveDiv,
    googleDriveAllowedToUsedDiv,
    googleDriveNotShowUpHintSetting,
  };
};
