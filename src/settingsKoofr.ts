import { SVG_KOOFR } from './icons';
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import { generateAuthUrl, DEFAULT_KOOFR_CONFIG } from "./fsKoofr";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class KoofrAuthModal extends Modal {
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
    this.titleEl.innerHTML = `${SVG_KOOFR} <span style="vertical-align: middle;">Connect Koofr Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;
    const t = this.t;
    const authUrl = generateAuthUrl();

    const div2 = contentEl.createDiv();
    t("modal_koofrauth_tutorial").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });
    contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => { el.onclick = () => activeWindow.open(authUrl); });

}

  onClose() {
    this.contentEl.empty();
  }
}

class KoofrRevokeAuthModal extends Modal {
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

  async onOpen() {
    this.titleEl.innerHTML = `${SVG_KOOFR} <span style="vertical-align: middle;">Revoke Koofr Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    t("modal_koofrrevokeauth_step1").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });
    const consentUrl = "https://app.koofr.net/app/admin/linked-apps";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });
    t("modal_koofrrevokeauth_step2").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });

    new Setting(contentEl)
      .setName(t("modal_koofrrevokeauth_clean"))
      .setDesc(t("modal_koofrrevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_koofrrevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.koofr = cloneDeep(DEFAULT_KOOFR_CONFIG);
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "koofr-auth-button-hide",
              this.plugin.settings.koofr.refreshToken !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "koofr-revoke-auth-button-hide",
              this.plugin.settings.koofr.refreshToken === ""
            );
            new Notice(t("modal_koofrrevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_koofrrevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const generateKoofrSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const koofrDiv = containerEl.createEl("div", { cls: "koofr-hide" });
  koofrDiv.toggleClass("koofr-hide", plugin.settings.serviceType !== "koofr");
  koofrDiv.createEl("h2", { cls: "byoc-provider-heading" }).innerHTML = `${SVG_KOOFR} <span>${t("settings_koofr")}</span>`;

  const koofrNotShowUpHintSetting = new Setting(koofrDiv);
  koofrNotShowUpHintSetting.settingEl.addClass("koofr-allow-to-use-hide");

  const koofrAllowedToUsedDiv = koofrDiv.createDiv();

  const koofrSelectAuthDiv = koofrAllowedToUsedDiv.createDiv();
  const koofrAuthDiv = koofrSelectAuthDiv.createDiv({
    cls: "koofr-auth-button-hide settings-auth-related",
  });
  const koofrRevokeAuthDiv = koofrSelectAuthDiv.createDiv({
    cls: "koofr-revoke-auth-button-hide settings-auth-related",
  });

  const savedKoofrUsername = plugin.settings.koofr?.username;

  const koofrRevokeAuthSetting = new Setting(koofrRevokeAuthDiv)
    .setName(savedKoofrUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText(t("settings_koofr_revoke_button"));
      button.setWarning();
      button.onClick(async () => {
        new KoofrRevokeAuthModal(
          app,
          plugin,
          koofrAuthDiv,
          koofrRevokeAuthDiv,
          t
        ).open();
      });
    });
  if (savedKoofrUsername) {
    koofrRevokeAuthSetting.setDesc(savedKoofrUsername);
  }

  new Setting(koofrAuthDiv)
    .setName(t("settings_koofr_auth"))
    .setDesc(t("settings_koofr_auth_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_koofr_auth_button"));
      button.onClick(async () => {
        const modal = new KoofrAuthModal(
          app,
          plugin,
          koofrAuthDiv,
          koofrRevokeAuthDiv,
          koofrRevokeAuthSetting,
          t
        );
        plugin.oauth2Info.helperModal = modal;
        plugin.oauth2Info.authDiv = koofrAuthDiv;
        plugin.oauth2Info.revokeDiv = koofrRevokeAuthDiv;
        plugin.oauth2Info.revokeAuthSetting = koofrRevokeAuthSetting;
        modal.open();
      });
    });

  const isConnected = !!plugin.settings.koofr?.refreshToken;
  koofrAuthDiv.toggleClass("koofr-auth-button-hide", isConnected);
  koofrRevokeAuthDiv.toggleClass("koofr-revoke-auth-button-hide", !isConnected);

  // Remote folder — picker button + breadcrumb display.
  const currentKoofrFolder =
    plugin.settings.koofr.remoteBaseDir || app.vault.getName();
  const koofrRemoteFolderSetting = new Setting(koofrAllowedToUsedDiv).setName(
    t("settings_remotebasedir")
  );
  renderFolderBreadcrumb(koofrRemoteFolderSetting, "Koofr", currentKoofrFolder);
  koofrRemoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "koofr",
        providerLabel: "Koofr",
      })
    );
  });

  new Setting(koofrAllowedToUsedDiv)
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
          errors.msg = `${err}`;
        });
        if (res) {
          new Notice(t("settings_koofr_connect_succ"));
        } else {
          new Notice(t("settings_koofr_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return { koofrDiv, koofrAllowedToUsedDiv, koofrNotShowUpHintSetting };
};
