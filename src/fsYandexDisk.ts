/**
 * BYOC — Yandex Disk Filesystem Adapter
 * Clean-room implementation using Yandex Disk REST API v1.
 * OAuth2 authorization code flow with silent token refresh.
 */

import { request } from "obsidian";
import {
  COMMAND_CALLBACK_YANDEXDISK,
  YANDEXDISK_CLIENT_ID,
  YANDEXDISK_CLIENT_SECRET,
  type Entity,
  type YandexDiskConfig,
} from "./baseTypes";
import { FakeFs } from "./fsAll";
import { retryFetch } from "./misc";

const YANDEX_API = "https://cloud-api.yandex.net/v1/disk";
const YANDEX_AUTH_URL = "https://oauth.yandex.com/authorize";
const YANDEX_TOKEN_URL = "https://oauth.yandex.com/token";
const REDIRECT_URI = `obsidian://${COMMAND_CALLBACK_YANDEXDISK}`;

export const DEFAULT_YANDEXDISK_CONFIG: YandexDiskConfig = {
  accessToken: "",
  accessTokenExpiresInMs: 0,
  accessTokenExpiresAtTimeMs: 0,
  refreshToken: "",
  remoteBaseDir: "",
  credentialsShouldBeDeletedAtTimeMs: 0,
  scope: "cloud_api:disk.app_folder cloud_api:disk.read cloud_api:disk.write",
  kind: "yandexdisk",
};

////////////////////////////////////////////////////////////////////////////////
// OAuth2 Helpers
////////////////////////////////////////////////////////////////////////////////

export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: YANDEXDISK_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    force_confirm: "yes",
  });
  return `${YANDEX_AUTH_URL}?${params.toString()}`;
}

export async function sendAuthReq(
  code: string,
  errorCallBack: (e: any) => Promise<void>
): Promise<any> {
  try {
    const rsp = await request({
      url: YANDEX_TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: YANDEXDISK_CLIENT_ID,
        client_secret: YANDEXDISK_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    return JSON.parse(rsp);
  } catch (e) {
    console.error(e);
    await errorCallBack(e);
  }
}

async function refreshAccessToken(refreshToken: string): Promise<any> {
  const rsp = await request({
    url: YANDEX_TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: YANDEXDISK_CLIENT_ID,
      client_secret: YANDEXDISK_CLIENT_SECRET,
    }).toString(),
  });
  return JSON.parse(rsp);
}

export async function setConfigBySuccessfullAuthInplace(
  config: YandexDiskConfig,
  authRes: any,
  saveFunc: () => Promise<void>
): Promise<void> {
  config.accessToken = authRes.access_token;
  config.refreshToken = authRes.refresh_token || config.refreshToken;
  config.accessTokenExpiresInMs = (authRes.expires_in ?? 31536000) * 1000;
  config.accessTokenExpiresAtTimeMs =
    Date.now() + (authRes.expires_in ?? 31536000) * 1000 - 300_000;
  config.credentialsShouldBeDeletedAtTimeMs = 0;
  await saveFunc();
}

////////////////////////////////////////////////////////////////////////////////
// Path Helpers
////////////////////////////////////////////////////////////////////////////////

function getRemotePath(key: string, remoteBaseDir: string): string {
  if (!key || key === "/") return `disk:/${remoteBaseDir}`;
  const clean = key.endsWith("/") ? key.slice(0, -1) : key;
  return `disk:/${remoteBaseDir}/${clean}`;
}

function normalizeKey(path: string, remoteBaseDir: string): string {
  const prefix = `disk:/${remoteBaseDir}/`;
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  const prefix2 = `disk:/${remoteBaseDir}`;
  if (path === prefix2) return "";
  return path;
}

////////////////////////////////////////////////////////////////////////////////
// The Client
////////////////////////////////////////////////////////////////////////////////

export class FakeFsYandexDisk extends FakeFs {
  kind = "yandexdisk";
  private config: YandexDiskConfig;
  private vaultName: string;
  private saveFunc: () => Promise<any>;
  private remoteBaseDir: string;

  constructor(
    config: YandexDiskConfig,
    vaultName: string,
    saveFunc: () => Promise<any>
  ) {
    super();
    this.config = config;
    this.vaultName = vaultName;
    this.saveFunc = saveFunc;
    this.remoteBaseDir = config.remoteBaseDir || vaultName || "";
  }

  private async ensureToken(): Promise<string> {
    if (!this.config.accessToken) {
      throw Error("[BYOC] Yandex Disk: not authorized.");
    }

    // Yandex tokens last a very long time (up to 1 year)
    // but we still refresh if we have a refresh token and it's expiring
    if (
      this.config.refreshToken &&
      this.config.accessTokenExpiresAtTimeMs > 0 &&
      this.config.accessTokenExpiresAtTimeMs < Date.now()
    ) {
      const res = await refreshAccessToken(this.config.refreshToken);
      if (res.error) {
        throw Error(`[BYOC] Yandex refresh error: ${res.error_description}`);
      }
      this.config.accessToken = res.access_token;
      if (res.refresh_token) this.config.refreshToken = res.refresh_token;
      this.config.accessTokenExpiresAtTimeMs =
        Date.now() + (res.expires_in ?? 31536000) * 1000 - 300_000;
      await this.saveFunc();
    }

    return this.config.accessToken;
  }

  private async _getJson(url: string): Promise<any> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${YANDEX_API}${url}`;
    return JSON.parse(
      await request({
        url: fullUrl,
        method: "GET",
        headers: { Authorization: `OAuth ${token}` },
      })
    );
  }

  private async _put(url: string, body?: any): Promise<any> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${YANDEX_API}${url}`;
    const opts: any = {
      url: fullUrl,
      method: "PUT",
      headers: { Authorization: `OAuth ${token}` },
    };
    if (body) {
      opts.contentType = "application/json";
      opts.body = JSON.stringify(body);
    }
    const rsp = await request(opts);
    return rsp ? JSON.parse(rsp) : {};
  }

  private async _delete(url: string): Promise<void> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${YANDEX_API}${url}`;
    await request({
      url: fullUrl,
      method: "DELETE",
      headers: { Authorization: `OAuth ${token}` },
    });
  }

  private async ensureBaseDir(): Promise<void> {
    try {
      await this._getJson(
        `/resources?path=${encodeURIComponent(`disk:/${this.remoteBaseDir}`)}`
      );
    } catch {
      // Create base dir
      await this._put(
        `/resources?path=${encodeURIComponent(`disk:/${this.remoteBaseDir}`)}`
      );
    }
  }

  async walk(): Promise<Entity[]> {
    await this.ensureBaseDir();

    const entities: Entity[] = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const path = encodeURIComponent(`disk:/${this.remoteBaseDir}`);
      const res = await this._getJson(
        `/resources?path=${path}&limit=${limit}&offset=${offset}&fields=_embedded.items.path,_embedded.items.type,_embedded.items.size,_embedded.items.modified,_embedded.items.created,_embedded.total`
      );

      // Yandex Disk /resources returns embedded items for folders
      // We need to use /resources/files for a flat listing
      break; // We'll use the flat files endpoint instead
    }

    // Use flat file listing — much more efficient
    let flatOffset = 0;
    while (true) {
      const res = await this._getJson(
        `/resources/files?limit=${limit}&offset=${flatOffset}&fields=items.path,items.type,items.size,items.modified,items.created`
      );
      const items = res.items || [];

      for (const item of items) {
        let key = normalizeKey(item.path, this.remoteBaseDir);
        if (!key) continue;
        // Filter out items not under our base dir
        if (
          !item.path.startsWith(`disk:/${this.remoteBaseDir}/`) &&
          item.path !== `disk:/${this.remoteBaseDir}`
        ) {
          continue;
        }

        const isFolder = item.type === "dir";
        if (isFolder && !key.endsWith("/")) key = `${key}/`;

        const mtime = item.modified ? new Date(item.modified).getTime() : 0;
        const ctime = item.created ? new Date(item.created).getTime() : mtime;

        entities.push({
          key, keyRaw: key,
          mtimeSvr: mtime, mtimeCli: mtime, ctimeCli: ctime,
          size: isFolder ? 0 : (item.size ?? 0),
          sizeRaw: isFolder ? 0 : (item.size ?? 0),
        } as Entity);
      }

      flatOffset += items.length;
      if (items.length < limit) break;
    }

    // Also list folders recursively
    await this.walkFolders(
      `disk:/${this.remoteBaseDir}`,
      entities
    );

    return entities;
  }

  private async walkFolders(
    folderPath: string,
    entities: Entity[]
  ): Promise<void> {
    const res = await this._getJson(
      `/resources?path=${encodeURIComponent(folderPath)}&limit=1000&fields=_embedded.items.path,_embedded.items.type,_embedded.items.size,_embedded.items.modified,_embedded.items.created`
    );

    const items = res._embedded?.items || [];
    for (const item of items) {
      if (item.type === "dir") {
        let key = normalizeKey(item.path, this.remoteBaseDir);
        if (key && !key.endsWith("/")) key = `${key}/`;
        if (key) {
          const mtime = item.modified ? new Date(item.modified).getTime() : 0;
          entities.push({
            key, keyRaw: key,
            mtimeSvr: mtime, size: 0, sizeRaw: 0,
          } as Entity);
        }
        // Recurse into subfolder
        await this.walkFolders(item.path, entities);
      }
    }
  }

  async walkPartial(): Promise<Entity[]> {
    return this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const remotePath = getRemotePath(key, this.remoteBaseDir);
    const res = await this._getJson(
      `/resources?path=${encodeURIComponent(remotePath)}&fields=path,type,size,modified,created`
    );

    const isFolder = res.type === "dir";
    let normalKey = normalizeKey(res.path, this.remoteBaseDir);
    if (isFolder && !normalKey.endsWith("/")) normalKey = `${normalKey}/`;

    const mtime = res.modified ? new Date(res.modified).getTime() : 0;
    const ctime = res.created ? new Date(res.created).getTime() : mtime;

    return {
      key: normalKey, keyRaw: normalKey,
      mtimeSvr: mtime, mtimeCli: mtime, ctimeCli: ctime,
      size: isFolder ? 0 : (res.size ?? 0),
      sizeRaw: isFolder ? 0 : (res.size ?? 0),
    } as Entity;
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    const remotePath = getRemotePath(key, this.remoteBaseDir);
    try {
      await this._put(
        `/resources?path=${encodeURIComponent(remotePath)}`
      );
    } catch (e: any) {
      // 409 = already exists, that's fine
      if (!String(e).includes("409")) throw e;
    }
    return { key, keyRaw: key, size: 0, sizeRaw: 0 } as Entity;
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const remotePath = getRemotePath(key, this.remoteBaseDir);

    // Step 1: Get upload URL from Yandex
    const uploadInfo = await this._getJson(
      `/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`
    );

    if (!uploadInfo.href) {
      throw Error(`[BYOC] Yandex: no upload URL returned for '${key}'`);
    }

    // Step 2: PUT the content to the upload URL (no auth header needed)
    const resp = await retryFetch(uploadInfo.href, {
      method: "PUT",
      body: content,
      headers: { "Content-Type": "application/octet-stream" },
    });

    if (!resp.ok) {
      throw Error(`[BYOC] Yandex: upload failed for '${key}': ${resp.status}`);
    }

    return {
      key, keyRaw: key,
      mtimeCli: mtime, ctimeCli: ctime,
      size: content.byteLength,
      sizeRaw: content.byteLength,
    } as Entity;
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const remotePath = getRemotePath(key, this.remoteBaseDir);

    // Step 1: Get download URL
    const downloadInfo = await this._getJson(
      `/resources/download?path=${encodeURIComponent(remotePath)}`
    );

    if (!downloadInfo.href) {
      throw Error(`[BYOC] Yandex: no download URL returned for '${key}'`);
    }

    // Step 2: Download the content
    const resp = await retryFetch(downloadInfo.href);
    if (!resp.ok) {
      throw Error(`[BYOC] Yandex: download failed for '${key}': ${resp.status}`);
    }
    return resp.arrayBuffer();
  }

  async rename(key1: string, key2: string): Promise<void> {
    const from = getRemotePath(key1, this.remoteBaseDir);
    const to = getRemotePath(key2, this.remoteBaseDir);
    await this._postMove(from, to);
  }

  private async _postMove(from: string, to: string): Promise<void> {
    const token = await this.ensureToken();
    await request({
      url: `${YANDEX_API}/resources/move?from=${encodeURIComponent(from)}&path=${encodeURIComponent(to)}&overwrite=true`,
      method: "POST",
      headers: { Authorization: `OAuth ${token}` },
    });
  }

  async rm(key: string): Promise<void> {
    const remotePath = getRemotePath(key, this.remoteBaseDir);
    try {
      await this._delete(
        `/resources?path=${encodeURIComponent(remotePath)}&permanently=true`
      );
    } catch (e: any) {
      // 404 = already gone
      if (!String(e).includes("404")) throw e;
    }
  }

  async checkConnect(callbackFunc?: any): Promise<boolean> {
    return this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    const res = await this._getJson("");
    return res.user?.display_name || res.user?.login || "Yandex Disk User";
  }

  async revokeAuth(): Promise<any> {
    this.config.accessToken = "";
    this.config.refreshToken = "";
    await this.saveFunc();
  }

  supportsRename(): boolean { return true; }

  allowEmptyFile(): boolean {
    return true;
  }
}
