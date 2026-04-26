import { SVG_ONEDRIVE } from './icons';
import { setSvgTitle } from "./misc";
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import {
  DEFAULT_ONEDRIVEFULL_CONFIG,
  getAuthUrlAndVerifier,
} from "./fsOnedriveFull";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class OnedrivefullAuthModal extends Modal {
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
    setSvgTitle(this.titleEl, SVG_ONEDRIVE, "Connect OneDrive (Full) Account");
    this.modalEl.addClass("byoc-auth-modal");
    const { contentEl } = this;
    const t = this.t;

    t("modal_onedrivefullauth_tutorial").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });

    try {
      const { authUrl, verifier } = await getAuthUrlAndVerifier(
        this.plugin.settings.onedrivefull.clientID,
        this.plugin.settings.onedrivefull.authority
      );

      this.plugin.oauth2Info.verifier = verifier;

      const _div2 = contentEl.createDiv();
      contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => { el.onclick = () => activeWindow.open(authUrl); });

} catch (e) {
      console.error(e);
      contentEl.createEl("p", {
        text: t("protocol_onedrivefull_connect_fail"),
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class OnedrivefullRevokeAuthModal extends Modal {
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
    setSvgTitle(this.titleEl, SVG_ONEDRIVE, "Revoke OneDrive (Full) Account");
    this.modalEl.addClass("byoc-auth-modal");
    const t = this.t;
    const { contentEl } = this;

    t("modal_onedrivefullrevokeauth_step1").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });
    const consentUrl = "https://microsoft.com/consent";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });
    t("modal_onedrivefullrevokeauth_step2").split("\n").forEach((val) => { contentEl.createEl("p", { text: val }); });

    new Setting(contentEl)
      .setName(t("modal_onedrivefullrevokeauth_clean"))
      .setDesc(t("modal_onedrivefullrevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_onedrivefullrevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.onedrivefull = cloneDeep(DEFAULT_ONEDRIVEFULL_CONFIG);
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "onedrivefull-auth-button-hide",
              this.plugin.settings.onedrivefull.username !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "onedrivefull-revoke-auth-button-hide",
              this.plugin.settings.onedrivefull.username === ""
            );
            new Notice(t("modal_onedrivefullrevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_onedrivefullrevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const generateOnedriveFullSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const onedriveFullDiv = containerEl.createEl("div", {
    cls: "onedrivefull-hide",
  });
  onedriveFullDiv.toggleClass(
    "onedrivefull-hide",
    plugin.settings.serviceType !== "onedrivefull"
  );
  setSvgTitle(new Setting(onedriveFullDiv).setHeading().nameEl, SVG_ONEDRIVE, t("settings_onedrivefull"));

  const onedriveFullNotShowUpHintSetting = new Setting(onedriveFullDiv);
  onedriveFullNotShowUpHintSetting.settingEl.addClass(
    "onedrivefull-allow-to-use-hide"
  );

  const onedriveFullAllowedToUsedDiv = onedriveFullDiv.createDiv();

  const onedriveFullSelectAuthDiv = onedriveFullAllowedToUsedDiv.createDiv();
  const onedriveFullAuthDiv = onedriveFullSelectAuthDiv.createDiv({
    cls: "onedrivefull-auth-button-hide settings-auth-related",
  });
  const onedriveFullRevokeAuthDiv = onedriveFullSelectAuthDiv.createDiv({
    cls: "onedrivefull-revoke-auth-button-hide settings-auth-related",
  });

  const savedOnedriveFullUsername = plugin.settings.onedrivefull?.username;

  const onedriveFullRevokeAuthSetting = new Setting(onedriveFullRevokeAuthDiv)
    .setName(savedOnedriveFullUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText(t("settings_onedrivefull_revoke_button"));
      button.setWarning();
      button.onClick(async () => {
        new OnedrivefullRevokeAuthModal(
          app,
          plugin,
          onedriveFullAuthDiv,
          onedriveFullRevokeAuthDiv,
          t
        ).open();
      });
    });
  if (savedOnedriveFullUsername) {
    onedriveFullRevokeAuthSetting.setDesc(savedOnedriveFullUsername);
  }

  new Setting(onedriveFullAuthDiv)
    .setName(t("settings_onedrivefull_auth"))
    .setDesc(t("settings_onedrivefull_auth_desc"))
    .addButton(async (button) => {
      button.setButtonText(t("settings_onedrivefull_auth_button"));
      button.onClick(async () => {
        const modal = new OnedrivefullAuthModal(
          app,
          plugin,
          onedriveFullAuthDiv,
          onedriveFullRevokeAuthDiv,
          onedriveFullRevokeAuthSetting,
          t
        );
        plugin.oauth2Info.helperModal = modal;
        plugin.oauth2Info.authDiv = onedriveFullAuthDiv;
        plugin.oauth2Info.revokeDiv = onedriveFullRevokeAuthDiv;
        plugin.oauth2Info.revokeAuthSetting = onedriveFullRevokeAuthSetting;
        modal.open();
      });
    });

  const isConnected = !!plugin.settings.onedrivefull?.username;
  onedriveFullAuthDiv.toggleClass("onedrivefull-auth-button-hide", isConnected);
  onedriveFullRevokeAuthDiv.toggleClass(
    "onedrivefull-revoke-auth-button-hide",
    !isConnected
  );

  // Remote folder — picker button + breadcrumb display.
  const currentOnedriveFullFolder =
    plugin.settings.onedrivefull.remoteBaseDir || app.vault.getName();
  const onedriveFullRemoteFolderSetting = new Setting(
    onedriveFullAllowedToUsedDiv
  ).setName(t("settings_remotebasedir"));
  renderFolderBreadcrumb(
    onedriveFullRemoteFolderSetting,
    "OneDrive",
    currentOnedriveFullFolder
  );
  onedriveFullRemoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "onedrivefull",
        providerLabel: "OneDrive",
      })
    );
  });

  new Setting(onedriveFullAllowedToUsedDiv)
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
          new Notice(t("settings_onedrivefull_connect_succ"));
        } else {
          new Notice(t("settings_onedrivefull_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return {
    onedriveFullDiv,
    onedriveFullAllowedToUsedDiv,
    onedriveFullNotShowUpHintSetting,
  };
};
