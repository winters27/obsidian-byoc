import { SVG_AZURE } from './icons';
import { type App, Notice, Setting } from "obsidian";
import { getClient } from "./fsGetter";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import { setSvgTitle } from "./misc";

export const generateAzureBlobStorageSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  const azureBlobStorageDiv = containerEl.createEl("div", {
    cls: "azureblobstorage-hide",
  });
  azureBlobStorageDiv.toggleClass(
    "azureblobstorage-hide",
    plugin.settings.serviceType !== "azureblobstorage"
  );
  setSvgTitle(new Setting(azureBlobStorageDiv).setHeading().nameEl, SVG_AZURE, t("settings_azureblobstorage"));

  const azureDescDiv = azureBlobStorageDiv.createEl("div", {
    cls: "settings-long-desc",
  });
  azureDescDiv.createEl("p", {
    text: "Authenticate with a secure Container SAS URL. BYOC requires List, Read, Write, and Delete permissions to fully synchronize your vault in Azure.",
    cls: "azureblobstorage-disclaimer"
  });

  const azureBlobStorageNotShowUpHintSetting = new Setting(azureBlobStorageDiv);
  azureBlobStorageNotShowUpHintSetting.settingEl.addClass(
    "azureblobstorage-allow-to-use-hide"
  );

  const azureBlobStorageAllowedToUsedDiv = azureBlobStorageDiv.createDiv();

  new Setting(azureBlobStorageAllowedToUsedDiv)
    .setName("Container SAS URL")
    .setDesc("Enter your full Shared Access Signature URL ending in ?sv=... Ensure it targets a container, not a specific blob, and allows read/write/list/delete.")
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
    .setName("Base Directory / Prefix")
    .setDesc("A virtual directory within the container to isolate your vault data. Defaults to your vault name if left blank.")
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
    .setName("Generate Empty Folder Blobs")
    .setDesc("Creates 0-byte blobs ending with '/' to emulate folders. Required for compatibility with some S3/blob browsers, but technically unnecessary for BYOC.")
    .addDropdown((dropdown) =>
      dropdown
        .addOption(
          "false",
          "No (Recommended)"
        )
        .addOption(
          "true",
          "Yes"
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
    .setName("Test Connection")
    .setDesc("Verify that BYOC can successfully contact Azure and read your container using the SAS URL provided.")
    .addButton(async (button) => {
      button.setButtonText("Check Connectivity");
      button.setCta();
      button.onClick(async () => {
        new Notice("Checking Azure connection...");
        const client = getClient(plugin.settings, app.vault.getName(), () =>
          plugin.saveSettings()
        );
        const errors = { msg: "" };
        const res = await client.checkConnect((err: unknown) => {
          errors.msg = err instanceof Error ? err.message : String(err);
        });
        if (res) {
          new Notice("Azure Blob connection successful!");
        } else {
          new Notice("Azure Blob connection failed.");
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
