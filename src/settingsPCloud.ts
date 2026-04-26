import { SVG_PCLOUD } from './icons';
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import { DEFAULT_PCLOUD_CONFIG, generateAuthUrl } from "./fsPCloud";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class PCloudAuthModal extends Modal {
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
    this.titleEl.innerHTML = `${SVG_PCLOUD} <span style="vertical-align: middle;">Connect pCloud Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;
    const t = this.t;

    const { authUrl } = await generateAuthUrl(true);
    const div2 = contentEl.createDiv();
    t("modal_pcloudauth_tutorial").split("\n").forEach((val) => { div2.createEl("p", { text: val }); });
    contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => { el.onclick = () => activeWindow.open(authUrl); });

}

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class PCloudRevokeAuthModal extends Modal {
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
    this.titleEl.innerHTML = `${SVG_PCLOUD} <span style="vertical-align: middle;">Revoke pCloud Account</span>`;
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    t("modal_pcloudrevokeauth_step1").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });
    const consentUrl = "https://my.pcloud.com/#page=settings&settings=tab-apps";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });
    t("modal_pcloudrevokeauth_step2").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });

    new Setting(contentEl)
      .setName(t("modal_pcloudrevokeauth_clean"))
      .setDesc(t("modal_pcloudrevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_pcloudrevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.pcloud = cloneDeep(DEFAULT_PCLOUD_CONFIG);
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "pcloud-auth-button-hide",
              this.plugin.settings.pcloud.accessToken !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "pcloud-revoke-auth-button-hide",
              this.plugin.settings.pcloud.accessToken === ""
            );
            new Notice(t("modal_pcloudrevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_pcloudrevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export const generatePCloudSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const pCloudDiv = containerEl.createEl("div", { cls: "pcloud-hide" });
  pCloudDiv.toggleClass("pcloud-hide", plugin.settings.serviceType !== "pcloud");
  pCloudDiv.createEl("h2", { cls: "byoc-provider-heading" }).innerHTML = `${SVG_PCLOUD} <span>${t("settings_pcloud")}</span>`;

  const pCloudNotShowUpHintSetting = new Setting(pCloudDiv);
  pCloudNotShowUpHintSetting.settingEl.addClass("pcloud-allow-to-use-hide");

  const pCloudAllowedToUsedDiv = pCloudDiv.createDiv();
  const pcloudSelectAuthDiv = pCloudAllowedToUsedDiv.createDiv();

  // â”€â”€ Auth button div (shown when NOT connected) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const pcloudAuthDiv = pcloudSelectAuthDiv.createDiv({
    cls: "pcloud-auth-button-hide settings-auth-related",
  });

  // â”€â”€ Revoke / connected div (shown when connected) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const pcloudRevokeAuthDiv = pcloudSelectAuthDiv.createDiv({
    cls: "pcloud-revoke-auth-button-hide settings-auth-related",
  });

  const hasAccessToken = !!plugin.settings.pcloud?.accessToken;
  const savedUsername = plugin.settings.pcloud?.username;

  // Combined identity + revoke row. Showing "Logged in as <user>" with the
  // Revoke action on the same line reads as a single coherent state ("you
  // are connected as X, tap to disconnect") instead of two stacked rows
  // for the same concept.
  const pcloudRevokeAuthSetting = new Setting(pcloudRevokeAuthDiv)
    .setName(savedUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText(t("settings_pcloud_revoke_button"));
      button.setWarning();
      button.onClick(async () => {
        new PCloudRevokeAuthModal(
          app,
          plugin,
          pcloudAuthDiv,
          pcloudRevokeAuthDiv,
          t
        ).open();
      });
    });
  if (savedUsername) {
    pcloudRevokeAuthSetting.setDesc(savedUsername);
  }

  // Auth button row
  new Setting(pcloudAuthDiv)
    .setName(t("settings_pcloud_auth"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_pcloud_auth_button"));
      button.setCta();
      button.onClick(async () => {
        const modal = new PCloudAuthModal(
          app,
          plugin,
          pcloudAuthDiv,
          pcloudRevokeAuthDiv,
          pcloudRevokeAuthSetting,
          t
        );
        plugin.oauth2Info.helperModal = modal;
        plugin.oauth2Info.authDiv = pcloudAuthDiv;
        plugin.oauth2Info.revokeDiv = pcloudRevokeAuthDiv;
        plugin.oauth2Info.revokeAuthSetting = pcloudRevokeAuthSetting;
        modal.open();
      });
    });

  pcloudAuthDiv.toggleClass("pcloud-auth-button-hide", hasAccessToken);
  pcloudRevokeAuthDiv.toggleClass("pcloud-revoke-auth-button-hide", !hasAccessToken);

  // Remote folder — picker button + breadcrumb display.
  const currentFolder =
    plugin.settings.pcloud.remoteBaseDir || app.vault.getName();
  const remoteFolderSetting = new Setting(pCloudAllowedToUsedDiv).setName(
    t("settings_remotebasedir")
  );
  renderFolderBreadcrumb(remoteFolderSetting, "pCloud", currentFolder);
  remoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "pcloud",
        providerLabel: "pCloud",
      })
    );
  });

  // Check connectivity
  new Setting(pCloudAllowedToUsedDiv)
    .setName(t("settings_checkonnectivity"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_checkonnectivity_button"));
      button.onClick(async () => {
        new Notice(t("settings_checkonnectivity_checking"));
        const client = getClient(plugin.settings, app.vault.getName(), () =>
          plugin.saveSettings()
        );
        const errors = { msg: "" };
        const res = await client.checkConnect((err: unknown) => { errors.msg = `${err}`; });
        if (res) {
          new Notice(t("settings_pcloud_connect_succ"));
        } else {
          new Notice(t("settings_pcloud_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return {
    pCloudDiv,
    pCloudAllowedToUsedDiv,
    pCloudNotShowUpHintSetting,
  };
};
