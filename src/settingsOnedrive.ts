import { SVG_ONEDRIVE } from './icons';
import { ONEDRIVE_CLIENT_ID, ONEDRIVE_AUTHORITY } from './baseTypes';
import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Platform, Setting } from "obsidian";
import {
  DEFAULT_ONEDRIVE_CONFIG,
  getAuthUrlAndVerifier,
} from "./fsOnedrive";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import { stringToFragment , setSvgTitle } from "./misc";
import {
  openFolderPickerForProvider,
  renderFolderBreadcrumb,
} from "./folderPicker";

class OnedriveAuthModal extends Modal {
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
    setSvgTitle(this.titleEl, SVG_ONEDRIVE, "Connect OneDrive Account");
    const { contentEl } = this;
    const t = this.t;

    const { authUrl, verifier } = await getAuthUrlAndVerifier(
      ONEDRIVE_CLIENT_ID,
      ONEDRIVE_AUTHORITY
    );
    this.plugin.oauth2Info.verifier = verifier;

    t("modal_onedriveauth_shortdesc")
      .split("\n")
      .forEach((val) => {
        contentEl.createEl("p", { text: val });
      });
    if (Platform.isLinux) {
      t("modal_onedriveauth_shortdesc_linux")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", {
            text: stringToFragment(val),
          });
        });
    }

    contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => {
      el.onclick = () => activeWindow.open(authUrl);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class OnedriveRevokeAuthModal extends Modal {
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
    this.modalEl.addClass("byoc-auth-modal");
    setSvgTitle(this.titleEl, SVG_ONEDRIVE, "Revoke OneDrive Account");
    const t = this.t;
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step1"),
    });
    const consentUrl = "https://microsoft.com/consent";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step2"),
    });

    new Setting(contentEl)
      .setName(t("modal_onedriverevokeauth_clean"))
      .setDesc(t("modal_onedriverevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_onedriverevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.onedrive = cloneDeep(DEFAULT_ONEDRIVE_CONFIG);
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "onedrive-auth-button-hide",
              this.plugin.settings.onedrive.username !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "onedrive-revoke-auth-button-hide",
              this.plugin.settings.onedrive.username === ""
            );
            new Notice(t("modal_onedriverevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_onedriverevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const generateOnedriveSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const onedriveDiv = containerEl.createEl("div", { cls: "onedrive-hide" });
  onedriveDiv.toggleClass(
    "onedrive-hide",
    plugin.settings.serviceType !== "onedrive"
  );
  setSvgTitle(new Setting(onedriveDiv).setHeading().nameEl, SVG_ONEDRIVE, "${t(\"settings_onedrive\")}");

  const onedriveNotShowUpHintSetting = new Setting(onedriveDiv);
  onedriveNotShowUpHintSetting.settingEl.addClass("onedrive-allow-to-use-hide");

  const onedriveAllowedToUsedDiv = onedriveDiv.createDiv();

  const onedriveSelectAuthDiv = onedriveAllowedToUsedDiv.createDiv();
  const onedriveAuthDiv = onedriveSelectAuthDiv.createDiv({
    cls: "onedrive-auth-button-hide settings-auth-related",
  });
  const onedriveRevokeAuthDiv = onedriveSelectAuthDiv.createDiv({
    cls: "onedrive-revoke-auth-button-hide settings-auth-related",
  });

  const savedOnedriveUsername = plugin.settings.onedrive?.username;

  const onedriveRevokeAuthSetting = new Setting(onedriveRevokeAuthDiv)
    .setName(savedOnedriveUsername ? "Logged in as" : "Connected")
    .addButton(async (button) => {
      button.setButtonText(t("settings_onedrive_revoke_button"));
      button.setWarning();
      button.onClick(async () => {
        new OnedriveRevokeAuthModal(
          app,
          plugin,
          onedriveAuthDiv,
          onedriveRevokeAuthDiv,
          t
        ).open();
      });
    });
  if (savedOnedriveUsername) {
    onedriveRevokeAuthSetting.setDesc(savedOnedriveUsername);
  }

  new Setting(onedriveAuthDiv)
    .setName("Connect OneDrive Account")
    .setDesc("Authenticate BYOC with your Microsoft OneDrive account to enable cloud synchronization.")
    .addButton(async (button) => {
      button.setButtonText("Authorize");
      button.setCta();
      button.onClick(async () => {
        const modal = new OnedriveAuthModal(
          app,
          plugin,
          onedriveAuthDiv,
          onedriveRevokeAuthDiv,
          onedriveRevokeAuthSetting,
          t
        );
        plugin.oauth2Info.helperModal = modal;
        plugin.oauth2Info.authDiv = onedriveAuthDiv;
        plugin.oauth2Info.revokeDiv = onedriveRevokeAuthDiv;
        plugin.oauth2Info.revokeAuthSetting = onedriveRevokeAuthSetting;
        modal.open();
      });
    });

  const isConnected = !!plugin.settings.onedrive?.username;
  onedriveAuthDiv.toggleClass("onedrive-auth-button-hide", isConnected);
  onedriveRevokeAuthDiv.toggleClass("onedrive-revoke-auth-button-hide", !isConnected);

  // Empty file handling
  new Setting(onedriveAllowedToUsedDiv)
    .setName(t("settings_onedrive_emptyfile"))
    .setDesc(t("settings_onedrive_emptyfile_desc"))
    .addDropdown(async (dropdown) => {
      dropdown
        .addOption("skip", t("settings_onedrive_emptyfile_skip"))
        .addOption("error", t("settings_onedrive_emptyfile_error"))
        .setValue(plugin.settings.onedrive.emptyFile)
        .onChange(async (val) => {
          plugin.settings.onedrive.emptyFile = val as any;
          await plugin.saveSettings();
        });
    });

  // Remote folder — picker button + breadcrumb display.
  const currentOnedriveFolder =
    plugin.settings.onedrive.remoteBaseDir || app.vault.getName();
  const onedriveRemoteFolderSetting = new Setting(onedriveAllowedToUsedDiv).setName(
    t("settings_remotebasedir")
  );
  renderFolderBreadcrumb(
    onedriveRemoteFolderSetting,
    "OneDrive",
    currentOnedriveFolder
  );
  onedriveRemoteFolderSetting.addButton((button) => {
    button.setButtonText("Change folder").setCta();
    button.onClick(() =>
      openFolderPickerForProvider({
        app,
        plugin,
        providerKey: "onedrive",
        providerLabel: "OneDrive",
      })
    );
  });

  new Setting(onedriveAllowedToUsedDiv)
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
          new Notice(t("settings_onedrive_connect_succ"));
        } else {
          new Notice(t("settings_onedrive_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return { onedriveDiv, onedriveAllowedToUsedDiv, onedriveNotShowUpHintSetting };
};
