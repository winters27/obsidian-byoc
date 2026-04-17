import { SVG_AZURE } from './icons';
import { type App, Notice, Setting } from "obsidian";
import { DEFAULT_AZUREBLOBSTORAGE_CONFIG } from "./fsAzureBlobStorage";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";

export const generateAzureBlobStorageSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: any) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  const azureBlobStorageDiv = containerEl.createEl("div", {
    cls: "azureblobstorage-hide",
  });
  azureBlobStorageDiv.toggleClass(
    "azureblobstorage-hide",
    plugin.settings.serviceType !== "azureblobstorage"
  );
  azureBlobStorageDiv.createEl("h2", { cls: "byoc-provider-heading" }).innerHTML = `${SVG_AZURE} <span>${t("settings_azureblobstorage")}</span>`;

  const azureDescDiv = azureBlobStorageDiv.createEl("div", {
    cls: "settings-long-desc",
  });
  azureDescDiv.createEl("p", {
    text: t("settings_azureblobstorage_disclaimer"),
    cls: "azureblobstorage-disclaimer"
  });

  const azureBlobStorageNotShowUpHintSetting = new Setting(azureBlobStorageDiv);
  azureBlobStorageNotShowUpHintSetting.settingEl.addClass(
    "azureblobstorage-allow-to-use-hide"
  );

  const azureBlobStorageAllowedToUsedDiv = azureBlobStorageDiv.createDiv();

  new Setting(azureBlobStorageAllowedToUsedDiv)
    .setName(t("settings_azureblobstorage_sasurl"))
    .setDesc(t("settings_azureblobstorage_sasurl_desc"))
    .addText((text) => {
      text
        .setPlaceholder("https://account.blob.core.windows.net/container?...")
        .setValue(plugin.settings.azureblobstorage.containerSasUrl)
        .onChange(async (val) => {
          plugin.settings.azureblobstorage.containerSasUrl = val.trim();
          await saveUpdatedConfigFunc?.();
        });
      text.inputEl.type = "password";
    });

  new Setting(azureBlobStorageAllowedToUsedDiv)
    .setName(t("settings_azureblobstorage_prefix"))
    .setDesc(t("settings_azureblobstorage_prefix_desc"))
    .addText((text) =>
      text
        .setPlaceholder(app.vault.getName())
        .setValue(plugin.settings.azureblobstorage.remotePrefix)
        .onChange(async (val) => {
          plugin.settings.azureblobstorage.remotePrefix = val.trim();
          await saveUpdatedConfigFunc?.();
        })
    );

  new Setting(azureBlobStorageAllowedToUsedDiv)
    .setName(t("settings_azureblobstorage_generatefolderobject"))
    .setDesc(t("settings_azureblobstorage_generatefolderobject_desc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption(
          "false",
          t("settings_azureblobstorage_generatefolderobject_notgenerate")
        )
        .addOption(
          "true",
          t("settings_azureblobstorage_generatefolderobject_generate")
        )
        .setValue(
          plugin.settings.azureblobstorage.generateFolderObject
            ? "true"
            : "false"
        )
        .onChange(async (val) => {
          plugin.settings.azureblobstorage.generateFolderObject = val === "true";
          await saveUpdatedConfigFunc?.();
        })
    );

  new Setting(azureBlobStorageAllowedToUsedDiv)
    .setName(t("settings_azureblobstorage_parts"))
    .setDesc(t("settings_azureblobstorage_parts_desc"))
    .addText((text) =>
      text
        .setPlaceholder("5")
        .setValue(
          `${plugin.settings.azureblobstorage.partsConcurrency ?? 5}`
        )
        .onChange(async (val) => {
          const n = parseInt(val);
          if (!isNaN(n) && n > 0) {
            plugin.settings.azureblobstorage.partsConcurrency = n;
            await saveUpdatedConfigFunc?.();
          }
        })
    );

  new Setting(azureBlobStorageAllowedToUsedDiv)
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
          new Notice(t("settings_azureblobstorage_connect_succ"));
        } else {
          new Notice(t("settings_azureblobstorage_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return {
    azureBlobStorageDiv,
    azureBlobStorageAllowedToUsedDiv,
    azureBlobStorageNotShowUpHintSetting,
  };
};
