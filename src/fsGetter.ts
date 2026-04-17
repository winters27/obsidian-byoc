/**
 * BYOC — Provider Factory
 * Resolves the active cloud provider from settings.
 * No imports from pro/ — all providers are local.
 */

import type { BYOCPluginSettings } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { FakeFsDropbox } from "./fsDropbox";
import { FakeFsOnedrive } from "./fsOnedrive";
import { FakeFsS3 } from "./fsS3";
import { FakeFsWebdav } from "./fsWebdav";
import { FakeFsWebdis } from "./fsWebdis";
import { FakeFsGoogleDrive } from "./fsGoogleDrive";
import { FakeFsPCloud } from "./fsPCloud";
import { FakeFsBox } from "./fsBox";
import { FakeFsYandexDisk } from "./fsYandexDisk";
import { FakeFsKoofr } from "./fsKoofr";
import { FakeFsAzureBlobStorage } from "./fsAzureBlobStorage";
import { FakeFsOnedriveFull } from "./fsOnedriveFull";

/**
 * Returns the appropriate FakeFs implementation for the configured provider.
 * To avoid circular dependency, this lives in a dedicated file.
 */
export function getClient(
  settings: BYOCPluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>
): FakeFs {
  switch (settings.serviceType) {
    case "s3":
      return new FakeFsS3(settings.s3);
    case "webdav":
      return new FakeFsWebdav(
        settings.webdav,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "dropbox":
      return new FakeFsDropbox(
        settings.dropbox,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "onedrive":
      return new FakeFsOnedrive(
        settings.onedrive,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "onedrivefull":
      return new FakeFsOnedriveFull(
        settings.onedrivefull,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "webdis":
      return new FakeFsWebdis(
        settings.webdis,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "googledrive":
      return new FakeFsGoogleDrive(
        settings.googledrive,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "box":
      return new FakeFsBox(settings.box, vaultName, saveUpdatedConfigFunc);
    case "pcloud":
      return new FakeFsPCloud(
        settings.pcloud,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "yandexdisk":
      return new FakeFsYandexDisk(
        settings.yandexdisk,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "koofr":
      return new FakeFsKoofr(settings.koofr, vaultName, saveUpdatedConfigFunc);
    case "azureblobstorage":
      return new FakeFsAzureBlobStorage(settings.azureblobstorage, vaultName);
    default:
      throw new Error(
        `[BYOC] Cannot init client for unknown serviceType: ${(settings as any).serviceType}`
      );
  }
}
