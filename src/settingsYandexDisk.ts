import { SVG_YANDEX } from './icons';
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import { generateAuthUrl, DEFAULT_YANDEXDISK_CONFIG } from "./fsYandexDisk";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import { stringToFragment } from "./misc";
import { ChangeRemoteBaseDirModal } from "./settings";

class YandexDiskAuthModal extends Modal {
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
    this.titleEl.innerHTML = `${SVG_YANDEX} <span style="vertical-align: middle;">Connect Yandex Disk Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;
    const t = this.t;
    const authUrl = generateAuthUrl();

    const div2 = contentEl.createDiv();
    t("modal_yandexdiskauth_tutorial").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });
    contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => { el.onclick = () => window.open(authUrl); });

}

  onClose() {
    this.contentEl.empty();
  }
}

class YandexDiskRevokeAuthModal extends Modal {
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
    this.titleEl.innerHTML = `${SVG_YANDEX} <span style="vertical-align: middle;">Revoke Yandex Disk Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    t("modal_yandexdiskrevokeauth_step1").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });
    const consentUrl = "https://id.yandex.com/security/apps";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });
    t("modal_yandexdiskrevokeauth_step2").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });

    new Setting(contentEl)
      .setName(t("modal_yandexdiskrevokeauth_clean"))
      .setDesc(t("modal_yandexdiskrevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_yandexdiskrevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.yandexdisk = cloneDeep(DEFAULT_YANDEXDISK_CONFIG);
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "yandexdisk-auth-button-hide",
              this.plugin.settings.yandexdisk.refreshToken !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "yandexdisk-revoke-auth-button-hide",
              this.plugin.settings.yandexdisk.refreshToken === ""
            );
            new Notice(t("modal_yandexdiskrevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_yandexdiskrevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const generateYandexDiskSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: any) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  const yandexDiskDiv = containerEl.createEl("div", { cls: "yandexdisk-hide" });
  yandexDiskDiv.toggleClass(
    "yandexdisk-hide",
    plugin.settings.serviceType !== "yandexdisk"
  );
  yandexDiskDiv.createEl("h2", { cls: "byoc-provider-heading" }).innerHTML = `${SVG_YANDEX} <span>${t("settings_yandexdisk")}</span>`;

  const yandexDiskLongDescDiv = yandexDiskDiv.createEl("div", {
    cls: "settings-long-desc",
  });
  yandexDiskLongDescDiv.createEl("p", {
    text: t("settings_yandexdisk_folder", {
      remoteBaseDir:
        plugin.settings.yandexdisk.remoteBaseDir || app.vault.getName(),
    }),
  });

  const yandexDiskNotShowUpHintSetting = new Setting(yandexDiskDiv);
  yandexDiskNotShowUpHintSetting.settingEl.addClass("yandexdisk-allow-to-use-hide");

  const yandexDiskAllowedToUsedDiv = yandexDiskDiv.createDiv();

  const yandexDiskSelectAuthDiv = yandexDiskAllowedToUsedDiv.createDiv();
  const yandexDiskAuthDiv = yandexDiskSelectAuthDiv.createDiv({
    cls: "yandexdisk-auth-button-hide settings-auth-related",
  });
  const yandexDiskRevokeAuthDiv = yandexDiskSelectAuthDiv.createDiv({
    cls: "yandexdisk-revoke-auth-button-hide settings-auth-related",
  });

  const yandexDiskRevokeAuthSetting = new Setting(yandexDiskRevokeAuthDiv)
    .setName(t("settings_yandexdisk_revoke"))
    .setDesc(t("settings_yandexdisk_revoke_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_yandexdisk_revoke_button"));
      button.onClick(async () => {
        new YandexDiskRevokeAuthModal(
          app,
          plugin,
          yandexDiskAuthDiv,
          yandexDiskRevokeAuthDiv,
          t
        ).open();
      });
    });

  new Setting(yandexDiskAuthDiv)
    .setName(t("settings_yandexdisk_auth"))
    .setDesc(t("settings_yandexdisk_auth_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_yandexdisk_auth_button"));
      button.onClick(async () => {
        const modal = new YandexDiskAuthModal(
          app,
          plugin,
          yandexDiskAuthDiv,
          yandexDiskRevokeAuthDiv,
          yandexDiskRevokeAuthSetting,
          t
        );
        plugin.oauth2Info.helperModal = modal;
        plugin.oauth2Info.authDiv = yandexDiskAuthDiv;
        plugin.oauth2Info.revokeDiv = yandexDiskRevokeAuthDiv;
        plugin.oauth2Info.revokeAuthSetting = yandexDiskRevokeAuthSetting;
        modal.open();
      });
    });

  const isConnected = !!plugin.settings.yandexdisk?.refreshToken;
  yandexDiskAuthDiv.toggleClass("yandexdisk-auth-button-hide", isConnected);
  yandexDiskRevokeAuthDiv.toggleClass("yandexdisk-revoke-auth-button-hide", !isConnected);

  let newYandexDiskRemoteBaseDir =
    plugin.settings.yandexdisk.remoteBaseDir || "";
  new Setting(yandexDiskAllowedToUsedDiv)
    .setName(t("settings_remotebasedir"))
    .setDesc(t("settings_remotebasedir_desc"))
    .addText((text) =>
      text
        .setPlaceholder(app.vault.getName())
        .setValue(newYandexDiskRemoteBaseDir)
        .onChange((value) => {
          newYandexDiskRemoteBaseDir = value.trim();
        })
    )
    .addButton((button) => {
      button.setButtonText(t("confirm"));
      button.onClick(() => {
        new ChangeRemoteBaseDirModal(
          app,
          plugin,
          newYandexDiskRemoteBaseDir,
          "yandexdisk"
        ).open();
      });
    });

  new Setting(yandexDiskAllowedToUsedDiv)
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
          new Notice(t("settings_yandexdisk_connect_succ"));
        } else {
          new Notice(t("settings_yandexdisk_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return {
    yandexDiskDiv,
    yandexDiskAllowedToUsedDiv,
    yandexDiskNotShowUpHintSetting,
  };
};
