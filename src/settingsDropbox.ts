import { SVG_DROPBOX } from './icons';
import { setSvgTitle } from "./misc";
import { DROPBOX_APP_KEY } from './baseTypes';
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Platform, Setting } from "obsidian";
import {
  DEFAULT_DROPBOX_CONFIG,
  getAuthUrlAndVerifier,
  sendAuthReq,
  setConfigBySuccessfullAuthInplace,
} from "./fsDropbox";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class DropboxAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly revokeAuthSetting: Setting;
  readonly t: (x: TransItemType, vars?: Record<string, string>) => string;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting,
    t: (x: TransItemType, vars?: Record<string, string>) => string
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.revokeAuthSetting = revokeAuthSetting;
    this.t = t;
  }

  async onOpen() {
    this.modalEl.addClass("byoc-auth-modal");
    setSvgTitle(this.titleEl, SVG_DROPBOX, "Connect Dropbox Account");
    const { contentEl } = this;
    const t = this.t;

    // Linux may open a second Obsidian instance on protocol redirect,
    // so fall back to manual paste on Linux desktop.
    const needManualPaste = Platform.isDesktopApp && Platform.isLinux;

    const { authUrl, verifier } = await getAuthUrlAndVerifier(
      DROPBOX_APP_KEY,
      needManualPaste
    );

    if (needManualPaste) {
      t("modal_dropboxauth_manualsteps")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", { text: val });
        });
    } else {
      this.plugin.oauth2Info.verifier = verifier;

      t("modal_dropboxauth_autosteps")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", { text: val });
        });
    }

    contentEl.createEl("button", { text: "Open authorization in browser" }, (el) => {
      el.onclick = () => activeWindow.open(authUrl);
    });

    contentEl.createEl("p").createEl("a", {
      href: authUrl,
      text: authUrl,
    });

    if (needManualPaste) {
      let authCode = "";
      new Setting(contentEl)
        .setName(t("modal_dropboxauth_maualinput"))
        .setDesc(t("modal_dropboxauth_maualinput_desc"))
        .addText((text) =>
          text
            .setPlaceholder("")
            .setValue("")
            .onChange((val) => {
              authCode = val.trim();
            })
        )
        .addButton(async (button) => {
          button.setButtonText(t("submit"));
          button.onClick(async () => {
            new Notice(t("modal_dropboxauth_maualinput_notice"));
            try {
              const authRes = await sendAuthReq(
                DROPBOX_APP_KEY,
                verifier,
                authCode,
                (e: unknown) => {
                  new Notice(t("protocol_dropbox_connect_fail"));
                  new Notice(`${String(e)}`);
                  throw e;
                }
              );
              await setConfigBySuccessfullAuthInplace(
                this.plugin.settings.dropbox,
                authRes!,
                () => this.plugin.saveSettings()
              );
              const client = getClient(
                this.plugin.settings,
                this.app.vault.getName(),
                () => this.plugin.saveSettings()
              );
              const username = await client.getUserDisplayName();
              this.plugin.settings.dropbox.username = username;
              await this.plugin.saveSettings();
              new Notice(
                t("modal_dropboxauth_maualinput_conn_succ", {
                  username: username,
                })
              );
              this.authDiv.toggleClass(
                "dropbox-auth-button-hide",
                this.plugin.settings.dropbox.username !== ""
              );
              this.revokeAuthDiv.toggleClass(
                "dropbox-revoke-auth-button-hide",
                this.plugin.settings.dropbox.username === ""
              );
              this.revokeAuthSetting.setDesc(
                t("modal_dropboxauth_maualinput_conn_succ_revoke", {
                  username: this.plugin.settings.dropbox.username,
                })
              );
              this.close();
            } catch (err) {
              console.error(err);
              new Notice(t("modal_dropboxauth_maualinput_conn_fail"));
            }
          });
        });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DropboxRevokeAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly t: (x: TransItemType, vars?: Record<string, string>) => string;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    t: (x: TransItemType, vars?: Record<string, string>) => string
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.t = t;
  }

  onOpen() {
    setSvgTitle(this.titleEl, SVG_DROPBOX, "Revoke Dropbox Account");
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "To fully revoke access, visit your Dropbox connected apps page and remove this app.",
      cls: "setting-item-description",
    });

    contentEl.createEl("a", {
      href: "https://www.dropbox.com/account/connected_apps",
      text: "Open Dropbox connected apps",
      cls: "external-link",
    });

    new Setting(contentEl)
      .setName(t("settings_dropbox_clearlocal"))
      .setDesc(t("settings_dropbox_clearlocal_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_dropbox_clearlocal_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.dropbox = cloneDeep(DEFAULT_DROPBOX_CONFIG);
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "dropbox-auth-button-hide",
              this.plugin.settings.dropbox.username !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "dropbox-revoke-auth-button-hide",
              this.plugin.settings.dropbox.username === ""
            );
            new Notice(t("settings_dropbox_clearlocal_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("settings_dropbox_revoke_noticeerr"));
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const generateDropboxSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const dropboxDiv = containerEl.createEl("div", { cls: "dropbox-hide" });
  dropboxDiv.toggleClass(
    "dropbox-hide",
    plugin.settings.serviceType !== "dropbox"
  );
  setSvgTitle(new Setting(dropboxDiv).setHeading().nameEl, SVG_DROPBOX, t("settings_dropbox"));

  const dropboxNotShowUpHintSetting = new Setting(dropboxDiv);
  dropboxNotShowUpHintSetting.settingEl.addClass("dropbox-allow-to-use-hide");

  const dropboxAllowedToUsedDiv = dropboxDiv.createDiv();

  const dropboxSelectAuthDiv = dropboxAllowedToUsedDiv.createDiv();
  const dropboxAuthDiv = dropboxSelectAuthDiv.createDiv({
    cls: "dropbox-auth-button-hide settings-auth-related",
  });
  const dropboxRevokeAuthDiv = dropboxSelectAuthDiv.createDiv({
    cls: "dropbox-revoke-auth-button-hide settings-auth-related",
  });

  const savedDropboxUsername = plugin.settings.dropbox?.username;

  const dropboxRevokeAuthSetting = new Setting(dropboxRevokeAuthDiv)
    .setName(savedDropboxUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText(t("settings_dropbox_revoke_button"));
      button.setWarning();
      button.onClick(() => {
        new DropboxRevokeAuthModal(
          app,
          plugin,
          dropboxAuthDiv,
          dropboxRevokeAuthDiv,
          t
        ).open();
      });
    });
  if (savedDropboxUsername) {
    dropboxRevokeAuthSetting.setDesc(savedDropboxUsername);
  }

  new Setting(dropboxAuthDiv)
    .setName("Connect Dropbox account")
    .setDesc("Authenticate byoc with your Dropbox account to enable cloud synchronization.")
    .addButton(async (button) => {
      button.setButtonText("Authorize");
      button.setCta();
      button.onClick(() => {
        const modal = new DropboxAuthModal(
          app,
          plugin,
          dropboxAuthDiv,
          dropboxRevokeAuthDiv,
          dropboxRevokeAuthSetting,
          t
        );
        plugin.oauth2Info.helperModal = modal;
        plugin.oauth2Info.authDiv = dropboxAuthDiv;
        plugin.oauth2Info.revokeDiv = dropboxRevokeAuthDiv;
        plugin.oauth2Info.revokeAuthSetting = dropboxRevokeAuthSetting;
        modal.open();
      });
    });

  const isConnected = !!plugin.settings.dropbox?.refreshToken;
  dropboxAuthDiv.toggleClass("dropbox-auth-button-hide", isConnected);
  dropboxRevokeAuthDiv.toggleClass("dropbox-revoke-auth-button-hide", !isConnected);

  // Remote folder — picker button + breadcrumb display.
  const currentDropboxFolder =
    plugin.settings.dropbox.remoteBaseDir || app.vault.getName();
  const dropboxRemoteFolderSetting = new Setting(dropboxAllowedToUsedDiv).setName(
    t("settings_remotebasedir")
  );
  renderFolderBreadcrumb(
    dropboxRemoteFolderSetting,
    "Dropbox",
    currentDropboxFolder
  );
  dropboxRemoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "dropbox",
        providerLabel: "Dropbox",
      })
    );
  });

  new Setting(dropboxAllowedToUsedDiv)
    .setName(t("settings_checkonnectivity"))
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
          new Notice(t("settings_dropbox_connect_succ"));
        } else {
          new Notice(t("settings_dropbox_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return { dropboxDiv, dropboxAllowedToUsedDiv, dropboxNotShowUpHintSetting };
};
