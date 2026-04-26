import { SVG_DROPBOX } from './icons';
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
import { stringToFragment } from "./misc";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class DropboxAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly revokeAuthSetting: Setting;
  readonly t: (x: TransItemType, vars?: any) => string;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting,
    t: (x: TransItemType, vars?: any) => string
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
    this.titleEl.innerHTML = `${SVG_DROPBOX} <span style="vertical-align: middle;">Connect Dropbox Account</span>`;
    const { contentEl } = this;
    const t = this.t;

    let needManualPaste = false;
    const userAgent = window.navigator.userAgent.toLocaleLowerCase() || "";
    // Linux may open a second Obsidian instance on protocol redirect,
    // so fall back to manual paste on Linux desktop.
    if (
      Platform.isDesktopApp &&
      !Platform.isMacOS &&
      (/linux/.test(userAgent) ||
        /ubuntu/.test(userAgent) ||
        /debian/.test(userAgent) ||
        /fedora/.test(userAgent) ||
        /centos/.test(userAgent))
    ) {
      needManualPaste = true;
    }

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

    contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => {
      el.onclick = () => window.open(authUrl);
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
                async (e: any) => {
                  new Notice(t("protocol_dropbox_connect_fail"));
                  new Notice(`${e}`);
                  throw e;
                }
              );
              const self = this;
              setConfigBySuccessfullAuthInplace(
                this.plugin.settings.dropbox,
                authRes!,
                () => self.plugin.saveSettings()
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
  readonly t: (x: TransItemType, vars?: any) => string;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    t: (x: TransItemType, vars?: any) => string
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.t = t;
  }

  async onOpen() {
    this.titleEl.innerHTML = `${SVG_DROPBOX} <span style="vertical-align: middle;">Revoke Dropbox Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "To fully revoke access, visit your Dropbox connected apps page and remove this app.",
      cls: "setting-item-description",
    });

    contentEl.createEl("a", {
      href: "https://www.dropbox.com/account/connected_apps",
      text: "Open Dropbox Connected Apps",
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
  t: (x: TransItemType, vars?: any) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  const dropboxDiv = containerEl.createEl("div", { cls: "dropbox-hide" });
  dropboxDiv.toggleClass(
    "dropbox-hide",
    plugin.settings.serviceType !== "dropbox"
  );
  dropboxDiv.createEl("h2", { cls: "byoc-provider-heading" }).innerHTML = `${SVG_DROPBOX} <span>${t("settings_dropbox")}</span>`;

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
      button.onClick(async () => {
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
    .setName("Connect Dropbox Account")
    .setDesc("Authenticate BYOC with your Dropbox account to enable cloud synchronization.")
    .addButton(async (button) => {
      button.setButtonText("Authorize");
      button.setCta();
      button.onClick(async () => {
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
        const res = await client.checkConnect((err: any) => {
          errors.msg = `${err}`;
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
