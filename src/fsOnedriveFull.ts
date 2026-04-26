/**
 * BYOC — OneDrive Full Filesystem Adapter
 * Clean-room implementation using Microsoft Graph API with root folder access.
 * Unlike the standard OneDrive adapter (App Folder only), this accesses
 * the user's full drive root, allowing custom remoteBaseDir placement.
 */

import { CryptoProvider, PublicClientApplication } from "@azure/msal-node";
import type {
  DriveItem,
  UploadSession,
  User,
} from "@microsoft/microsoft-graph-types";
import cloneDeep from "lodash/cloneDeep";
import { request, requestUrl } from "obsidian";
import {
  COMMAND_CALLBACK_ONEDRIVEFULL,
  DEFAULT_CONTENT_TYPE,
  type Entity,
  ONEDRIVE_AUTHORITY,
  ONEDRIVE_CLIENT_ID,
  type OnedriveFullConfig,
} from "./baseTypes";
import { VALID_REQURL } from "./baseTypesObs";
import { FakeFs } from "./fsAll";
import { retryFetch } from "./misc";

// Full access scopes — reads/writes anywhere on the drive
const SCOPES = ["User.Read", "Files.ReadWrite.All", "offline_access"];
const REDIRECT_URI = `obsidian://${COMMAND_CALLBACK_ONEDRIVEFULL}`;

export const DEFAULT_ONEDRIVEFULL_CONFIG: OnedriveFullConfig = {
  accessToken: "",
  clientID: ONEDRIVE_CLIENT_ID ?? "",
  authority: ONEDRIVE_AUTHORITY ?? "",
  refreshToken: "",
  accessTokenExpiresInSeconds: 0,
  accessTokenExpiresAtTime: 0,
  deltaLink: "",
  username: "",
  credentialsShouldBeDeletedAtTime: 0,
  emptyFile: "skip",
  kind: "onedrivefull",
};

////////////////////////////////////////////////////////////////////////////////
// OneDrive Full authorization using PKCE
////////////////////////////////////////////////////////////////////////////////

export async function getAuthUrlAndVerifier(
  clientID: string,
  authority: string
) {
  const cryptoProvider = new CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

  const authCodeUrlParams = {
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  };

  const pca = new PublicClientApplication({
    auth: { clientId: clientID, authority: authority },
  });
  const authCodeUrl = await pca.getAuthCodeUrl(authCodeUrlParams);

  return { authUrl: authCodeUrl, verifier: verifier };
}

export interface AccessCodeResponseSuccessfulType {
  token_type: "Bearer" | "bearer";
  expires_in: number;
  ext_expires_in?: number;
  scope: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export interface AccessCodeResponseFailedType {
  error: string;
  error_description: string;
  error_codes: number[];
  timestamp: string;
  trace_id: string;
  correlation_id: string;
}

export const sendAuthReq = async (
  clientID: string,
  authority: string,
  authCode: string,
  verifier: string,
  errorCallBack: (e: unknown) => void | Promise<void>
) => {
  try {
    const rsp1 = await request({
      url: `${authority}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        tenant: "consumers",
        client_id: clientID,
        scope: SCOPES.join(" "),
        code: authCode,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });

    const rsp2 = JSON.parse(rsp1) as AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType;
    if ((rsp2 as AccessCodeResponseFailedType).error !== undefined) {
      return rsp2 as AccessCodeResponseFailedType;
    }
    return rsp2 as AccessCodeResponseSuccessfulType;
  } catch (e) {
    console.error(e);
    await errorCallBack(e);
    throw e;
  }
};

export const sendRefreshTokenReq = async (
  clientID: string,
  authority: string,
  refreshToken: string
): Promise<AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType> => {
  try {
    const rsp1 = await request({
      url: `${authority}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        tenant: "consumers",
        client_id: clientID,
        scope: SCOPES.join(" "),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });

    const rsp2 = JSON.parse(rsp1) as AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType;
    return rsp2;
  } catch (e) {
    console.error(e);
    throw e;
  }
};

export const setConfigBySuccessfullAuthInplace = async (
  config: OnedriveFullConfig,
  authRes: AccessCodeResponseSuccessfulType,
  saveUpdatedConfigFunc: () => Promise<void> | undefined
) => {
  console.debug("start updating local info of OneDrive Full token");
  config.accessToken = authRes.access_token;
  config.accessTokenExpiresAtTime =
    Date.now() + authRes.expires_in * 1000 - 5 * 60 * 1000;
  config.accessTokenExpiresInSeconds = authRes.expires_in;
  config.refreshToken = authRes.refresh_token!;
  // BYOC: No forced expiry
  config.credentialsShouldBeDeletedAtTime = 0;

  if (saveUpdatedConfigFunc !== undefined) {
    await saveUpdatedConfigFunc();
  }
  console.debug("finish updating local info of OneDrive Full token");
};

////////////////////////////////////////////////////////////////////////////////
// Path Helpers — uses drive root instead of approot
////////////////////////////////////////////////////////////////////////////////

const getOnedrivePath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  const prefix = `/drive/root:/${remoteBaseDir}`;

  let key = fileOrFolderPath;
  if (fileOrFolderPath === "/" || fileOrFolderPath === "") {
    return prefix;
  }
  if (key.endsWith("/")) {
    key = key.slice(0, -1);
  }
  if (key.startsWith("/")) {
    key = `${prefix}${key}`;
  } else {
    key = `${prefix}/${key}`;
  }
  return key;
};

const fromDriveItemToEntity = (
  x: DriveItem,
  remoteBaseDir: string
): Entity => {
  if (!x.parentReference?.path || !x.name) {
    throw Error(
      `OneDrive Full: item missing parentReference.path or name: ${JSON.stringify(x)}`
    );
  }

  const fullPath = `${x.parentReference.path}/${x.name}`;
  const remoteBaseDirEncoded = encodeURIComponent(remoteBaseDir);

  // Expected prefix patterns for root drive access:
  //   /drive/root:/${remoteBaseDir}
  //   /drive/root:/${remoteBaseDirEncoded}
  //   /drive/items/<id>:/${remoteBaseDir}

  let key = "";

  // Pattern 1: /drive/root:/remoteBaseDir/...
  const rootPrefix = `/drive/root:/${remoteBaseDir}`;
  const rootPrefixEnc = `/drive/root:/${remoteBaseDirEncoded}`;
  const itemsPrefix = `/drive/items/`;

  if (fullPath.startsWith(`${rootPrefix}/`)) {
    key = fullPath.slice(rootPrefix.length + 1);
  } else if (fullPath === rootPrefix) {
    key = "";
  } else if (fullPath.startsWith(`${rootPrefixEnc}/`)) {
    key = fullPath.slice(rootPrefixEnc.length + 1);
  } else if (fullPath === rootPrefixEnc) {
    key = "";
  } else if (x.parentReference.path.startsWith(itemsPrefix)) {
    // /drive/items/<id>:/${remoteBaseDir}/...
    const decodedPath = decodeURIComponent(x.parentReference.path);
    const colonIdx = decodedPath.indexOf(":");
    if (colonIdx >= 0) {
      const afterColon = decodedPath.slice(colonIdx + 1);
      if (afterColon.startsWith(`/${remoteBaseDir}/`)) {
        key = `${afterColon.slice(`/${remoteBaseDir}/`.length)}/${x.name}`;
      } else if (afterColon === `/${remoteBaseDir}`) {
        key = x.name;
      } else {
        throw Error(
          `OneDrive Full: unexpected item path structure: ${fullPath}`
        );
      }
    } else {
      throw Error(
        `OneDrive Full: items path has no colon: ${decodedPath}`
      );
    }
  } else {
    throw Error(
      `OneDrive Full: cannot extract key from path: ${fullPath}`
    );
  }

  const isFolder = "folder" in x;
  if (isFolder) {
    key = `${key}/`;
  }

  const mtimeRaw = x.fileSystemInfo?.lastModifiedDateTime;
  if (!mtimeRaw) {
    throw Error(`OneDrive Full: no mtime for item: ${JSON.stringify(x)}`);
  }
  const ctimeRaw = x.fileSystemInfo?.createdDateTime ?? mtimeRaw;

  return {
    key: key,
    keyRaw: key,
    mtimeSvr: Date.parse(mtimeRaw),
    mtimeCli: Date.parse(mtimeRaw),
    ctimeCli: Date.parse(ctimeRaw),
    size: isFolder ? 0 : (x.size ?? 0),
    sizeRaw: isFolder ? 0 : (x.size ?? 0),
    synthesizedFile: false,
  };
};

////////////////////////////////////////////////////////////////////////////////
// Auth Provider
////////////////////////////////////////////////////////////////////////////////

class OneDriveFullAuthProvider {
  config: OnedriveFullConfig;
  saveFunc: () => Promise<void>;

  constructor(config: OnedriveFullConfig, saveFunc: () => Promise<void>) {
    this.config = config;
    this.saveFunc = saveFunc;
  }

  async getAccessToken(): Promise<string> {
    if (!this.config.accessToken || !this.config.refreshToken) {
      throw Error("OneDrive Full: user has not authorized yet.");
    }

    if (this.config.accessTokenExpiresAtTime > Date.now()) {
      return this.config.accessToken;
    }

    // Refresh the token
    const r = await sendRefreshTokenReq(
      this.config.clientID,
      this.config.authority,
      this.config.refreshToken
    );
    if ((r as { error?: unknown }).error !== undefined) {
      const err = r as AccessCodeResponseFailedType;
      throw Error(
        `OneDrive Full refresh error: ${err.error}: ${err.error_description}`
      );
    }
    const success = r as AccessCodeResponseSuccessfulType;
    this.config.accessToken = success.access_token;
    this.config.refreshToken = success.refresh_token!;
    this.config.accessTokenExpiresInSeconds = success.expires_in;
    this.config.accessTokenExpiresAtTime =
      Date.now() + success.expires_in * 1000 - 120_000;
    await this.saveFunc();
    console.debug("OneDrive Full accessToken refreshed");
    return this.config.accessToken;
  }
}

////////////////////////////////////////////////////////////////////////////////
// The Client
////////////////////////////////////////////////////////////////////////////////

export class FakeFsOnedriveFull extends FakeFs {
  kind: "onedrivefull";
  config: OnedriveFullConfig;
  remoteBaseDir: string;
  vaultFolderExists: boolean;
  auth: OneDriveFullAuthProvider;
  saveFunc: () => Promise<void>;
  foldersCreated: Set<string>;

  constructor(
    config: OnedriveFullConfig,
    vaultName: string,
    saveFunc: () => Promise<void>
  ) {
    super();
    this.kind = "onedrivefull";
    this.config = config;
    this.remoteBaseDir = config.remoteBaseDir || vaultName || "";
    this.vaultFolderExists = false;
    this.saveFunc = saveFunc;
    this.auth = new OneDriveFullAuthProvider(config, saveFunc);
    this.foldersCreated = new Set();
  }

  private _buildUrl(pathFrag: string): string {
    const API = "https://graph.microsoft.com/v1.0";
    let url = pathFrag.startsWith("http") ? pathFrag : `${API}${encodeURI(pathFrag)}`;
    url = url.replace(/#/g, "%23");
    return url;
  }
  private async _getJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(
      await request({
        url: this._buildUrl(path),
        method: "GET",
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${await this.auth.getAccessToken()}`,
          "Cache-Control": "no-cache",
        },
      })
    ) as T;
  }

  private async _postJson<T = unknown>(path: string, payload: unknown): Promise<T> {
    return JSON.parse(
      await request({
        url: this._buildUrl(path),
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify(payload),
        headers: {
          Authorization: `Bearer ${await this.auth.getAccessToken()}`,
        },
      })
    ) as T;
  }

  private async _patchJson<T = unknown>(path: string, payload: unknown): Promise<T> {
    return JSON.parse(
      await request({
        url: this._buildUrl(path),
        method: "PATCH",
        contentType: "application/json",
        body: JSON.stringify(payload),
        headers: {
          Authorization: `Bearer ${await this.auth.getAccessToken()}`,
        },
      })
    ) as T;
  }

  private async _deleteJson(path: string): Promise<void> {
    const url = this._buildUrl(path);
    if (VALID_REQURL) {
      await requestUrl({
        url,
        method: "DELETE",
        headers: { Authorization: `Bearer ${await this.auth.getAccessToken()}` },
      });
    } else {
      await retryFetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await this.auth.getAccessToken()}` },
      });
    }
  }

  private async _putArrayBuffer(
    path: string,
    payload: ArrayBuffer
  ): Promise<DriveItem | UploadSession> {
    const url = this._buildUrl(path);
    const token = await this.auth.getAccessToken();
    const res = await retryFetch(url, {
      method: "PUT",
      body: payload,
      headers: {
        "Content-Type": DEFAULT_CONTENT_TYPE,
        Authorization: `Bearer ${token}`,
      },
    });
    return (await res.json()) as DriveItem | UploadSession;
  }

  private async _putByRange(
    url: string,
    data: Uint8Array,
    start: number,
    end: number,
    total: number
  ): Promise<DriveItem | UploadSession> {
    // Upload session ranges — NO auth header
    const res = await retryFetch(url, {
      method: "PUT",
      body: data.slice(start, end).buffer,
      headers: {
        "Content-Length": `${end - start}`,
        "Content-Range": `bytes ${start}-${end - 1}/${total}`,
        "Content-Type": DEFAULT_CONTENT_TYPE,
      },
    });
    return (await res.json()) as DriveItem | UploadSession;
  }

  async _init(): Promise<void> {
    if (!this.config.accessToken || !this.config.refreshToken) {
      throw Error("OneDrive Full: user has not authorized yet.");
    }

    if (!this.vaultFolderExists) {
      // Check if the base dir exists at the drive root
      try {
        await this._getJson(`/drive/root:/${this.remoteBaseDir}`);
        this.vaultFolderExists = true;
      } catch {
        // Create it
        console.debug(`OneDrive Full: creating /${this.remoteBaseDir}`);
        await this._postJson("/drive/root/children", {
          name: this.remoteBaseDir,
          folder: {},
          "@microsoft.graph.conflictBehavior": "replace",
        });
        this.vaultFolderExists = true;
      }
    }
  }

  async listFoldersAtRoot(): Promise<string[]> {
    const k = await this._getJson<{ value: DriveItem[] }>("/drive/root/children");
    return k.value
      .filter((x) => "folder" in x)
      .map((x) => x.name!)
      .sort((a, b) => a.localeCompare(b));
  }

  async createFolderAtRoot(name: string): Promise<void> {
    await this._postJson("/drive/root/children", {
      name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
  }

  async walk(): Promise<Entity[]> {
    await this._init();

    const NEXT_KEY = "@odata.nextLink";
    const DELTA_KEY = "@odata.deltaLink";

    type DeltaResponse = {
      value: DriveItem[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };

    let res = await this._getJson<DeltaResponse>(
      `/drive/root:/${this.remoteBaseDir}:/delta`
    );
    const items = res.value;

    while (res[NEXT_KEY]) {
      res = await this._getJson<DeltaResponse>(res[NEXT_KEY]);
      items.push(...cloneDeep(res.value));
    }

    if (DELTA_KEY in res && res[DELTA_KEY]) {
      this.config.deltaLink = res[DELTA_KEY]!;
      await this.saveFunc();
    }

    return items
      .map((x) => fromDriveItemToEntity(x, this.remoteBaseDir))
      .filter((x) => x.key !== "/" && x.key !== "");
  }

  async walkPartial(): Promise<Entity[]> {
    await this._init();

    type DeltaResponse = {
      value: DriveItem[];
      "@odata.deltaLink"?: string;
    };

    const DELTA_KEY = "@odata.deltaLink";
    const res = await this._getJson<DeltaResponse>(
      `/drive/root:/${this.remoteBaseDir}:/delta`
    );
    const items = res.value;

    if (DELTA_KEY in res && res[DELTA_KEY]) {
      this.config.deltaLink = res[DELTA_KEY]!;
      await this.saveFunc();
    }

    return items
      .map((x) => fromDriveItemToEntity(x, this.remoteBaseDir))
      .filter((x) => x.key !== "/" && x.key !== "");
  }

  async stat(key: string): Promise<Entity> {
    await this._init();
    const path = getOnedrivePath(key, this.remoteBaseDir);
    const rsp = await this._getJson<DriveItem>(
      `${path}?$select=cTag,eTag,fileSystemInfo,folder,file,name,parentReference,size`
    );
    return fromDriveItemToEntity(rsp, this.remoteBaseDir);
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!key.endsWith("/")) throw Error(`mkdir called on non-folder: ${key}`);
    await this._init();

    const uploadFolder = getOnedrivePath(key, this.remoteBaseDir);
    if (!this.foldersCreated.has(uploadFolder)) {
      const payload: {
        folder: Record<string, never>;
        "@microsoft.graph.conflictBehavior": string;
        fileSystemInfo?: Record<string, string>;
      } = {
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace",
      };
      const fsi: Record<string, string> = {};
      if (mtime && mtime !== 0) fsi.lastModifiedDateTime = new Date(mtime).toISOString();
      if (ctime && ctime !== 0) fsi.createdDateTime = new Date(ctime).toISOString();
      if (Object.keys(fsi).length > 0) payload.fileSystemInfo = fsi;
      await this._patchJson(uploadFolder, payload);
      this.foldersCreated.add(uploadFolder);
    }
    return this.stat(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    if (key.endsWith("/")) throw Error(`writeFile called on folder: ${key}`);
    await this._init();

    if (content.byteLength === 0) {
      if (this.config.emptyFile === "error") {
        throw Error(
          `${key}: Empty files not allowed in OneDrive. Please add content.`
        );
      }
      return {
        key, keyRaw: key,
        mtimeSvr: mtime, mtimeCli: mtime, ctimeCli: ctime,
        size: 0, sizeRaw: 0, synthesizedFile: true,
      };
    }

    const remotePath = getOnedrivePath(key, this.remoteBaseDir);
    const mtimeStr = new Date(mtime).toISOString();
    const ctimeStr = new Date(ctime).toISOString();

    const DIRECT_MAX = 4_000_000; // 4 MB
    const RANGE_SIZE = 327680 * 20; // ~6.5 MB chunks

    if (content.byteLength < DIRECT_MAX) {
      await this._putArrayBuffer(
        `${remotePath}:/content?${new URLSearchParams({
          "@microsoft.graph.conflictBehavior": "replace",
        })}`,
        content
      );
      if (mtime !== 0 && ctime !== 0) {
        await this._patchJson(remotePath, {
          fileSystemInfo: {
            lastModifiedDateTime: mtimeStr,
            createdDateTime: ctimeStr,
          },
        });
      }
    } else {
      // Large file upload session
      const session = await this._postJson<UploadSession>(
        `${remotePath}:/createUploadSession`,
        {
          item: {
            "@microsoft.graph.conflictBehavior": "replace",
            fileSystemInfo: {
              lastModifiedDateTime: mtimeStr,
              createdDateTime: ctimeStr,
            },
          },
        }
      );
      const uploadUrl = session.uploadUrl!;
      const uint8 = new Uint8Array(content);
      let start = 0;
      while (start < uint8.byteLength) {
        await this._putByRange(
          uploadUrl,
          uint8,
          start,
          Math.min(start + RANGE_SIZE, uint8.byteLength),
          uint8.byteLength
        );
        start += RANGE_SIZE;
      }
    }

    return this.stat(key);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    await this._init();
    if (key.endsWith("/")) throw Error(`readFile called on folder: ${key}`);

    const remotePath = getOnedrivePath(key, this.remoteBaseDir);
    const rsp = await this._getJson<{ "@microsoft.graph.downloadUrl"?: string }>(
      `${remotePath}?$select=@microsoft.graph.downloadUrl`
    );
    const downloadUrl = rsp["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) {
      throw Error(`OneDrive Full: no downloadUrl returned for '${key}'`);
    }

    try {
      return await (await retryFetch(downloadUrl, { cache: "no-store" })).arrayBuffer();
    } catch {
      // Fallback for CORS issues
      return (await requestUrl({ url: downloadUrl, headers: { "Cache-Control": "no-cache" } })).arrayBuffer;
    }
  }

  async rename(key1: string, key2: string): Promise<void> {
    if (!key1 || key1 === "/" || !key2 || key2 === "/") return;
    await this._init();
    const remote1 = getOnedrivePath(key1, this.remoteBaseDir);
    const remote2 = getOnedrivePath(key2, this.remoteBaseDir);
    await this._patchJson(remote1, { name: remote2 });
  }

  async rm(key: string): Promise<void> {
    if (!key || key === "/") return;
    await this._init();
    await this._deleteJson(getOnedrivePath(key, this.remoteBaseDir));
  }

  async checkConnect(callbackFunc?: (err: unknown) => unknown): Promise<boolean> {
    try {
      const name = await this.getUserDisplayName();
      if (name === "<unknown>") throw Error("unknown display name");
    } catch (err) {
      callbackFunc?.(err);
      return false;
    }
    return this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    await this._init();
    const res = await this._getJson<User>("/me?$select=displayName");
    return res.displayName ?? "<unknown>";
  }

  async revokeAuth(): Promise<void> {
    throw new Error("Visit https://account.live.com/consent/Manage to revoke.");
  }

  async getRevokeAddr(): Promise<string> {
    return "https://account.live.com/consent/Manage";
  }

  supportsRename(): boolean { return true; }

  allowEmptyFile(): boolean {
    return false;
  }
}

export const getShrinkedSettings = (config: OnedriveFullConfig) => {
  const c = cloneDeep(config);
  c.accessToken = "x";
  c.accessTokenExpiresInSeconds = 1;
  c.accessTokenExpiresAtTime = 1;
  return c;
};
