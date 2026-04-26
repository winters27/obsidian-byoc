/**
 * BYOC — Base Types
 * Inlines all PRO config interfaces. No imports from pro/.
 */

import type { LangTypeAndAuto } from "./i18n";

declare global {
  var DEFAULT_DROPBOX_APP_KEY: string;
  var DEFAULT_ONEDRIVE_CLIENT_ID: string;
  var DEFAULT_ONEDRIVE_AUTHORITY: string;
  var DEFAULT_GOOGLEDRIVE_CLIENT_ID: string;
  var DEFAULT_GOOGLEDRIVE_CLIENT_SECRET: string;
  var DEFAULT_BOX_CLIENT_ID: string;
  var DEFAULT_BOX_CLIENT_SECRET: string;
  var DEFAULT_PCLOUD_CLIENT_ID: string;
  var DEFAULT_PCLOUD_CLIENT_SECRET: string;
  var DEFAULT_YANDEXDISK_CLIENT_ID: string;
  var DEFAULT_YANDEXDISK_CLIENT_SECRET: string;
  var DEFAULT_KOOFR_CLIENT_ID: string;
  var DEFAULT_KOOFR_CLIENT_SECRET: string;
}

// These globals are injected by webpack's DefinePlugin at build time, not
// related to popout windows. The activeWindow/activeDocument rule doesn't
// apply to module-load-time constants.
/* eslint-disable obsidianmd/prefer-active-doc */
export const DROPBOX_APP_KEY = globalThis.DEFAULT_DROPBOX_APP_KEY || "";
export const ONEDRIVE_CLIENT_ID = globalThis.DEFAULT_ONEDRIVE_CLIENT_ID || "";
export const ONEDRIVE_AUTHORITY = globalThis.DEFAULT_ONEDRIVE_AUTHORITY || "https://login.microsoftonline.com/consumers/";
export const GOOGLEDRIVE_CLIENT_ID = globalThis.DEFAULT_GOOGLEDRIVE_CLIENT_ID || "";
export const GOOGLEDRIVE_CLIENT_SECRET = globalThis.DEFAULT_GOOGLEDRIVE_CLIENT_SECRET || "";
export const BOX_CLIENT_ID = globalThis.DEFAULT_BOX_CLIENT_ID || "";
export const BOX_CLIENT_SECRET = globalThis.DEFAULT_BOX_CLIENT_SECRET || "";
export const PCLOUD_CLIENT_ID = globalThis.DEFAULT_PCLOUD_CLIENT_ID || "";
export const PCLOUD_CLIENT_SECRET = globalThis.DEFAULT_PCLOUD_CLIENT_SECRET || "";
export const YANDEXDISK_CLIENT_ID = globalThis.DEFAULT_YANDEXDISK_CLIENT_ID || "";
export const YANDEXDISK_CLIENT_SECRET = globalThis.DEFAULT_YANDEXDISK_CLIENT_SECRET || "";
export const KOOFR_CLIENT_ID = globalThis.DEFAULT_KOOFR_CLIENT_ID || "";
export const KOOFR_CLIENT_SECRET = globalThis.DEFAULT_KOOFR_CLIENT_SECRET || "";
/* eslint-enable obsidianmd/prefer-active-doc */

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export type SUPPORTED_SERVICES_TYPE =
  | "s3"
  | "webdav"
  | "dropbox"
  | "onedrive"
  | "onedrivefull"
  | "webdis"
  | "googledrive"
  | "box"
  | "pcloud"
  | "yandexdisk"
  | "koofr"
  | "azureblobstorage";

export type SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR = Exclude<
  SUPPORTED_SERVICES_TYPE,
  "s3" | "azureblobstorage"
>;

export interface S3Config {
  s3Endpoint: string;
  s3Region: string;
  s3AccessKeyID: string;
  s3SecretAccessKey: string;
  s3BucketName: string;
  partsConcurrency?: number;
  forcePathStyle?: boolean;
  remotePrefix?: string;
  useAccurateMTime?: boolean;
  reverseProxyNoSignUrl?: string;
  generateFolderObject?: boolean;
  /** @deprecated */
  bypassCorsLocally?: boolean;
}

export interface DropboxConfig {
  accessToken: string;
  clientID: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  accountID: string;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  remoteBaseDir?: string;
}

export type WebdavAuthType = "digest" | "basic";
export type WebdavDepthType =
  | "auto"
  | "auto_unknown"
  | "auto_1"
  | "auto_infinity"
  | "manual_1"
  | "manual_infinity";

export interface WebdavConfig {
  address: string;
  username: string;
  password: string;
  authType: WebdavAuthType;
  depth?: WebdavDepthType;
  remoteBaseDir?: string;
  customHeaders?: string;
  /** @deprecated */
  manualRecursive: boolean;
}

export interface OnedriveConfig {
  accessToken: string;
  clientID: string;
  authority: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  deltaLink: string;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  remoteBaseDir?: string;
  emptyFile: "skip" | "error";
  kind: "onedrive";
}

export interface WebdisConfig {
  address: string;
  username?: string;
  password?: string;
  remoteBaseDir?: string;
}

// ─── PRO PROVIDER CONFIGS (inlined from baseTypesPro — clean-room) ───────────

export interface GoogleDriveConfig {
  accessToken: string;
  accessTokenExpiresInMs: number;
  accessTokenExpiresAtTimeMs: number;
  refreshToken: string;
  remoteBaseDir?: string;
  credentialsShouldBeDeletedAtTimeMs?: number;
  scope: "https://www.googleapis.com/auth/drive.file";
  username?: string;
  kind: "googledrive";
}

export interface BoxConfig {
  accessToken: string;
  accessTokenExpiresInMs: number;
  accessTokenExpiresAtTimeMs: number;
  refreshToken: string;
  remoteBaseDir?: string;
  credentialsShouldBeDeletedAtTimeMs?: number;
  username?: string;
  kind: "box";
}

export interface PCloudConfig {
  accessToken: string;
  username?: string;
  hostname: "eapi.pcloud.com" | "api.pcloud.com";
  locationid: 1 | 2;
  remoteBaseDir?: string;
  credentialsShouldBeDeletedAtTimeMs?: number;
  kind: "pcloud";
  /** @deprecated */
  emptyFile: "skip" | "error";
}

export interface YandexDiskConfig {
  accessToken: string;
  accessTokenExpiresInMs: number;
  accessTokenExpiresAtTimeMs: number;
  refreshToken: string;
  remoteBaseDir?: string;
  credentialsShouldBeDeletedAtTimeMs?: number;
  scope: string;
  username?: string;
  kind: "yandexdisk";
}

export interface KoofrConfig {
  accessToken: string;
  accessTokenExpiresInMs: number;
  accessTokenExpiresAtTimeMs: number;
  refreshToken: string;
  remoteBaseDir?: string;
  credentialsShouldBeDeletedAtTimeMs?: number;
  scope: string;
  api: string;
  mountID: string;
  username?: string;
  kind: "koofr";
}

export interface AzureBlobStorageConfig {
  containerSasUrl: string;
  containerName: string;
  remotePrefix: string;
  generateFolderObject: boolean;
  partsConcurrency: number;
  kind: "azureblobstorage";
}

export interface OnedriveFullConfig {
  accessToken: string;
  clientID: string;
  authority: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  deltaLink: string;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  remoteBaseDir?: string;
  emptyFile: "skip" | "error";
  kind: "onedrivefull";
}

// ─────────────────────────────────────────────────────────────────────────────

export type SyncDirectionType =
  | "bidirectional"
  | "incremental_pull_only"
  | "incremental_push_only"
  | "incremental_pull_and_delete_only"
  | "incremental_push_and_delete_only";

export type CipherMethodType = "rclone-base64" | "openssl-base64" | "unknown";

export type QRExportType = "basic_and_advanced" | SUPPORTED_SERVICES_TYPE;

export interface ProfilerConfig {
  enable?: boolean;
  enablePrinting?: boolean;
  recordSize?: boolean;
}

export interface BYOCPluginSettings {
  s3: S3Config;
  webdav: WebdavConfig;
  dropbox: DropboxConfig;
  onedrive: OnedriveConfig;
  onedrivefull: OnedriveFullConfig;
  webdis: WebdisConfig;
  googledrive: GoogleDriveConfig;
  box: BoxConfig;
  pcloud: PCloudConfig;
  yandexdisk: YandexDiskConfig;
  koofr: KoofrConfig;
  azureblobstorage: AzureBlobStorageConfig;

  password: string;
  serviceType: SUPPORTED_SERVICES_TYPE;
  currLogLevel?: string;
  autoRunEveryMilliseconds?: number;
  initRunAfterMilliseconds?: number;
  syncOnSaveAfterMilliseconds?: number;

  concurrency?: number;
  syncConfigDir?: boolean;
  syncBookmarks?: boolean;
  syncUnderscoreItems?: boolean;
  lang?: LangTypeAndAuto;
  agreeToUseSyncV3?: boolean;
  skipSizeLargerThan?: number;
  ignorePaths?: string[];
  onlyAllowPaths?: string[];
  enableStatusBarInfo?: boolean;
  deleteToWhere?: "system" | "obsidian";
  conflictAction?: ConflictActionType;

  protectModifyPercentage?: number;
  syncDirection?: SyncDirectionType;

  obfuscateSettingFile?: boolean;

  encryptionMethod?: CipherMethodType;

  profiler?: ProfilerConfig;

  /** Migration version — tracks which migration has been applied */
  migrationVersion?: number;

  /** @deprecated */
  agreeToUploadExtraMetadata?: boolean;
  /** @deprecated */
  vaultRandomID?: string;
  /** @deprecated */
  logToDB?: boolean;
  /** @deprecated */
  howToCleanEmptyFolder?: EmptyFolderCleanType;
  /** @deprecated - removed in BYOC, kept for migration compat */
  pro?: Record<string, unknown>;
}

export const PLUGIN_ID = "obsidian-byoc";
export const PLUGIN_NAME = "BYOC";

// ─── URI / Callback Constants ─────────────────────────────────────────────────

/** Primary URI for BYOC */
export const COMMAND_URI = "bring-your-own-cloud";
/** Legacy alias — accepts old remotely-save:// links */
export const COMMAND_URI_LEGACY = "remotely-save";
export const COMMAND_CALLBACK = "bring-your-own-cloud-cb";
export const COMMAND_CALLBACK_ONEDRIVE = "bring-your-own-cloud-cb-onedrive";
export const COMMAND_CALLBACK_DROPBOX = "bring-your-own-cloud-cb-dropbox";
export const COMMAND_CALLBACK_ONEDRIVEFULL = "bring-your-own-cloud-cb-onedrivefull";
export const COMMAND_CALLBACK_BOX = "bring-your-own-cloud-cb-box";
export const COMMAND_CALLBACK_PCLOUD = "bring-your-own-cloud-cb-pcloud";
export const COMMAND_CALLBACK_YANDEXDISK = "bring-your-own-cloud-cb-yandexdisk";
export const COMMAND_CALLBACK_KOOFR = "bring-your-own-cloud-cb-koofr";
export const COMMAND_CALLBACK_GOOGLEDRIVE = "bring-your-own-cloud-cb-googledrive";

export interface UriParams {
  func?: string;
  vault?: string;
  ver?: string;
  data?: string;
}

export type EmptyFolderCleanType = "skip" | "clean_both";

export type ConflictActionType =
  | "keep_newer"
  | "keep_larger"
  | "smart_conflict";

export type DecisionTypeForMixedEntity =
  | "only_history"
  | "equal"
  | "local_is_modified_then_push"
  | "remote_is_modified_then_pull"
  | "local_is_created_then_push"
  | "remote_is_created_then_pull"
  | "local_is_created_too_large_then_do_nothing"
  | "remote_is_created_too_large_then_do_nothing"
  | "local_is_deleted_thus_also_delete_remote"
  | "remote_is_deleted_thus_also_delete_local"
  | "conflict_created_then_keep_local"
  | "conflict_created_then_keep_remote"
  | "conflict_created_then_smart_conflict"
  | "conflict_created_then_do_nothing"
  | "conflict_modified_then_keep_local"
  | "conflict_modified_then_keep_remote"
  | "conflict_modified_then_smart_conflict"
  | "folder_existed_both_then_do_nothing"
  | "folder_existed_local_then_also_create_remote"
  | "folder_existed_remote_then_also_create_local"
  | "folder_to_be_created"
  | "folder_to_skip"
  | "folder_to_be_deleted_on_both"
  | "folder_to_be_deleted_on_remote"
  | "folder_to_be_deleted_on_local"
  // ── Rename detections (post-planner pass) ─────────────────────────────────
  | "rename_local_to_remote"   // Local rename: update remote to match
  | "rename_remote_to_local";  // Remote rename: update local to match

/**
 * Uniform representation of a file/folder entity.
 * Everything should be flat and primitive so it can be copied.
 */
export interface Entity {
  key?: string;
  keyEnc?: string;
  keyRaw: string;
  mtimeCli?: number;
  mtimeCliFmt?: string;
  ctimeCli?: number;
  ctimeCliFmt?: string;
  mtimeSvr?: number;
  mtimeSvrFmt?: string;
  prevSyncTime?: number;
  prevSyncTimeFmt?: string;
  size?: number;
  sizeEnc?: number;
  sizeRaw: number;
  hash?: string;
  etag?: string;
  synthesizedFolder?: boolean;
  synthesizedFile?: boolean;
}

export interface UploadedType {
  entity: Entity;
  mtimeCli?: number;
}

export interface MixedEntity {
  key: string;
  local?: Entity;
  prevSync?: Entity;
  remote?: Entity;

  decisionBranch?: number;
  decision?: DecisionTypeForMixedEntity;
  conflictAction?: ConflictActionType;

  /** For rename decisions: the original (old) path the file was renamed FROM. */
  renameFrom?: string;

  change?: boolean;
  sideNotes?: any;
}

/** @deprecated */
export interface FileOrFolderMixedState {
  key: string;
  existLocal?: boolean;
  existRemote?: boolean;
  mtimeLocal?: number;
  mtimeRemote?: number;
  deltimeLocal?: number;
  deltimeRemote?: number;
  sizeLocal?: number;
  sizeLocalEnc?: number;
  sizeRemote?: number;
  sizeRemoteEnc?: number;
  changeRemoteMtimeUsingMapping?: boolean;
  changeLocalMtimeUsingMapping?: boolean;
  decision?: string;
  decisionBranch?: number;
  syncDone?: "done";
  remoteEncryptedKey?: string;
  mtimeLocalFmt?: string;
  mtimeRemoteFmt?: string;
  deltimeLocalFmt?: string;
  deltimeRemoteFmt?: string;
}

export const DEFAULT_DEBUG_FOLDER = "_debug_byoc/";
export const DEFAULT_SYNC_PLANS_HISTORY_FILE_PREFIX = "sync_plans_hist_exported_on_";
export const DEFAULT_LOG_HISTORY_FILE_PREFIX = "log_hist_exported_on_";
export const DEFAULT_PROFILER_RESULT_FILE_PREFIX = "profiler_results_exported_on_";

export type SyncTriggerSourceType =
  | "manual"
  | "dry"
  | "auto"
  | "auto_once_init"
  | "auto_sync_on_save";

export const REMOTELY_SAVE_VERSION_2022 = "0.3.25";
export const REMOTELY_SAVE_VERSION_2024PREPARE = "0.3.32";
export const BYOC_VERSION_1_0_0 = "1.0.0";

/** Smart conflict merge threshold: files larger than this use duplicate strategy */
export const SMART_CONFLICT_MERGE_SIZE_LIMIT = 1_000_000; // 1 MB
