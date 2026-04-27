import { SVG_YANDEX } from './icons';
import { setSvgTitle } from "./misc";
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import { generateAuthUrl, DEFAULT_YANDEXDISK_CONFIG } from "./fsYandexDisk";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class YandexDiskAuthModal extends Modal {
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

  onOpen() {
    setSvgTitle(this.titleEl, SVG_YANDEX, "Connect Yandex Disk Account");
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;
    const t = this.t;
    const authUrl = generateAuthUrl();

    const div2 = contentEl.createDiv();
    t("modal_yandexdiskauth_tutorial").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });
    contentEl.createEl("button", { text: "Open authorization in browser" }, (el) => { el.onclick = () => activeWindow.open(authUrl); });

}

  onClose() {
    this.contentEl.empty();
  }
}

class YandexDiskRevokeAuthModal extends Modal {
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
    setSvgTitle(this.titleEl, SVG_YANDEX, "Revoke Yandex Disk Account");
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    t("modal_yandexdiskrevokeauth_step1").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });
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
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const yandexDiskDiv = containerEl.createEl("div", { cls: "yandexdisk-hide" });
  yandexDiskDiv.toggleClass(
    "yandexdisk-hide",
    plugin.settings.serviceType !== "yandexdisk"
  );
  setSvgTitle(new Setting(yandexDiskDiv).setHeading().nameEl, SVG_YANDEX, t("settings_yandexdisk"));

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

  const savedYandexUsername = plugin.settings.yandexdisk?.username;

  const yandexDiskRevokeAuthSetting = new Setting(yandexDiskRevokeAuthDiv)
    .setName(savedYandexUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText(t("settings_yandexdisk_revoke_button"));
      button.setWarning();
      button.onClick(() => {
        new YandexDiskRevokeAuthModal(
          app,
          plugin,
          yandexDiskAuthDiv,
          yandexDiskRevokeAuthDiv,
          t
        ).open();
      });
    });
  if (savedYandexUsername) {
    yandexDiskRevokeAuthSetting.setDesc(savedYandexUsername);
  }

  new Setting(yandexDiskAuthDiv)
    .setName(t("settings_yandexdisk_auth"))
    .setDesc(t("settings_yandexdisk_auth_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_yandexdisk_auth_button"));
      button.onClick(() => {
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

  // Remote folder — picker button + breadcrumb display.
  const currentYandexFolder =
    plugin.settings.yandexdisk.remoteBaseDir || app.vault.getName();
  const yandexRemoteFolderSetting = new Setting(yandexDiskAllowedToUsedDiv).setName(
    t("settings_remotebasedir")
  );
  renderFolderBreadcrumb(
    yandexRemoteFolderSetting,
    "Yandex Disk",
    currentYandexFolder
  );
  yandexRemoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "yandexdisk",
        providerLabel: "Yandex Disk",
      })
    );
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
        const res = await client.checkConnect((err: unknown) => {
          errors.msg = err instanceof Error ? err.message : String(err);
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
