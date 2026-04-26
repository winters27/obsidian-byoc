/**
 * BYOC — Data Migration Module
 *
 * Handles seamless migration from `remotely-save` plugin configs
 * to the BYOC format. Runs once on first load, backs up original
 * data, and strips all credential expiry timers.
 *
 * Migration version history:
 *   0 → 1: Initial migration from remotely-save format
 */

import cloneDeep from "lodash/cloneDeep";
import { Notice, type Plugin } from "obsidian";
import type { BYOCPluginSettings } from "./baseTypes";
import { messyConfigToNormal } from "./configPersist";

/** Current migration version — bump when adding new migrations */
export const CURRENT_MIGRATION_VERSION = 1;

/** The old plugin's data directory name */
const LEGACY_PLUGIN_ID = "remotely-save";

/**
 * Checks if a legacy `remotely-save` plugin folder exists in the vault,
 * reads its data.json, decodes it, and returns the parsed settings.
 * Returns null if no legacy data found or if it can't be parsed.
 */
async function readLegacyConfig(
  plugin: Plugin
): Promise<Record<string, unknown> | null> {
  const legacyDataPath = `${plugin.app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}/data.json`;

  try {
    const exists = await plugin.app.vault.adapter.exists(legacyDataPath);
    if (!exists) {
      console.debug("[BYOC Migration] No legacy remotely-save data.json found.");
      return null;
    }

    const raw = await plugin.app.vault.adapter.read(legacyDataPath);
    const parsed = JSON.parse(raw);

    // The legacy plugin uses the same messy encoding (base64url reversed)
    const decoded = messyConfigToNormal(parsed);
    if (!decoded) {
      console.warn("[BYOC Migration] Legacy data.json decoded to null.");
      return null;
    }

    console.debug("[BYOC Migration] Successfully read legacy remotely-save config.");
    return decoded as unknown as Record<string, unknown>;
  } catch (err) {
    console.warn("[BYOC Migration] Failed to read legacy config:", err);
    return null;
  }
}

/**
 * Creates a backup of the current BYOC data.json before migration.
 * The backup is written to data.json.byoc-backup in the BYOC plugin dir.
 */
async function backupCurrentConfig(plugin: Plugin): Promise<void> {
  const pluginDir =
    plugin.manifest.dir ||
    `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  const dataPath = `${pluginDir}/data.json`;
  const backupPath = `${pluginDir}/data.json.byoc-backup`;

  try {
    const exists = await plugin.app.vault.adapter.exists(dataPath);
    if (exists) {
      const raw = await plugin.app.vault.adapter.read(dataPath);
      await plugin.app.vault.adapter.write(backupPath, raw);
      console.debug(`[BYOC Migration] Backed up data.json → ${backupPath}`);
    }
  } catch (err) {
    console.warn("[BYOC Migration] Failed to create backup:", err);
  }
}

/**
 * Strips all credential expiry timers from provider configs.
 * The old plugin had an 80-day nuke that force-deleted tokens.
 * BYOC keeps credentials indefinitely until manually revoked.
 */
function stripCredentialExpiry(settings: BYOCPluginSettings): void {
  // Dropbox
  if (settings.dropbox?.credentialsShouldBeDeletedAtTime) {
    delete settings.dropbox.credentialsShouldBeDeletedAtTime;
  }

  // OneDrive
  if (settings.onedrive?.credentialsShouldBeDeletedAtTime) {
    delete settings.onedrive.credentialsShouldBeDeletedAtTime;
  }

  // OneDrive Full
  if (settings.onedrivefull?.credentialsShouldBeDeletedAtTime) {
    delete settings.onedrivefull.credentialsShouldBeDeletedAtTime;
  }

  // Google Drive
  if (settings.googledrive?.credentialsShouldBeDeletedAtTimeMs) {
    delete settings.googledrive.credentialsShouldBeDeletedAtTimeMs;
  }

  // Box
  if (settings.box?.credentialsShouldBeDeletedAtTimeMs) {
    delete settings.box.credentialsShouldBeDeletedAtTimeMs;
  }

  // pCloud
  if (settings.pcloud?.credentialsShouldBeDeletedAtTimeMs) {
    delete settings.pcloud.credentialsShouldBeDeletedAtTimeMs;
  }

  // Yandex Disk
  if (settings.yandexdisk?.credentialsShouldBeDeletedAtTimeMs) {
    delete settings.yandexdisk.credentialsShouldBeDeletedAtTimeMs;
  }

  // Koofr
  if (settings.koofr?.credentialsShouldBeDeletedAtTimeMs) {
    delete settings.koofr.credentialsShouldBeDeletedAtTimeMs;
  }
}

/**
 * Extracts provider configs that lived under the `pro` key in the
 * legacy plugin and promotes them to top-level fields in BYOC settings.
 */
function extractProConfigs(
  legacyConfig: Record<string, unknown>,
  settings: BYOCPluginSettings
): void {
  const proRaw = legacyConfig.pro;
  if (!proRaw || typeof proRaw !== "object") return;
  const pro = proRaw as Record<string, unknown>;

  // The pro object could contain nested provider configs
  // Map known pro fields to their BYOC top-level equivalents
  const providerMap: Record<string, keyof BYOCPluginSettings> = {
    googledrive: "googledrive",
    box: "box",
    pcloud: "pcloud",
    yandexdisk: "yandexdisk",
    koofr: "koofr",
    azureblobstorage: "azureblobstorage",
    onedrivefull: "onedrivefull",
  };

  for (const [proKey, settingsKey] of Object.entries(providerMap)) {
    if (pro[proKey] && typeof pro[proKey] === "object") {
      // Only merge if the current config is empty/default
      const current = settings[settingsKey] as Record<string, unknown> | undefined;
      const incoming = pro[proKey] as Record<string, unknown>;

      // Check if incoming has real data (e.g., a non-empty accessToken)
      const hasRealData =
        incoming.accessToken ||
        incoming.refreshToken ||
        incoming.containerSasUrl;

      if (hasRealData) {
        (settings as unknown as Record<string, unknown>)[settingsKey] = {
          ...((current) || {}),
          ...cloneDeep(incoming),
        };
        console.debug(
          `[BYOC Migration] Promoted pro.${proKey} config to top-level.`
        );
      }
    }
  }

  // Also check if pro had feature flags we can learn from
  if (pro.enabledProFeatures && Array.isArray(pro.enabledProFeatures)) {
    console.debug(
      `[BYOC Migration] Legacy pro features detected: ${pro.enabledProFeatures.join(", ")}. All features enabled in BYOC by default.`
    );
  }
}

/**
 * Merges legacy remotely-save settings into the current BYOC settings.
 * Preserves existing BYOC values — only fills in fields that are
 * empty/default in BYOC but have real data in the legacy config.
 */
function mergeLegacyIntoSettings(
  legacyConfig: Record<string, unknown>,
  settings: BYOCPluginSettings
): void {
  // Core provider configs that exist at top level in both old and new
  const directProviders = [
    "s3",
    "webdav",
    "dropbox",
    "onedrive",
    "webdis",
  ] as const;

  for (const provider of directProviders) {
    const legacyRaw = legacyConfig[provider];
    if (!legacyRaw || typeof legacyRaw !== "object") continue;
    const legacy = legacyRaw as Record<string, unknown>;

    const current = settings[provider] as unknown as Record<string, unknown> | undefined;
    if (!current) continue;

    // Check if legacy has meaningful credentials
    const hasCredentials =
      legacy.accessToken ||
      legacy.refreshToken ||
      legacy.s3AccessKeyID ||
      legacy.address ||
      legacy.password;

    if (hasCredentials) {
      // Merge legacy into current, legacy values fill gaps
      for (const [key, value] of Object.entries(legacy)) {
        if (
          value !== undefined &&
          value !== null &&
          value !== "" &&
          (current[key] === undefined ||
            current[key] === null ||
            current[key] === "")
        ) {
          current[key] = cloneDeep(value);
        }
      }
      console.debug(
        `[BYOC Migration] Merged legacy ${provider} credentials.`
      );
    }
  }

  // Scalar settings — only copy if BYOC has the default value
  const scalarFields: Array<{
    key: keyof BYOCPluginSettings;
    defaultVal: unknown;
  }> = [
    { key: "serviceType", defaultVal: "s3" },
    { key: "password", defaultVal: "" },
    { key: "currLogLevel", defaultVal: "info" },
    { key: "autoRunEveryMilliseconds", defaultVal: -1 },
    { key: "initRunAfterMilliseconds", defaultVal: -1 },
    { key: "syncOnSaveAfterMilliseconds", defaultVal: -1 },
    { key: "concurrency", defaultVal: 5 },
    { key: "syncConfigDir", defaultVal: false },
    { key: "syncBookmarks", defaultVal: false },
    { key: "skipSizeLargerThan", defaultVal: -1 },
    { key: "ignorePaths", defaultVal: [] },
    { key: "onlyAllowPaths", defaultVal: [] },
    { key: "deleteToWhere", defaultVal: "system" },
    { key: "conflictAction", defaultVal: "keep_newer" },
    { key: "protectModifyPercentage", defaultVal: 50 },
    { key: "syncDirection", defaultVal: "bidirectional" },
    { key: "encryptionMethod", defaultVal: "unknown" },
  ];

  for (const { key, defaultVal } of scalarFields) {
    const legacyVal = legacyConfig[key];
    const currentVal = settings[key];

    if (legacyVal !== undefined && legacyVal !== null) {
      // Only overwrite if BYOC still has the default
      const isDefault =
        Array.isArray(defaultVal)
          ? Array.isArray(currentVal) && (currentVal as unknown[]).length === 0
          : currentVal === defaultVal;

      if (isDefault) {
        (settings as unknown as Record<string, unknown>)[key] = cloneDeep(legacyVal);
      }
    }
  }

  // Extract pro-gated provider configs
  extractProConfigs(legacyConfig, settings);
}

/**
 * Main migration entry point. Called from plugin.onload() AFTER
 * loadSettings() has already run. This means settings already has
 * defaults applied — we're layering legacy data on top.
 *
 * Returns true if migration was performed.
 */
export async function runMigration(
  plugin: Plugin,
  settings: BYOCPluginSettings
): Promise<boolean> {
  const currentVersion = settings.migrationVersion ?? 0;

  if (currentVersion >= CURRENT_MIGRATION_VERSION) {
    // Already migrated, nothing to do
    return false;
  }

  console.debug(
    `[BYOC Migration] Running migration v${currentVersion} → v${CURRENT_MIGRATION_VERSION}`
  );

  // Step 1: Backup existing BYOC data.json
  await backupCurrentConfig(plugin);

  // Step 2: Read legacy remotely-save config
  const legacyConfig = await readLegacyConfig(plugin);

  if (legacyConfig) {
    // Step 3: Merge legacy data into current settings
    mergeLegacyIntoSettings(legacyConfig, settings);

    // Step 4: Strip all credential expiry timers
    stripCredentialExpiry(settings);

    // Step 5: Clean up deprecated pro field
    if ("pro" in settings) {
      delete (settings as unknown as Record<string, unknown>).pro;
    }

    new Notice(
      "[BYOC] Migrated settings from Remotely Save. Your old config is backed up.",
      8000
    );
    console.debug("[BYOC Migration] Migration from remotely-save complete.");
  } else {
    // No legacy config found, but still strip expiry timers
    // in case user manually copied settings
    stripCredentialExpiry(settings);
    console.debug("[BYOC Migration] No legacy config found. Applied defaults.");
  }

  // Step 6: Stamp migration version
  settings.migrationVersion = CURRENT_MIGRATION_VERSION;

  return true;
}
