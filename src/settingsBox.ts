import { SVG_BOX } from './icons';
import { setSvgTitle } from "./misc";
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import { generateAuthUrl, DEFAULT_BOX_CONFIG } from "./fsBox";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class BoxAuthModal extends Modal {
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
    setSvgTitle(this.titleEl, SVG_BOX, "Connect Box Account");
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;

    const authUrl = generateAuthUrl();

    const div2 = contentEl.createDiv();
    div2.createEl("p", { text: "1. Click the button below to authorize byoc within box." });
    div2.createEl("p", { text: `2. Byoc will authenticate via the Obsidian:// protocol.` });
    div2.createEl("p", { text: "3. If prompted, please allow the browser to open Obsidian." });
    const btn = contentEl.createEl("button", { text: "Open authorization in browser" }, (el) => { el.onclick = () => activeWindow.open(authUrl); });
    btn.addClass("mod-cta");

}

  onClose() {
    this.contentEl.empty();
  }
}

class BoxRevokeAuthModal extends Modal {
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
    setSvgTitle(this.titleEl, SVG_BOX, "Revoke Box Account");
    this.modalEl.addClass("byoc-auth-modal");

    const { contentEl } = this;

    contentEl.createEl("p", { text: "To revoke byoc's access:" });
    contentEl.createEl("p", { text: `1. Visit the box security portal and remove the byoc application.` });
    const consentUrl = "https://app.box.com/account/security";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });
    contentEl.createEl("p", { text: "2. Click 'clear local OAUTH data' below to erase the credentials from your device." });

    new Setting(contentEl)
      .setName("Clear local OAUTH data")
      .setDesc("Erases the stored refresh/access tokens from your vault.")
      .addButton(async (button) => {
        button.setButtonText("Clear tokens");
        button.setCta();
        button.onClick(async () => {
          try {
            this.plugin.settings.box = cloneDeep(DEFAULT_BOX_CONFIG);
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "box-auth-button-hide",
              this.plugin.settings.box.refreshToken !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "box-revoke-auth-button-hide",
              this.plugin.settings.box.refreshToken === ""
            );
            new Notice("Local box authorization tokens cleared.");
            this.close();
          } catch (err) {
            console.error(err);
            new Notice("Failed to clear box tokens.");
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const generateBoxSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const boxDiv = containerEl.createEl("div", { cls: "box-hide" });
  boxDiv.toggleClass("box-hide", plugin.settings.serviceType !== "box");
  setSvgTitle(new Setting(boxDiv).setHeading().nameEl, SVG_BOX, t("settings_box"));

  const boxNotShowUpHintSetting = new Setting(boxDiv);
  boxNotShowUpHintSetting.settingEl.addClass("box-allow-to-use-hide");

  const boxAllowedToUsedDiv = boxDiv.createDiv();

  const boxSelectAuthDiv = boxAllowedToUsedDiv.createDiv();
  const boxAuthDiv = boxSelectAuthDiv.createDiv({
    cls: "box-auth-button-hide settings-auth-related",
  });
  const boxRevokeAuthDiv = boxSelectAuthDiv.createDiv({
    cls: "box-revoke-auth-button-hide settings-auth-related",
  });

  const savedBoxUsername = plugin.settings.box?.username;

  const boxRevokeAuthSetting = new Setting(boxRevokeAuthDiv)
    .setName(savedBoxUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText("Revoke access");
      button.setWarning();
      button.onClick(() => {
        new BoxRevokeAuthModal(app, plugin, boxAuthDiv, boxRevokeAuthDiv, t).open();
      });
    });
  if (savedBoxUsername) {
    boxRevokeAuthSetting.setDesc(savedBoxUsername);
  }

  new Setting(boxAuthDiv)
    .setName("Connect box account")
    .setDesc("Authenticate byoc with your box account to enable cloud synchronization.")
    .addButton(async (button) => {
      button.setButtonText("Authorize");
      button.setCta();
      button.onClick(() => {
        const modal = new BoxAuthModal(
          app,
          plugin,
          boxAuthDiv,
          boxRevokeAuthDiv,
          boxRevokeAuthSetting,
          t
        );
        plugin.oauth2Info.helperModal = modal;
        plugin.oauth2Info.authDiv = boxAuthDiv;
        plugin.oauth2Info.revokeDiv = boxRevokeAuthDiv;
        plugin.oauth2Info.revokeAuthSetting = boxRevokeAuthSetting;
        modal.open();
      });
    });

  const isConnected = !!plugin.settings.box?.refreshToken;
  boxAuthDiv.toggleClass("box-auth-button-hide", isConnected);
  boxRevokeAuthDiv.toggleClass("box-revoke-auth-button-hide", !isConnected);

  // Remote folder — picker button + breadcrumb display.
  const currentBoxFolder =
    plugin.settings.box.remoteBaseDir || app.vault.getName();
  const boxRemoteFolderSetting = new Setting(boxAllowedToUsedDiv).setName(
    "Base directory"
  );
  renderFolderBreadcrumb(boxRemoteFolderSetting, "Box", currentBoxFolder);
  boxRemoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "box",
        providerLabel: "Box",
      })
    );
  });

  new Setting(boxAllowedToUsedDiv)
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
          new Notice(t("settings_box_connect_succ"));
        } else {
          new Notice(t("settings_box_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return { boxDiv, boxAllowedToUsedDiv, boxNotShowUpHintSetting };
};
