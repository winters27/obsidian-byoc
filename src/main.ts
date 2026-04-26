// biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
import AggregateError from "aggregate-error";
import cloneDeep from "lodash/cloneDeep";
import debounce from "lodash/debounce";
import { FileText, RefreshCcw, RotateCcw, createElement } from "lucide";
import {
  Events,
  FileSystemAdapter,
  type Modal,
  Notice,
  Platform,
  Plugin,
  type Setting,
  TFolder,
  addIcon,
  requireApiVersion,
  setIcon,
} from "obsidian";
import type {
  BYOCPluginSettings,
  SyncTriggerSourceType,
} from "./baseTypes";
import {
  COMMAND_CALLBACK,
  COMMAND_CALLBACK_DROPBOX,
  COMMAND_CALLBACK_ONEDRIVE,
  COMMAND_CALLBACK_ONEDRIVEFULL,
  COMMAND_CALLBACK_BOX,
  COMMAND_CALLBACK_PCLOUD,
  COMMAND_CALLBACK_YANDEXDISK,
  COMMAND_CALLBACK_KOOFR,
  COMMAND_CALLBACK_GOOGLEDRIVE,
  COMMAND_URI,
  COMMAND_URI_LEGACY,
} from "./baseTypes";
import { API_VER_ENSURE_REQURL_OK } from "./baseTypesObs";
import { messyConfigToNormal, normalConfigToMessy } from "./configPersist";
import { exportVaultSyncPlansToFiles } from "./debugMode";
import {
  DEFAULT_DROPBOX_CONFIG,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceDropbox,
} from "./fsDropbox";
import { FakeFsEncrypt } from "./fsEncrypt";
import { getClient } from "./fsGetter";
import { FakeFsLocal } from "./fsLocal";
import {
  type AccessCodeResponseSuccessfulType as AccessCodeResponseSuccessfulTypeOnedrive,
  DEFAULT_ONEDRIVE_CONFIG,
  sendAuthReq as sendAuthReqOnedrive,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceOnedrive,
} from "./fsOnedrive";
import { DEFAULT_S3_CONFIG } from "./fsS3";
import { DEFAULT_WEBDAV_CONFIG } from "./fsWebdav";
import { DEFAULT_WEBDIS_CONFIG } from "./fsWebdis";

// --- BYOC Local Provider Imports (no pro/) ---
import {
  DEFAULT_GOOGLEDRIVE_CONFIG,
  sendAuthReq as sendAuthReqGoogleDrive,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceGoogleDrive,
} from "./fsGoogleDrive";
import {
  DEFAULT_BOX_CONFIG,
  sendAuthReq as sendAuthReqBox,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceBox,
} from "./fsBox";
import {
  DEFAULT_PCLOUD_CONFIG,
  type AuthAllowFirstRes as AuthAllowFirstResPCloud,
  generateAuthUrl as generateAuthUrlPCloud,
  sendAuthReq as sendAuthReqPCloud,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplacePCloud,
} from "./fsPCloud";
import {
  DEFAULT_YANDEXDISK_CONFIG,
  sendAuthReq as sendAuthReqYandexDisk,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceYandexDisk,
} from "./fsYandexDisk";
import {
  DEFAULT_KOOFR_CONFIG,
  sendAuthReq as sendAuthReqKoofr,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceKoofr,
} from "./fsKoofr";
import { DEFAULT_AZUREBLOBSTORAGE_CONFIG } from "./fsAzureBlobStorage";
import {
  type AccessCodeResponseSuccessfulType as AccessCodeResponseSuccessfulTypeOnedriveFull,
  DEFAULT_ONEDRIVEFULL_CONFIG,
  sendAuthReq as sendAuthReqOnedriveFull,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceOnedriveFull,
} from "./fsOnedriveFull";

// --- Sync Engine (stub in Batch 0, real implementation in Batch 2) ---
import { syncer } from "./sync/syncer";

// --- Data Migration (Batch 4) ---
import { runMigration } from "./migration";

import { I18n } from "./i18n";
import type { LangTypeAndAuto, TransItemType } from "./i18n";
import { importQrCodeUri } from "./importExport";
import {
  type InternalDBs,
  clearAllLoggerOutputRecords,
  clearExpiredSyncPlanRecords,
  getLastFailedSyncTimeByVault,
  getLastSuccessSyncTimeByVault,
  prepareDBs,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessSyncTimeByVault,
  upsertPluginVersionByVault,
} from "./localdb";
import { DEFAULT_PROFILER_CONFIG, Profiler } from "./profiler";
import { BYOCSettingTab } from "./settings";
import { openFolderPickerForProvider } from "./folderPicker";

// ─── Default Settings ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: BYOCPluginSettings = {
  s3: DEFAULT_S3_CONFIG,
  webdav: DEFAULT_WEBDAV_CONFIG,
  dropbox: DEFAULT_DROPBOX_CONFIG,
  onedrive: DEFAULT_ONEDRIVE_CONFIG,
  onedrivefull: DEFAULT_ONEDRIVEFULL_CONFIG,
  webdis: DEFAULT_WEBDIS_CONFIG,
  googledrive: DEFAULT_GOOGLEDRIVE_CONFIG,
  box: DEFAULT_BOX_CONFIG,
  pcloud: DEFAULT_PCLOUD_CONFIG,
  yandexdisk: DEFAULT_YANDEXDISK_CONFIG,
  koofr: DEFAULT_KOOFR_CONFIG,
  azureblobstorage: DEFAULT_AZUREBLOBSTORAGE_CONFIG,
  password: "",
  serviceType: "s3",
  currLogLevel: "info",
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  agreeToUploadExtraMetadata: true,
  concurrency: 5,
  syncConfigDir: false,
  syncBookmarks: false,
  syncUnderscoreItems: false,
  lang: "auto",
  logToDB: false,
  skipSizeLargerThan: -1,
  ignorePaths: [],
  onlyAllowPaths: [],
  enableStatusBarInfo: true,
  deleteToWhere: "system",
  // BYOC: All users auto-agree to sync v3 — no modal shown
  agreeToUseSyncV3: true,
  conflictAction: "keep_newer",
  howToCleanEmptyFolder: "clean_both",
  protectModifyPercentage: 50,
  syncDirection: "bidirectional",
  obfuscateSettingFile: true,

  encryptionMethod: "unknown",
  profiler: DEFAULT_PROFILER_CONFIG,
  migrationVersion: 0,
};

// ─── Icons ────────────────────────────────────────────────────────────────────

interface OAuth2Info {
  verifier?: string;
  helperModal?: Modal;
  authDiv?: HTMLElement;
  revokeDiv?: HTMLElement;
  revokeAuthSetting?: Setting;
}

const iconNameSyncWait = `byoc-sync-wait`;
const iconNameSyncRunning = `byoc-sync-running`;
const iconNameLogs = `byoc-logs`;

const getIconSvg = () => {
  const iconSvgSyncWait = createElement(RotateCcw);
  iconSvgSyncWait.setAttribute("width", "100");
  iconSvgSyncWait.setAttribute("height", "100");
  const iconSvgSyncRunning = createElement(RefreshCcw);
  iconSvgSyncRunning.setAttribute("width", "100");
  iconSvgSyncRunning.setAttribute("height", "100");
  const iconSvgLogs = createElement(FileText);
  iconSvgLogs.setAttribute("width", "100");
  iconSvgLogs.setAttribute("height", "100");
  const res = {
    iconSvgSyncWait: iconSvgSyncWait.outerHTML,
    iconSvgSyncRunning: iconSvgSyncRunning.outerHTML,
    iconSvgLogs: iconSvgLogs.outerHTML,
  };
  iconSvgSyncWait.empty();
  iconSvgSyncRunning.empty();
  iconSvgLogs.empty();
  return res;
};

const getStatusBarShortMsgFromSyncSource = (
  t: (x: TransItemType, vars?: Record<string, string>) => string,
  s: SyncTriggerSourceType | undefined
) => {
  if (s === undefined) return "";
  switch (s) {
    case "manual": return t("statusbar_sync_source_manual");
    case "dry": return t("statusbar_sync_source_dry");
    case "auto": return t("statusbar_sync_source_auto");
    case "auto_once_init": return t("statusbar_sync_source_auto_once_init");
    case "auto_sync_on_save": return t("statusbar_sync_source_auto_sync_on_save");
    default: throw new Error(`no translate for ${s}`);
  }
};

// ─── Plugin Class ─────────────────────────────────────────────────────────────

export default class BYOCPlugin extends Plugin {
  settings!: BYOCPluginSettings;
  db!: InternalDBs;
  isSyncing!: boolean;
  hasPendingSyncOnSave!: boolean;
  statusBarElement!: HTMLSpanElement;
  oauth2Info!: OAuth2Info;
  currLogLevel!: string;
  currSyncMsg?: string;
  syncRibbon?: HTMLElement;
  autoRunIntervalID?: number;
  syncOnSaveIntervalID?: number;
  i18n!: I18n;
  vaultRandomID!: string;
  debugServerTemp?: string;
  syncEvent?: Events;
  appContainerObserver?: MutationObserver;
  /**
   * Set true while the post-OAuth folder picker is open (or was dismissed
   * without a selection). All sync triggers must bail out while this is
   * true — running a sync against an unconfigured remoteBaseDir is the
   * exact scenario that produces "would delete 2000 files" plans.
   */
  awaitingFolderSelection: boolean = false;
  /** Reference to the BYOC settings tab so we can force a re-render when
   *  remoteBaseDir changes from outside the panel (e.g. the post-OAuth
   *  folder picker). Without this, the panel's text input keeps showing the
   *  pre-pick value because it captured remoteBaseDir into a closure at
   *  render time. */
  settingTab?: BYOCSettingTab;

  async syncRun(triggerSource: SyncTriggerSourceType = "manual") {
    if (this.awaitingFolderSelection) {
      console.debug(`[BYOC] syncRun skipped (${triggerSource}): awaiting remote folder selection`);
      if (triggerSource === "manual") {
        new Notice("Pick a remote folder in BYOC settings before syncing.");
      }
      return;
    }
    let profiler: Profiler | undefined = undefined;
    if (this.settings.profiler?.enable ?? false) {
      profiler = new Profiler(
        undefined,
        this.settings.profiler?.enablePrinting ?? false,
        this.settings.profiler?.recordSize ?? false
      );
    }
    const fsLocal = new FakeFsLocal(
      this.app.vault,
      this.settings.syncConfigDir ?? false,
      this.settings.syncBookmarks ?? false,
      this.app.vault.configDir,
      this.manifest.id,
      profiler,
      this.settings.deleteToWhere ?? "system"
    );
    const fsRemote = getClient(
      this.settings,
      this.app.vault.getName(),
      async () => await this.saveSettings()
    );
    const fsEncrypt = new FakeFsEncrypt(
      fsRemote,
      this.settings.password ?? "",
      this.settings.encryptionMethod ?? "rclone-base64"
    );

    const t = (x: TransItemType, vars?: Record<string, string>) => this.i18n.t(x, vars);
    const profileID = this.getCurrProfileID();

    const getProtectError = (
      protectModifyPercentage: number,
      realModifyDeleteCount: number,
      allFilesCount: number
    ) => {
      const percentNum = (100 * realModifyDeleteCount) / allFilesCount;
      if (percentNum < protectModifyPercentage) {
        return "";
      }
      const percent = percentNum.toFixed(1);
      return t("syncrun_abort_protectmodifypercentage", {
        protectModifyPercentage: String(protectModifyPercentage),
        realModifyDeleteCount: String(realModifyDeleteCount),
        allFilesCount: String(allFilesCount),
        percent,
      });
    };

    const getNotice = (s: SyncTriggerSourceType, msg: string, timeout?: number) => {
      if (s === "manual" || s === "dry") new Notice(msg, timeout);
    };

    const notifyFunc = async (s: SyncTriggerSourceType, step: number) => {
      switch (step) {
        case 0:
          if (s === "dry") getNotice(s, this.settings.currLogLevel === "info" ? t("syncrun_shortstep0") : t("syncrun_step0"));
          break;
        case 1:
          getNotice(s, this.settings.currLogLevel === "info"
            ? t("syncrun_shortstep1", { serviceType: this.settings.serviceType })
            : t("syncrun_step1", { serviceType: this.settings.serviceType }));
          break;
        case 2: if (this.settings.currLogLevel !== "info") getNotice(s, t("syncrun_step2")); break;
        case 3: if (this.settings.currLogLevel !== "info") getNotice(s, t("syncrun_step3")); break;
        case 4: if (this.settings.currLogLevel !== "info") getNotice(s, t("syncrun_step4")); break;
        case 5: if (this.settings.currLogLevel !== "info") getNotice(s, t("syncrun_step5")); break;
        case 6: if (this.settings.currLogLevel !== "info") getNotice(s, t("syncrun_step6")); break;
        case 7:
          if (s === "dry") {
            getNotice(s, this.settings.currLogLevel === "info" ? t("syncrun_shortstep2skip") : t("syncrun_step7skip"));
          } else if (this.settings.currLogLevel !== "info") {
            getNotice(s, t("syncrun_step7"));
          }
          break;
        case 8:
          getNotice(s, this.settings.currLogLevel === "info" ? t("syncrun_shortstep2") : t("syncrun_step8"));
          break;
        default:
          throw new Error(`unknown step=${step} for showing notice`);
      }
    };

    const errNotifyFunc = async (s: SyncTriggerSourceType, error: Error) => {
      console.error(error);
      if (error instanceof AggregateError) {
        for (const e of error.errors) getNotice(s, e.message, 10 * 1000);
      } else {
        getNotice(s, error?.message ?? "error while sync", 10 * 1000);
      }
    };

    const ribbonFunc = async (s: SyncTriggerSourceType, step: number) => {
      if (step === 1 && this.syncRibbon !== undefined) {
        setIcon(this.syncRibbon, iconNameSyncRunning);
        this.syncRibbon.setAttribute("aria-label",
          t("syncrun_syncingribbon", { pluginName: this.manifest.name, triggerSource: s }));
      } else if (step === 8 && this.syncRibbon !== undefined) {
        setIcon(this.syncRibbon, iconNameSyncWait);
        this.syncRibbon.setAttribute("aria-label", `${this.manifest.name}`);
      }
    };

    const statusBarFunc = async (s: SyncTriggerSourceType, step: number, everythingOk: boolean) => {
      if (step === 1) {
        this.updateLastSyncMsg(s, "syncing", -1, -1);
      } else if (step === 8 && everythingOk) {
        const ts = Date.now();
        await upsertLastSuccessSyncTimeByVault(this.db, this.vaultRandomID, ts);
        this.updateLastSyncMsg(s, "not_syncing", ts, null);
      } else if (!everythingOk) {
        const ts = Date.now();
        await upsertLastFailedSyncTimeByVault(this.db, this.vaultRandomID, ts);
        this.updateLastSyncMsg(s, "not_syncing", null, ts);
      }
    };

    const markIsSyncingFunc = async (isSyncing: boolean) => {
      this.isSyncing = isSyncing;
    };

    const callbackSyncProcess = async (
      s: SyncTriggerSourceType,
      realCounter: number,
      realTotalCount: number,
      pathName: string,
      decision: string
    ) => {
      this.setCurrSyncMsg(t, s, realCounter, realTotalCount, pathName, decision, triggerSource);
    };

    if (this.isSyncing) {
      getNotice(triggerSource, t("syncrun_alreadyrunning", {
        pluginName: this.manifest.name,
        syncStatus: "running",
        newTriggerSource: triggerSource,
      }));
      if (this.currSyncMsg) getNotice(triggerSource, this.currSyncMsg);
      return;
    }

    const configSaver = async () => await this.saveSettings();

    await syncer(
      fsLocal,
      fsRemote,
      fsEncrypt,
      profiler,
      this.db,
      triggerSource,
      profileID,
      this.vaultRandomID,
      this.app.vault.configDir,
      this.settings,
      this.manifest.version,
      configSaver,
      getProtectError,
      markIsSyncingFunc,
      notifyFunc,
      errNotifyFunc,
      ribbonFunc,
      statusBarFunc,
      callbackSyncProcess
    );

    fsEncrypt.closeResources();
    (profiler)?.clear();
    this.syncEvent?.trigger("SYNC_DONE");
  }

  async onload() {
    console.debug(`loading plugin ${this.manifest.id} (BYOC)`);

    const { iconSvgSyncWait, iconSvgSyncRunning, iconSvgLogs } = getIconSvg();
    addIcon(iconNameSyncWait, iconSvgSyncWait);
    addIcon(iconNameSyncRunning, iconSvgSyncRunning);
    addIcon(iconNameLogs, iconSvgLogs);

    this.oauth2Info = {
      verifier: "",
      helperModal: undefined,
      authDiv: undefined,
      revokeDiv: undefined,
      revokeAuthSetting: undefined,
    };

    this.currSyncMsg = "";
    this.isSyncing = false;
    this.hasPendingSyncOnSave = false;
    this.syncEvent = new Events();

    await this.loadSettings();

    // ─── Batch 4: Data Migration ────────────────────────────────────────────
    // Auto-detect legacy remotely-save configs and migrate on first run.
    // Backs up data.json before any changes, strips credential expiry timers,
    // and promotes pro-gated provider configs to top-level.
    const migrationRan = await runMigration(this, this.settings);
    if (migrationRan) {
      await this.saveSettings();
      console.debug(`[BYOC] Migration complete. Version: ${this.settings.migrationVersion}`);
    }

    const profileID: string = this.getCurrProfileID();

    this.i18n = new I18n(this.settings.lang!, async (lang: LangTypeAndAuto) => {
      this.settings.lang = lang;
      await this.saveSettings();
    });
    const t = (x: TransItemType, vars?: Record<string, string>) => this.i18n.t(x, vars);

    // NOTE: Credential expiry check removed in BYOC.
    // Credentials persist until manually revoked.
    // Token refresh is handled per-provider during sync.

    const vaultRandomIDFromOldConfigFile = await this.getVaultRandomIDFromOldConfigFile();
    this.tryToAddIgnoreFile();

    const vaultBasePath = this.getVaultBasePath();

    try {
      await this.prepareDBAndVaultRandomID(vaultBasePath, vaultRandomIDFromOldConfigFile, profileID);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "error of prepareDBAndVaultRandomID";
      new Notice(msg, 10 * 1000);
      throw err;
    }

    this.enableAutoClearOutputToDBHistIfSet();
    this.enableAutoClearSyncPlanHist();

    // Primary BYOC protocol handler
    this.registerObsidianProtocolHandler(COMMAND_URI, async (inputParams) => {
      const parsed = importQrCodeUri(inputParams, this.app.vault.getName());
      if (parsed.status === "error") {
        new Notice(parsed.message);
      } else {
        const copied = cloneDeep(parsed.result);
        this.settings = Object.assign({}, this.settings, copied);
        this.saveSettings();
        new Notice(t("protocol_saveqr", { manifestName: this.manifest.name }));
      }
    });

    // Legacy remotely-save:// URI support (for migration compatibility)
    try {
      this.registerObsidianProtocolHandler(COMMAND_URI_LEGACY, async (inputParams) => {
        new Notice(
          `[BYOC] Legacy remotely-save:// URI detected. Please update links to use bring-your-own-cloud:// instead.`
        );
      });
    } catch (e) {
      console.warn("[BYOC] Legacy protocol 'remotely-save' already registered (likely another plugin is active). Setup continuing.");
    }

    this.registerObsidianProtocolHandler(COMMAND_CALLBACK, async (inputParams) => {
      new Notice(t("protocol_callbacknotsupported", { params: JSON.stringify(inputParams) }));
    });

    // ─── Dropbox OAuth Callback ───────────────────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_DROPBOX, async (inputParams) => {
      if (inputParams.code !== undefined && this.oauth2Info?.verifier !== undefined) {
        if (this.oauth2Info.helperModal !== undefined) {
          const k = this.oauth2Info.helperModal.contentEl;
          k.empty();
          t("protocol_dropbox_connecting").split("\n").forEach((val) => k.createEl("p", { text: val }));
        } else {
          new Notice(t("protocol_dropbox_no_modal"));
          return;
        }

        const authRes = await sendAuthReqDropbox(
          this.settings.dropbox.clientID,
          this.oauth2Info.verifier,
          inputParams.code,
          async (e: any) => { new Notice(t("protocol_dropbox_connect_fail")); new Notice(`${e}`); throw e; }
        );        setConfigBySuccessfullAuthInplaceDropbox(this.settings.dropbox, authRes!, () => this.saveSettings());
        const client = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
        const username = await client.getUserDisplayName();
        this.settings.dropbox.username = username;
        await this.saveSettings();
        new Notice(t("protocol_dropbox_connect_succ", { username }));
        this.oauth2Info.verifier = "";
        this.oauth2Info.helperModal?.close();
        this.oauth2Info.helperModal = undefined;
        this.oauth2Info.authDiv = undefined;
        this.oauth2Info.revokeAuthSetting = undefined;
        this.oauth2Info.revokeDiv = undefined;
        this.settingTab?.display();
        openFolderPickerForProvider({
          app: this.app,
          plugin: this,
          providerKey: "dropbox",
          providerLabel: "Dropbox",
        });
      } else {
        new Notice(t("protocol_dropbox_connect_fail"));
        throw new Error(t("protocol_dropbox_connect_unknown", { params: JSON.stringify(inputParams) }));
      }
    });

    // ─── OneDrive AppFolder OAuth Callback ───────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_ONEDRIVE, async (inputParams) => {
      if (inputParams.code !== undefined && this.oauth2Info?.verifier !== undefined) {
        if (this.oauth2Info.helperModal !== undefined) {
          const k = this.oauth2Info.helperModal.contentEl;
          k.empty();
          t("protocol_onedrive_connecting").split("\n").forEach((val) => k.createEl("p", { text: val }));
        }
        const rsp = await sendAuthReqOnedrive(
          this.settings.onedrive.clientID,
          this.settings.onedrive.authority,
          inputParams.code,
          this.oauth2Info.verifier,
          async (e: any) => { new Notice(t("protocol_onedrive_connect_fail")); new Notice(`${e}`); return; }
        );
        if ((rsp as { error?: unknown }).error !== undefined) { new Notice(`${JSON.stringify(rsp)}`); throw new Error(`${JSON.stringify(rsp)}`); }        setConfigBySuccessfullAuthInplaceOnedrive(this.settings.onedrive, rsp as AccessCodeResponseSuccessfulTypeOnedrive, () => this.saveSettings());
        const client = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
        this.settings.onedrive.username = await client.getUserDisplayName();
        await this.saveSettings();
        this.oauth2Info.verifier = "";
        this.oauth2Info.helperModal?.close();
        this.oauth2Info.helperModal = undefined;
        this.oauth2Info.authDiv = undefined;
        this.oauth2Info.revokeAuthSetting = undefined;
        this.oauth2Info.revokeDiv = undefined;
        this.settingTab?.display();
        openFolderPickerForProvider({
          app: this.app,
          plugin: this,
          providerKey: "onedrive",
          providerLabel: "OneDrive",
        });
      } else {
        new Notice(t("protocol_onedrive_connect_fail"));
        throw new Error(t("protocol_onedrive_connect_unknown", { params: JSON.stringify(inputParams) }));
      }
    });

    // ─── OneDrive Full OAuth Callback ─────────────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_ONEDRIVEFULL, async (inputParams) => {
      if (inputParams.code !== undefined && this.oauth2Info?.verifier !== undefined) {
        if (this.oauth2Info.helperModal !== undefined) {
          const k = this.oauth2Info.helperModal.contentEl;
          k.empty();
          t("protocol_onedrivefull_connecting").split("\n").forEach((val) => k.createEl("p", { text: val }));
        }
        const rsp = await sendAuthReqOnedriveFull(
          this.settings.onedrivefull.clientID,
          this.settings.onedrivefull.authority,
          inputParams.code,
          this.oauth2Info.verifier,
          async (e: any) => { new Notice(t("protocol_onedrivefull_connect_fail")); new Notice(`${e}`); return; }
        );
        if ((rsp as { error?: unknown }).error !== undefined) { new Notice(`${JSON.stringify(rsp)}`); throw new Error(`${JSON.stringify(rsp)}`); }        setConfigBySuccessfullAuthInplaceOnedriveFull(this.settings.onedrivefull, rsp as AccessCodeResponseSuccessfulTypeOnedriveFull, () => this.saveSettings());
        const client = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
        this.settings.onedrivefull.username = await client.getUserDisplayName();
        await this.saveSettings();
        this.oauth2Info.verifier = "";
        this.oauth2Info.helperModal?.close();
        this.oauth2Info.helperModal = undefined;
        this.oauth2Info.authDiv = undefined;
        this.oauth2Info.revokeAuthSetting = undefined;
        this.oauth2Info.revokeDiv = undefined;
        this.settingTab?.display();
        openFolderPickerForProvider({
          app: this.app,
          plugin: this,
          providerKey: "onedrivefull",
          providerLabel: "OneDrive",
        });
      } else {
        new Notice(t("protocol_onedrivefull_connect_fail"));
        throw new Error(t("protocol_onedrivefull_connect_unknown", { params: JSON.stringify(inputParams) }));
      }
    });

    // ─── Box OAuth Callback ───────────────────────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_BOX, async (inputParams) => {
      if (this.oauth2Info.helperModal !== undefined) {
        const k = this.oauth2Info.helperModal.contentEl;
        k.empty();
        t("protocol_box_connecting").split("\n").forEach((val) => k.createEl("p", { text: val }));
      }
      const authRes = await sendAuthReqBox(
        inputParams.code,
        async (e: any) => { new Notice(t("protocol_box_connect_fail")); new Notice(`${e}`); throw e; }
      );      await setConfigBySuccessfullAuthInplaceBox(this.settings.box, authRes, () => this.saveSettings());
      this.oauth2Info.verifier = "";
      this.oauth2Info.helperModal?.close();
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info.authDiv = undefined;
      try {
        const boxClient = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
        const username = await boxClient.getUserDisplayName();
        this.settings.box.username = username;
        await this.saveSettings();
      } catch (_) { /* username display is non-critical */ }
      this.oauth2Info.revokeAuthSetting = undefined;
      this.oauth2Info.revokeDiv = undefined;
      this.settingTab?.display();
      openFolderPickerForProvider({
        app: this.app,
        plugin: this,
        providerKey: "box",
        providerLabel: "Box",
      });
    });

    // ─── pCloud OAuth Callback ────────────────────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_PCLOUD, async (inputParams) => {
      if (this.oauth2Info.helperModal !== undefined) {
        const k = this.oauth2Info.helperModal.contentEl;
        k.empty();
        t("protocol_pcloud_connecting").split("\n").forEach((val) => k.createEl("p", { text: val }));
      }
      const authRes = await sendAuthReqPCloud(
        inputParams.hostname,
        inputParams.code,
        async (e: any) => { new Notice(t("protocol_pcloud_connect_fail")); new Notice(`${e}`); throw e; }
      );      await setConfigBySuccessfullAuthInplacePCloud(
        this.settings.pcloud,
        inputParams as unknown as AuthAllowFirstResPCloud,
        authRes,
        () => this.saveSettings()
      );
      this.oauth2Info.verifier = "";
      this.oauth2Info.helperModal?.close();
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info.authDiv?.toggleClass("pcloud-auth-button-hide", this.settings.pcloud?.accessToken !== "");
      this.oauth2Info.authDiv = undefined;
      // Fetch display name and let the settings tab re-render to show the
      // combined "Logged in as <user>" row with the Revoke action.
      try {
        const pcloudClient = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
        const username = await pcloudClient.getUserDisplayName();
        this.settings.pcloud.username = username;
        await this.saveSettings();
        this.settingTab?.display();
      } catch (_) { /* username display is non-critical */ }
      this.oauth2Info.revokeAuthSetting = undefined;
      this.oauth2Info.revokeDiv?.toggleClass("pcloud-revoke-auth-button-hide", this.settings.pcloud?.accessToken === "");
      this.oauth2Info.revokeDiv = undefined;

      // Open the folder picker. Helper sets awaitingFolderSelection to
      // block syncs until a folder is confirmed — without this, the first
      // sync after a fresh OAuth runs against an empty/wrong remote and
      // produces a destructive "delete everything" plan.
      openFolderPickerForProvider({
        app: this.app,
        plugin: this,
        providerKey: "pcloud",
        providerLabel: "pCloud",
      });
    });

    // ─── Yandex Disk OAuth Callback ───────────────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_YANDEXDISK, async (inputParams) => {
      if (this.oauth2Info.helperModal !== undefined) {
        const k = this.oauth2Info.helperModal.contentEl;
        k.empty();
        t("protocol_yandexdisk_connecting").split("\n").forEach((val) => k.createEl("p", { text: val }));
      }
      const authRes = await sendAuthReqYandexDisk(
        inputParams.code,
        async (e: any) => { new Notice(t("protocol_yandexdisk_connect_fail")); new Notice(`${e}`); throw e; }
      );      await setConfigBySuccessfullAuthInplaceYandexDisk(this.settings.yandexdisk, authRes, () => this.saveSettings());
      this.oauth2Info.verifier = "";
      this.oauth2Info.helperModal?.close();
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info.authDiv = undefined;
      try {
        const yandexClient = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
        const username = await yandexClient.getUserDisplayName();
        this.settings.yandexdisk.username = username;
        await this.saveSettings();
      } catch (_) { /* username display is non-critical */ }
      this.oauth2Info.revokeAuthSetting = undefined;
      this.oauth2Info.revokeDiv = undefined;
      this.settingTab?.display();
      openFolderPickerForProvider({
        app: this.app,
        plugin: this,
        providerKey: "yandexdisk",
        providerLabel: "Yandex Disk",
      });
    });

    // ─── Koofr OAuth Callback ─────────────────────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_KOOFR, async (inputParams) => {
      if (this.oauth2Info.helperModal !== undefined) {
        const k = this.oauth2Info.helperModal.contentEl;
        k.empty();
        t("protocol_koofr_connecting").split("\n").forEach((val) => k.createEl("p", { text: val }));
      }
      const authRes = await sendAuthReqKoofr(
        inputParams.code,
        async (e: any) => { new Notice(t("protocol_koofr_connect_fail")); new Notice(`${e}`); throw e; }
      );      await setConfigBySuccessfullAuthInplaceKoofr(this.settings.koofr, authRes, () => this.saveSettings());
      this.oauth2Info.verifier = "";
      this.oauth2Info.helperModal?.close();
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info.authDiv = undefined;
      try {
        const koofrClient = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
        const username = await koofrClient.getUserDisplayName();
        this.settings.koofr.username = username;
        await this.saveSettings();
      } catch (_) { /* username display is non-critical */ }
      this.oauth2Info.revokeAuthSetting = undefined;
      this.oauth2Info.revokeDiv = undefined;
      this.settingTab?.display();
      openFolderPickerForProvider({
        app: this.app,
        plugin: this,
        providerKey: "koofr",
        providerLabel: "Koofr",
      });
    });

    // ─── Google Drive OAuth Callback ──────────────────────────────────────────
    this.registerObsidianProtocolHandler(COMMAND_CALLBACK_GOOGLEDRIVE, async (inputParams) => {
      if (!inputParams.code) {
        new Notice("Google Drive: missing authorization code.");
        return;
      }
      if (this.oauth2Info.helperModal !== undefined) {
        const k = this.oauth2Info.helperModal.contentEl;
        k.empty();
        k.createEl("p", { text: "Connecting to Google Drive…" });
      }      try {
        const authRes = await sendAuthReqGoogleDrive(
          inputParams.code,
          async (e: any) => { new Notice("Google Drive connection failed"); new Notice(`${e}`); throw e; }
        );
        if (!authRes || authRes.error) {
          new Notice("Google Drive connection failed");
          return;
        }
        await setConfigBySuccessfullAuthInplaceGoogleDrive(
          this.settings.googledrive,
          authRes,
          () => this.saveSettings()
        );
        // Fetch display name
        try {
          const gdClient = getClient(this.settings, this.app.vault.getName(), () => this.saveSettings());
          const username = await gdClient.getUserDisplayName();
          this.settings.googledrive.username = username;
          await this.saveSettings();
        } catch (_) { /* username display is non-critical */ }
        this.oauth2Info.helperModal?.close();
        this.oauth2Info.helperModal = undefined;
        new Notice("Google Drive connected successfully!");
        this.settingTab?.display();
        openFolderPickerForProvider({
          app: this.app,
          plugin: this,
          providerKey: "googledrive",
          providerLabel: "Google Drive",
        });
      } catch (e) {
        console.error(e);
        new Notice("Google Drive connection failed");
      }
    });

    // ─── UI ───────────────────────────────────────────────────────────────────

    this.syncRibbon = this.addRibbonIcon(
      iconNameSyncWait,
      `${this.manifest.name}`,
      async () => this.syncRun("manual")
    );

    if (!Platform.isMobile && this.settings.enableStatusBarInfo === true) {
      const statusBarItem = this.addStatusBarItem();
      statusBarItem.addClass("byoc-status-bar");
      statusBarItem.addEventListener("click", () => this.syncRun("manual"));
      this.statusBarElement = statusBarItem.createEl("span");
      this.statusBarElement.setAttribute("data-tooltip-position", "top");

      if (!this.isSyncing) {
        this.updateLastSyncMsg(
          undefined,
          "not_syncing",
          await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
          await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID)
        );
      }

      this.registerInterval(
        activeWindow.setInterval(async () => {
          if (!this.isSyncing) {
            this.updateLastSyncMsg(
              undefined,
              "not_syncing",
              await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
              await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID)
            );
          }
        }, 1000 * 30)
      );
    }

    this.addCommand({ id: "start-sync", name: t("command_startsync"), icon: iconNameSyncWait, callback: async () => this.syncRun("manual") });
    this.addCommand({ id: "start-sync-dry-run", name: t("command_drynrun"), icon: iconNameSyncWait, callback: async () => this.syncRun("dry") });
    this.addCommand({ id: "export-sync-plans-1-only-change", name: t("command_exportsyncplans_1_only_change"), icon: iconNameLogs, callback: async () => { await exportVaultSyncPlansToFiles(this.db, this.app.vault, this.vaultRandomID, 1, true); new Notice(t("settings_syncplans_notice")); } });
    this.addCommand({ id: "export-sync-plans-1", name: t("command_exportsyncplans_1"), icon: iconNameLogs, callback: async () => { await exportVaultSyncPlansToFiles(this.db, this.app.vault, this.vaultRandomID, 1, false); new Notice(t("settings_syncplans_notice")); } });
    this.addCommand({ id: "export-sync-plans-5", name: t("command_exportsyncplans_5"), icon: iconNameLogs, callback: async () => { await exportVaultSyncPlansToFiles(this.db, this.app.vault, this.vaultRandomID, 5, false); new Notice(t("settings_syncplans_notice")); } });
    this.addCommand({ id: "export-sync-plans-all", name: t("command_exportsyncplans_all"), icon: iconNameLogs, callback: async () => { await exportVaultSyncPlansToFiles(this.db, this.app.vault, this.vaultRandomID, -1, false); new Notice(t("settings_syncplans_notice")); } });

    this.settingTab = new BYOCSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.enableCheckingFileStat();

    // BYOC: All users use v3 sync algorithm — no consent modal shown
    this.enableAutoSyncIfSet();
    this.enableInitSyncIfSet();
    this.enableSyncOnMobileResume();    // mobile: auto-sync on app resume + cold-start
    this.enableMobileSyncButton();      // mobile: sync button in bottom toolbar
    this.toggleSyncOnSaveIfSet();

    const { oldVersion } = await upsertPluginVersionByVault(this.db, this.vaultRandomID, this.manifest.version);
  }

  async onunload() {
    console.debug(`unloading plugin ${this.manifest.id}`);
    this.syncRibbon = undefined;
    if (this.appContainerObserver !== undefined) {
      this.appContainerObserver.disconnect();
      this.appContainerObserver = undefined;
    }
    if (this.oauth2Info !== undefined) {
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info = { verifier: "", helperModal: undefined, authDiv: undefined, revokeDiv: undefined, revokeAuthSetting: undefined };
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      messyConfigToNormal(await this.loadData())
    );

    // Ensure all provider configs exist
    if (!this.settings.googledrive) this.settings.googledrive = DEFAULT_GOOGLEDRIVE_CONFIG;
    if (!this.settings.box) this.settings.box = DEFAULT_BOX_CONFIG;
    if (!this.settings.pcloud) this.settings.pcloud = DEFAULT_PCLOUD_CONFIG;
    if (!this.settings.yandexdisk) this.settings.yandexdisk = DEFAULT_YANDEXDISK_CONFIG;
    if (!this.settings.koofr) this.settings.koofr = DEFAULT_KOOFR_CONFIG;
    if (!this.settings.azureblobstorage) this.settings.azureblobstorage = DEFAULT_AZUREBLOBSTORAGE_CONFIG;
    if (!this.settings.onedrivefull) this.settings.onedrivefull = DEFAULT_ONEDRIVEFULL_CONFIG;

    // Dropbox defaults
    if (this.settings.dropbox.clientID === "") this.settings.dropbox.clientID = DEFAULT_SETTINGS.dropbox.clientID;
    if (this.settings.dropbox.remoteBaseDir === undefined) this.settings.dropbox.remoteBaseDir = "";

    // OneDrive defaults
    if (this.settings.onedrive.clientID === "") this.settings.onedrive.clientID = DEFAULT_SETTINGS.onedrive.clientID;
    if (this.settings.onedrive.authority === "") this.settings.onedrive.authority = DEFAULT_SETTINGS.onedrive.authority;
    if (this.settings.onedrive.remoteBaseDir === undefined) this.settings.onedrive.remoteBaseDir = "";
    if (this.settings.onedrive.emptyFile === undefined) this.settings.onedrive.emptyFile = "skip";
    if (this.settings.onedrive.kind === undefined) this.settings.onedrive.kind = "onedrive";

    // WebDAV defaults
    if (this.settings.webdav.manualRecursive === undefined) this.settings.webdav.manualRecursive = true;
    if (this.settings.webdav.depth === undefined || ["auto","auto_1","auto_infinity","auto_unknown"].includes(this.settings.webdav.depth)) {
      this.settings.webdav.depth = "manual_1";
      this.settings.webdav.manualRecursive = true;
    }
    if (this.settings.webdav.remoteBaseDir === undefined) this.settings.webdav.remoteBaseDir = "";
    if (this.settings.webdav.customHeaders === undefined) this.settings.webdav.customHeaders = "";

    // S3 defaults
    if (this.settings.s3.partsConcurrency === undefined) this.settings.s3.partsConcurrency = 20;
    if (this.settings.s3.forcePathStyle === undefined) this.settings.s3.forcePathStyle = false;
    if (this.settings.s3.remotePrefix === undefined) this.settings.s3.remotePrefix = "";
    if (this.settings.s3.useAccurateMTime === undefined) this.settings.s3.useAccurateMTime = false;
    if (this.settings.s3.generateFolderObject === undefined) this.settings.s3.generateFolderObject = false;

    // General defaults
    if (this.settings.ignorePaths === undefined) this.settings.ignorePaths = [];
    if (this.settings.onlyAllowPaths === undefined) this.settings.onlyAllowPaths = [];
    if (this.settings.enableStatusBarInfo === undefined) this.settings.enableStatusBarInfo = true;
    if (this.settings.syncOnSaveAfterMilliseconds === undefined) {
      this.settings.syncOnSaveAfterMilliseconds = -1;
    } else if (this.settings.syncOnSaveAfterMilliseconds === 1000) {
      // Migrate legacy binary toggle users to 5 seconds
      this.settings.syncOnSaveAfterMilliseconds = 5000;
    }
    if (this.settings.deleteToWhere === undefined) this.settings.deleteToWhere = "system";
    if (this.settings.syncBookmarks === undefined) this.settings.syncBookmarks = false;
    this.settings.logToDB = false; // deprecated
    if (requireApiVersion(API_VER_ENSURE_REQURL_OK)) this.settings.s3.bypassCorsLocally = true;
    if (this.settings.agreeToUseSyncV3 === undefined) this.settings.agreeToUseSyncV3 = true; // BYOC: always true
    if (this.settings.conflictAction === undefined) this.settings.conflictAction = "keep_newer";
    if (this.settings.howToCleanEmptyFolder === undefined) this.settings.howToCleanEmptyFolder = "clean_both";
    if (this.settings.protectModifyPercentage === undefined) this.settings.protectModifyPercentage = 50;
    if (this.settings.syncDirection === undefined) this.settings.syncDirection = "bidirectional";
    if (this.settings.obfuscateSettingFile === undefined) this.settings.obfuscateSettingFile = true;

    if (this.settings.encryptionMethod === undefined || this.settings.encryptionMethod === "unknown") {
      this.settings.encryptionMethod = (!this.settings.password) ? "rclone-base64" : "openssl-base64";
    }

    if (this.settings.profiler === undefined) this.settings.profiler = DEFAULT_PROFILER_CONFIG;
    if (this.settings.profiler.enable === undefined) this.settings.profiler.enable = false;
    if (this.settings.profiler.enablePrinting === undefined) this.settings.profiler.enablePrinting = false;
    if (this.settings.profiler.recordSize === undefined) this.settings.profiler.recordSize = false;

    // Remove pro field if it survived migration
    if ("pro" in this.settings) delete (this.settings as any).pro;

    await this.saveSettings();
  }

  async saveSettings() {
    if (this.settings.obfuscateSettingFile) {
      await this.saveData(normalConfigToMessy(this.settings));
    } else {
      await this.saveData(this.settings);
    }
  }

  getCurrProfileID() {
    if (this.settings.serviceType !== undefined) {
      return `${this.settings.serviceType}-default-1`;
    }
    throw new Error("unknown serviceType in the setting!");
  }

  async getVaultRandomIDFromOldConfigFile() {
    let vaultRandomID = "";
    if (this.settings.vaultRandomID !== undefined) {
      if (this.settings.vaultRandomID !== "") vaultRandomID = this.settings.vaultRandomID;
      console.debug("vaultRandomID is no longer saved in data.json");
      delete this.settings.vaultRandomID;
      await this.saveSettings();
    }
    return vaultRandomID;
  }

  async trash(x: string) {
    if (this.settings.deleteToWhere === "obsidian") {
      await this.app.vault.adapter.trashLocal(x);
    } else {
      if (!(await this.app.vault.adapter.trashSystem(x))) {
        await this.app.vault.adapter.trashLocal(x);
      }
    }
  }

  getVaultBasePath() {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      return this.app.vault.adapter.getBasePath().split("?")[0];
    } else {
      return this.app.vault.adapter.getResourcePath("").split("?")[0];
    }
  }

  async prepareDBAndVaultRandomID(vaultBasePath: string, vaultRandomIDFromOldConfigFile: string, profileID: string) {
    const { db, vaultRandomID } = await prepareDBs(vaultBasePath, vaultRandomIDFromOldConfigFile, profileID);
    this.db = db;
    this.vaultRandomID = vaultRandomID;
  }

  enableAutoSyncIfSet() {
    if (this.settings.autoRunEveryMilliseconds != null && this.settings.autoRunEveryMilliseconds > 0) {
      this.app.workspace.onLayoutReady(() => {
        const intervalID = activeWindow.setInterval(() => this.syncRun("auto"), this.settings.autoRunEveryMilliseconds);
        this.autoRunIntervalID = intervalID;
        this.registerInterval(intervalID);
      });
    }
  }

  enableInitSyncIfSet() {
    if (this.settings.initRunAfterMilliseconds != null && this.settings.initRunAfterMilliseconds > 0) {
      this.app.workspace.onLayoutReady(() => {
        activeWindow.setTimeout(() => this.syncRun("auto_once_init"), this.settings.initRunAfterMilliseconds);
      });
    }
  }

  /**
   * Attempt to inject the sync button into Obsidian's mobile bottom navbar
   * (.mobile-navbar > .mobile-navbar-actions). Placed immediately BEFORE
   * the rightmost three-dot menu button so it lines up with the other
   * navbar actions (back, forward, quick-switcher, new-tab, tabs, menu).
   *
   * If the menu button isn't present yet (rare race where the row is
   * mid-render), we append to the actions row instead so the user still
   * gets a button this frame; a later mutation can re-anchor if needed.
   */
  private _tryInjectSyncButton(btn: HTMLElement): boolean {
    const actions = activeDocument.querySelector(".mobile-navbar-actions");
    if (!actions) return false;

    const menuBtn = actions.querySelector(".mobile-navbar-action-menu");
    if (menuBtn) {
      actions.insertBefore(btn, menuBtn);
    } else {
      actions.appendChild(btn);
    }
    console.debug("[BYOC] Mobile sync button: injected into mobile navbar");
    return true;
  }

  /**
   * Mobile resume sync — fires sync when the app returns from background.
   *
   * Covers two mobile lifecycle scenarios:
   *   1. Suspend → resume: `visibilitychange` fires (document was hidden, becomes visible).
   *   2. Kill → cold start: document is already visible at registration time.
   *      Handled by an onLayoutReady fallback, only if initRunAfterMilliseconds is off.
   *
   * Uses "manual" trigger so errors surface as notices (users opened the app intentionally).
   * 3s debounce absorbs iOS radio re-association and WebView focus flicker.
   */
  enableSyncOnMobileResume() {
    if (!Platform.isMobile) return;

    console.debug("[BYOC] Mobile resume sync: registering visibilitychange handler");

    const RESUME_DEBOUNCE_MS = 3000;
    let resumeTimer: number | undefined;

    const triggerSync = () => {
      activeWindow.clearTimeout(resumeTimer);
      resumeTimer = activeWindow.setTimeout(() => {
        if (!this.isSyncing) {
          console.debug("[BYOC] Mobile resume sync: triggering syncRun");
          this.syncRun("manual");
        }
      }, RESUME_DEBOUNCE_MS);
    };

    // Scenario 1: suspend → resume
    const handler = () => {
      if (activeDocument.visibilityState !== "visible") return;
      triggerSync();
    };
    activeDocument.addEventListener("visibilitychange", handler);

    // Scenario 2: kill → cold start (only if user hasn't configured initRunAfterMilliseconds)
    if ((this.settings.initRunAfterMilliseconds ?? 0) <= 0) {
      this.app.workspace.onLayoutReady(() => {
        if (!this.isSyncing) {
          console.debug("[BYOC] Mobile cold-start sync: triggering initial syncRun");
          activeWindow.setTimeout(() => this.syncRun("manual"), RESUME_DEBOUNCE_MS);
        }
      });
    }

    this.register(() => {
      activeDocument.removeEventListener("visibilitychange", handler);
      activeWindow.clearTimeout(resumeTimer);
    });
  }

  /**
   * Mobile Sync Button — injected into Obsidian's bottom toolbar, immediately
   * to the LEFT of the settings cog. Lives in the toolbar or not at all; if
   * the toolbar never renders, the user still has the command palette
   * "Sync now" entry — we don't fall back to a floating overlay.
   *
   * A MutationObserver on document.body survives both the cold-start race
   * (toolbar mounts after layout-ready) and any later re-render where
   * Obsidian replaces the toolbar element. The callback is cheap: once the
   * button is in the DOM, btn.isConnected short-circuits before the
   * querySelector runs.
   *
   * The isSyncing guard and CSS pointer-events:none both block concurrent
   * taps (belt-and-suspenders — either alone would suffice).
   */
  enableMobileSyncButton() {
    if (!Platform.isMobile) return;

    // Use Obsidian's native navbar-action styling (icon-only, transparent),
    // and add our own class so we can style the spinning state.
    const btn = activeDocument.createElement("div");
    btn.addClass("mobile-navbar-action");
    btn.addClass("byoc-mobile-sync");
    btn.setAttribute("aria-label", "Sync vault now");
    setIcon(btn, iconNameSyncWait);

    btn.addEventListener("click", async () => {
      if (this.isSyncing) return;
      btn.addClass("byoc-mobile-sync--syncing");
      setIcon(btn, iconNameSyncRunning);
      try {
        await this.syncRun("manual");
      } finally {
        btn.removeClass("byoc-mobile-sync--syncing");
        setIcon(btn, iconNameSyncWait);
      }
    });

    const tryInject = () => {
      if (btn.isConnected) return;
      this._tryInjectSyncButton(btn);
    };

    this.app.workspace.onLayoutReady(() => {
      tryInject();

      const observer = new MutationObserver(tryInject);
      observer.observe(activeDocument.body, { childList: true, subtree: true });
      this.register(() => observer.disconnect());
    });

    this.register(() => btn.remove());
  }

  async _checkCurrFileModified(caller: "SYNC" | "FILE_CHANGES") {
    const currentFile = this.app.workspace.getActiveFile();
    if (caller === "FILE_CHANGES") {
      // For vault events (create/delete/rename/modify), always trigger sync
      // regardless of active file state. Deletion events remove the active file,
      // so we can't rely on getActiveFile() here.
      if (this.isSyncing) { this.hasPendingSyncOnSave = true; return; }
      this.hasPendingSyncOnSave = false;
      await this.syncRun("auto_sync_on_save");
    } else if (caller === "SYNC" && currentFile) {
      // Post-sync check: only re-sync if the active file was modified after last sync.
      const lastModified = currentFile.stat.mtime;
      const lastSuccessSyncMillis = await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID);
      if (lastModified > (lastSuccessSyncMillis ?? 1)) {
        if (this.isSyncing) { this.hasPendingSyncOnSave = true; return; }
        if (this.hasPendingSyncOnSave) {
          this.hasPendingSyncOnSave = false;
          await this.syncRun("auto_sync_on_save");
        }
      }
    }
  }

  _syncOnSaveEvent1 = () => { this._checkCurrFileModified("SYNC"); };
  
  _debouncedSyncImpl?: ReturnType<typeof debounce>;
  _syncOnSaveRegistered = false;
  
  _syncOnSaveEvent2 = async (...args: any[]) => {
    this._debouncedSyncImpl?.(...args);
  };

  toggleSyncOnSaveIfSet() {
    this._debouncedSyncImpl?.cancel();

    if (this.settings.syncOnSaveAfterMilliseconds != null && this.settings.syncOnSaveAfterMilliseconds > 0) {
      this._debouncedSyncImpl = debounce(
        async () => { await this._checkCurrFileModified("FILE_CHANGES"); },
        this.settings.syncOnSaveAfterMilliseconds,
        { leading: false, trailing: true }
      );

      if (!this._syncOnSaveRegistered) {
        this._syncOnSaveRegistered = true;
        this.app.workspace.onLayoutReady(() => {
          this.registerEvent(this.syncEvent?.on("SYNC_DONE", this._syncOnSaveEvent1)!);
          this.registerEvent(this.app.vault.on("modify", this._syncOnSaveEvent2));
          this.registerEvent(this.app.vault.on("create", this._syncOnSaveEvent2));
          this.registerEvent(this.app.vault.on("delete", this._syncOnSaveEvent2));
          this.registerEvent(this.app.vault.on("rename", this._syncOnSaveEvent2));
        });
      }
    } else {
      this._debouncedSyncImpl = undefined;
      // We intentionally do not unregister events here.
      // They pipe into the undefined wrapper as a no-op.
    }
  }



  enableCheckingFileStat() {
    this.app.workspace.onLayoutReady(() => {
      const t = (x: TransItemType, vars?: Record<string, string>) => this.i18n.t(x, vars);
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          if (file instanceof TFolder) return;
          menu.addItem((item) => {
            item.setTitle(t("menu_check_file_stat")).setIcon("file-cog").onClick(async () => {
              const fsLocal = new FakeFsLocal(
                this.app.vault, this.settings.syncConfigDir ?? false, this.settings.syncBookmarks ?? false,
                this.app.vault.configDir, this.manifest.id, undefined, this.settings.deleteToWhere ?? "system"
              );
              const s = await fsLocal.stat(file.path);
              new Notice(JSON.stringify(s, null, 2), 10000);
            });
          });
        })
      );
    });
  }

  async saveAgreeToUseNewSyncAlgorithm() {
    this.settings.agreeToUseSyncV3 = true;
    await this.saveSettings();
  }

  setCurrSyncMsg(
    t: (x: TransItemType, vars?: Record<string, string>) => string,
    s: SyncTriggerSourceType,
    i: number,
    totalCount: number,
    pathName: string,
    decision: string,
    triggerSource: SyncTriggerSourceType
  ) {
    const shortMsg = `BYOC ⟳ ${i}/${totalCount}`;
    const longMsg = `Syncing ${i}/${totalCount}: ${pathName} (${decision})`;
    this.currSyncMsg = longMsg;
    if (this.statusBarElement !== undefined) {
      this.statusBarElement.setText(shortMsg);
      this.statusBarElement.setAttribute("aria-label", longMsg);
    }
  }

  updateLastSyncMsg(
    s: SyncTriggerSourceType | undefined,
    syncStatus: "not_syncing" | "syncing",
    lastSuccessSyncMillis: number | null | undefined,
    lastFailedSyncMillis: number | null | undefined
  ) {
    if (this.statusBarElement === undefined) return;
    const t = (x: TransItemType, vars?: Record<string, string>) => this.i18n.t(x, vars);

    if (syncStatus === "syncing") {
      this.statusBarElement.setText("BYOC ⟳");
      this.statusBarElement.setAttribute("aria-label", "Syncing now…");
      return;
    }

    const inputTs = Math.max(lastSuccessSyncMillis ?? -999, lastFailedSyncMillis ?? -999);
    const isSuccess = (lastSuccessSyncMillis ?? -999) >= (lastFailedSyncMillis ?? -999);

    if (inputTs <= 0) {
      this.statusBarElement.setText("BYOC —");
      this.statusBarElement.setAttribute("aria-label", "Never synced. Click to sync now.");
      return;
    }

    const icon = isSuccess ? "✓" : "✗";
    const delta = Date.now() - inputTs;
    const ago =
      delta < 60_000 ? "now" :
      delta < 3_600_000 ? `${Math.floor(delta / 60_000)}m` :
      delta < 86_400_000 ? `${Math.floor(delta / 3_600_000)}h` :
      `${Math.floor(delta / 86_400_000)}d`;

    const shortMsg = `BYOC ${icon} ${ago}`;
    const dateText = new Date(inputTs).toLocaleTimeString(navigator.language, {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });
    const statusWord = isSuccess ? "Succeeded" : "Failed";
    // We use the language placeholder string for the date to preserve internationalization.
    const longMsg = `Last sync ${statusWord}: ` + t("statusbar_lastsync_label", { date: dateText }) + ". Click to sync now.";

    this.statusBarElement.setText(shortMsg);
    this.statusBarElement.setAttribute("aria-label", longMsg);
  }

  async tryToAddIgnoreFile() {
    const pluginConfigDir = this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const pluginConfigDirExists = await this.app.vault.adapter.exists(pluginConfigDir);
    if (!pluginConfigDirExists) return;
    const ignoreFile = `${pluginConfigDir}/.gitignore`;
    const ignoreFileExists = await this.app.vault.adapter.exists(ignoreFile);
    if (!ignoreFileExists) {
      try { this.app.vault.adapter.write(ignoreFile, "data.json\n"); } catch (_) {}
    }
  }

  enableAutoClearOutputToDBHistIfSet() {
    this.app.workspace.onLayoutReady(() => {
      activeWindow.setTimeout(() => clearAllLoggerOutputRecords(this.db), 1000 * 30);
    });
  }

  enableAutoClearSyncPlanHist() {
    this.app.workspace.onLayoutReady(() => {
      activeWindow.setTimeout(() => clearExpiredSyncPlanRecords(this.db), 1000 * 45);
      const intervalID = activeWindow.setInterval(() => clearExpiredSyncPlanRecords(this.db), 1000 * 60 * 5);
      this.registerInterval(intervalID);
    });
  }
}
