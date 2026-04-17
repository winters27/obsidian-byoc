import { SVG_GDRIVE } from './icons';
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import {
  DEFAULT_GOOGLEDRIVE_CONFIG,
  generateAuthUrl,
  sendAuthReq,
  setConfigBySuccessfullAuthInplace,
} from "./fsGoogleDrive";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import { stringToFragment } from "./misc";
import { ChangeRemoteBaseDirModal } from "./settings";

// Google uses urn:ietf:wg:oauth:2.0:oob â€” copy-paste flow, no obsidian:// callback
class GoogleDriveAuthModal extends Modal {
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
    this.titleEl.innerHTML = `${SVG_GDRIVE} <span style="vertical-align: middle;">Connect Google Drive Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;
    const t = this.t;
    const authUrl = generateAuthUrl();

    const div2 = contentEl.createDiv();
    t("modal_googledriveauth_tutorial").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });
    contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => { el.onclick = () => window.open(authUrl); });

let authCode = "";
    new Setting(contentEl)
      .setName(t("modal_googledriveauth_codeinput"))
      .setDesc(t("modal_googledriveauth_codeinput_desc"))
      .addText((text) =>
        text
          .setPlaceholder(t("modal_googledriveauth_codeinput_placeholder"))
          .onChange((val) => {
            authCode = val.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("modal_googledriveauth_codeinput_confirm"));
        button.setCta();
        button.onClick(async () => {
          if (!authCode) return;
          new Notice(t("modal_googledriveauth_codeinput_notice"));
          try {
            const authRes = await sendAuthReq(
              authCode,
              "",
              async (e: any) => {
                new Notice(t("modal_googledriveauth_codeinput_conn_fail"));
                new Notice(`${e}`);
              }
            );
            if (!authRes || authRes.error) {
              new Notice(t("modal_googledriveauth_codeinput_conn_fail"));
              return;
            }
            const self = this;
            await setConfigBySuccessfullAuthInplace(
              this.plugin.settings.googledrive,
              authRes,
              () => self.plugin.saveSettings()
            );
            const isConnected =
              this.plugin.settings.googledrive.refreshToken !== "";
            this.authDiv.toggleClass(
              "googledrive-auth-button-hide",
              isConnected
            );
            this.revokeAuthDiv.toggleClass(
              "googledrive-revoke-auth-button-hide",
              !isConnected
            );
            new Notice(t("modal_googledriveauth_codeinput_conn_succ"));
            this.close();
          } catch (e) {
            console.error(e);
            new Notice(t("modal_googledriveauth_codeinput_conn_fail"));
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GoogleDriveRevokeAuthModal extends Modal {
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
    this.titleEl.innerHTML = `${SVG_GDRIVE} <span style="vertical-align: middle;">Revoke Google Drive Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    t("modal_googledriverevokeauth_step1").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });
    const consentUrl =
      "https://myaccount.google.com/permissions";
    t("modal_googledriverevokeauth_step2").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });

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
            const isConnected =
              this.plugin.settings.googledrive.refreshToken !== "";
            this.authDiv.toggleClass(
              "googledrive-auth-button-hide",
              isConnected
            );
            this.revokeAuthDiv.toggleClass(
              "googledrive-revoke-auth-button-hide",
              !isConnected
            );
            new Notice(t("modal_googledriverevokeauth_clean_notice"));
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
  t: (x: TransItemType, vars?: any) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  const googleDriveDiv = containerEl.createEl("div", {
    cls: "googledrive-hide",
  });
  googleDriveDiv.toggleClass(
    "googledrive-hide",
    plugin.settings.serviceType !== "googledrive"
  );
  googleDriveDiv.createEl("h2", { cls: "byoc-provider-heading" }).innerHTML = `${SVG_GDRIVE} <span>${t("settings_googledrive")}</span>`;

  const googleDriveLongDescDiv = googleDriveDiv.createEl("div", {
    cls: "settings-long-desc",
  });
  googleDriveLongDescDiv.createEl("p", {
    text: t("settings_googledrive_folder", {
      remoteBaseDir:
        plugin.settings.googledrive.remoteBaseDir || app.vault.getName(),
    }),
  });

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

  const googleDriveRevokeAuthSetting = new Setting(googleDriveRevokeAuthDiv)
    .setName(t("settings_googledrive_revoke"))
    .setDesc(t("settings_googledrive_revoke_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_googledrive_revoke_button"));
      button.onClick(async () => {
        new GoogleDriveRevokeAuthModal(
          app,
          plugin,
          googleDriveAuthDiv,
          googleDriveRevokeAuthDiv,
          t
        ).open();
      });
    });

  new Setting(googleDriveAuthDiv)
    .setName(t("settings_googledrive_auth"))
    .setDesc(t("settings_googledrive_auth_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_googledrive_auth_button"));
      button.onClick(async () => {
        new GoogleDriveAuthModal(
          app,
          plugin,
          googleDriveAuthDiv,
          googleDriveRevokeAuthDiv,
          googleDriveRevokeAuthSetting,
          t
        ).open();
      });
    });

  const isConnected = !!plugin.settings.googledrive?.refreshToken;
  googleDriveAuthDiv.toggleClass("googledrive-auth-button-hide", isConnected);
  googleDriveRevokeAuthDiv.toggleClass(
    "googledrive-revoke-auth-button-hide",
    !isConnected
  );

  let newGoogleDriveRemoteBaseDir =
    plugin.settings.googledrive.remoteBaseDir || "";
  new Setting(googleDriveAllowedToUsedDiv)
    .setName(t("settings_remotebasedir"))
    .setDesc(t("settings_remotebasedir_desc"))
    .addText((text) =>
      text
        .setPlaceholder(app.vault.getName())
        .setValue(newGoogleDriveRemoteBaseDir)
        .onChange((value) => {
          newGoogleDriveRemoteBaseDir = value.trim();
        })
    )
    .addButton((button) => {
      button.setButtonText(t("confirm"));
      button.onClick(() => {
        new ChangeRemoteBaseDirModal(
          app,
          plugin,
          newGoogleDriveRemoteBaseDir,
          "googledrive"
        ).open();
      });
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
        const res = await client.checkConnect((err: any) => {
          errors.msg = `${err}`;
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
