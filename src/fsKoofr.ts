/**
 * BYOC — Koofr Filesystem Adapter
 * Clean-room implementation using Koofr REST API v2.
 * OAuth2 authorization code flow with silent token refresh.
 */

import { request } from "obsidian";
import {
  COMMAND_CALLBACK_KOOFR,
  KOOFR_CLIENT_ID,
  KOOFR_CLIENT_SECRET,
  type Entity,
  type KoofrConfig,
} from "./baseTypes";
import { FakeFs } from "./fsAll";
import { retryFetch } from "./misc";

const KOOFR_AUTH_URL = "https://app.koofr.net/oauth2/auth";
const KOOFR_TOKEN_URL = "https://app.koofr.net/oauth2/token";
const REDIRECT_URI = `obsidian://${COMMAND_CALLBACK_KOOFR}`;

export const DEFAULT_KOOFR_CONFIG: KoofrConfig = {
  accessToken: "",
  accessTokenExpiresInMs: 0,
  accessTokenExpiresAtTimeMs: 0,
  refreshToken: "",
  remoteBaseDir: "",
  credentialsShouldBeDeletedAtTimeMs: 0,
  scope: "",
  api: "https://app.koofr.net",
  mountID: "",
  kind: "koofr",
};

////////////////////////////////////////////////////////////////////////////////
// Koofr API response types
////////////////////////////////////////////////////////////////////////////////

interface KoofrOAuthRes {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface KoofrMount {
  id: string;
  isPrimary?: boolean;
  name?: string;
}

interface KoofrMountsRes {
  mounts?: KoofrMount[];
}

interface KoofrFile {
  name: string;
  type: string;
  modified?: number;
  size?: number;
  hash?: string;
}

interface KoofrFileList {
  files?: KoofrFile[];
}

interface KoofrFileInfo {
  type?: string;
  modified?: number;
  size?: number;
  hash?: string;
}

interface KoofrUser {
  firstName?: string;
  lastName?: string;
}

////////////////////////////////////////////////////////////////////////////////
// OAuth2 Helpers
////////////////////////////////////////////////////////////////////////////////

export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: KOOFR_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "",
  });
  return `${KOOFR_AUTH_URL}?${params.toString()}`;
}

export async function sendAuthReq(
  code: string,
  errorCallBack: (e: unknown) => Promise<void>
): Promise<KoofrOAuthRes> {
  try {
    const rsp = await request({
      url: KOOFR_TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: KOOFR_CLIENT_ID,
        client_secret: KOOFR_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    return JSON.parse(rsp) as KoofrOAuthRes;
  } catch (e) {
    console.error(e);
    await errorCallBack(e);
    throw e;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<KoofrOAuthRes> {
  const rsp = await request({
    url: KOOFR_TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: KOOFR_CLIENT_ID,
      client_secret: KOOFR_CLIENT_SECRET,
    }).toString(),
  });
  return JSON.parse(rsp) as KoofrOAuthRes;
}

export async function setConfigBySuccessfullAuthInplace(
  config: KoofrConfig,
  authRes: KoofrOAuthRes,
  saveFunc: () => Promise<void>
): Promise<void> {
  config.accessToken = authRes.access_token;
  config.refreshToken = authRes.refresh_token ?? config.refreshToken;
  config.accessTokenExpiresInMs = (authRes.expires_in ?? 3600) * 1000;
  config.accessTokenExpiresAtTimeMs =
    Date.now() + (authRes.expires_in ?? 3600) * 1000 - 300_000;
  config.credentialsShouldBeDeletedAtTimeMs = 0;
  await saveFunc();
}

////////////////////////////////////////////////////////////////////////////////
// Path Helpers
////////////////////////////////////////////////////////////////////////////////

function getRemotePath(key: string, remoteBaseDir: string): string {
  if (!key || key === "/") return `/${remoteBaseDir}`;
  const clean = key.endsWith("/") ? key.slice(0, -1) : key;
  return `/${remoteBaseDir}/${clean}`;
}

////////////////////////////////////////////////////////////////////////////////
// The Client
////////////////////////////////////////////////////////////////////////////////

interface RequestOpts {
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType?: string;
  body?: string;
}

export class FakeFsKoofr extends FakeFs {
  kind = "koofr";
  private config: KoofrConfig;
  private vaultName: string;
  private saveFunc: () => Promise<void>;
  private remoteBaseDir: string;
  private apiBase: string;

  constructor(
    config: KoofrConfig,
    vaultName: string,
    saveFunc: () => Promise<void>
  ) {
    super();
    this.config = config;
    this.vaultName = vaultName;
    this.saveFunc = saveFunc;
    this.remoteBaseDir = config.remoteBaseDir || vaultName || "";
    this.apiBase = config.api || "https://app.koofr.net";
  }

  private async ensureToken(): Promise<string> {
    if (!this.config.accessToken) {
      throw Error("[BYOC] Koofr: not authorized.");
    }

    if (
      this.config.refreshToken &&
      this.config.accessTokenExpiresAtTimeMs > 0 &&
      this.config.accessTokenExpiresAtTimeMs < Date.now()
    ) {
      const res = await refreshAccessToken(this.config.refreshToken);
      if (res.error) {
        throw Error(`[BYOC] Koofr refresh error: ${res.error_description ?? res.error}`);
      }
      this.config.accessToken = res.access_token;
      if (res.refresh_token) this.config.refreshToken = res.refresh_token;
      this.config.accessTokenExpiresAtTimeMs =
        Date.now() + (res.expires_in ?? 3600) * 1000 - 300_000;
      await this.saveFunc();
    }

    return this.config.accessToken;
  }

  private async ensureMountID(): Promise<string> {
    if (this.config.mountID) return this.config.mountID;

    // Get the primary mount (default storage)
    const mounts = await this._getJson<KoofrMountsRes>("/api/v2/mounts");
    if (mounts.mounts && mounts.mounts.length > 0) {
      // Find the primary mount
      const primary = mounts.mounts.find((m) => m.isPrimary) ?? mounts.mounts[0];
      this.config.mountID = primary.id;
      await this.saveFunc();
      return this.config.mountID;
    }
    throw Error("[BYOC] Koofr: no mounts found");
  }

  private async _getJson<T = unknown>(path: string): Promise<T> {
    const token = await this.ensureToken();
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    return JSON.parse(
      await request({
        url,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      })
    ) as T;
  }

  private async _postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
    const token = await this.ensureToken();
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    const opts: RequestOpts = {
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    };
    if (body) {
      opts.contentType = "application/json";
      opts.body = JSON.stringify(body);
    }
    const rsp = await request(opts);
    return (rsp ? JSON.parse(rsp) : {}) as T;
  }

  private async _delete(path: string): Promise<void> {
    const token = await this.ensureToken();
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    await retryFetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async ensureBaseDir(): Promise<void> {
    const mountID = await this.ensureMountID();
    const remotePath = `/${this.remoteBaseDir}`;

    try {
      await this._getJson(
        `/api/v2/mounts/${mountID}/files/info?path=${encodeURIComponent(remotePath)}`
      );
    } catch {
      // Create the base directory
      await this._postJson(
        `/api/v2/mounts/${mountID}/files/folder?path=${encodeURIComponent("/")}`,
        { name: this.remoteBaseDir }
      );
    }
  }

  /**
   * Recursively list all files in the Koofr mount under remoteBaseDir.
   */
  private async listRecursive(
    mountID: string,
    remotePath: string,
    entities: Entity[]
  ): Promise<void> {
    const res = await this._getJson<KoofrFileList>(
      `/api/v2/mounts/${mountID}/files/list?path=${encodeURIComponent(remotePath)}`
    );
    const files = res.files ?? [];

    for (const item of files) {
      const itemPath = `${remotePath === "/" ? "" : remotePath}/${item.name}`;
      const basePrefix = `/${this.remoteBaseDir}/`;
      let key = "";

      if (itemPath.startsWith(basePrefix)) {
        key = itemPath.slice(basePrefix.length);
      } else if (itemPath === `/${this.remoteBaseDir}`) {
        continue;
      } else {
        key = item.name;
      }

      const isFolder = item.type === "dir";
      if (isFolder) {
        if (!key.endsWith("/")) key = `${key}/`;
        entities.push({
          key, keyRaw: key,
          mtimeSvr: item.modified ?? 0,
          size: 0, sizeRaw: 0,
        });
        // Recurse
        await this.listRecursive(mountID, itemPath, entities);
      } else {
        entities.push({
          key, keyRaw: key,
          mtimeSvr: item.modified ?? 0,
          mtimeCli: item.modified ?? 0,
          size: item.size ?? 0,
          sizeRaw: item.size ?? 0,
          hash: item.hash,
        });
      }
    }
  }

  async listFoldersAtRoot(): Promise<string[]> {
    const mountID = await this.ensureMountID();
    const res = await this._getJson<KoofrFileList>(
      `/api/v2/mounts/${mountID}/files/list?path=${encodeURIComponent("/")}`
    );
    return (res.files ?? [])
      .filter((item) => item.type === "dir")
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b));
  }

  async createFolderAtRoot(name: string): Promise<void> {
    const mountID = await this.ensureMountID();
    await this._postJson(
      `/api/v2/mounts/${mountID}/files/folder?path=${encodeURIComponent("/")}`,
      { name }
    );
  }

  async walk(): Promise<Entity[]> {
    await this.ensureBaseDir();
    const mountID = await this.ensureMountID();
    const entities: Entity[] = [];
    await this.listRecursive(mountID, `/${this.remoteBaseDir}`, entities);
    return entities;
  }

  async walkPartial(): Promise<Entity[]> {
    return this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const mountID = await this.ensureMountID();
    const remotePath = getRemotePath(key, this.remoteBaseDir);
    const res = await this._getJson<KoofrFileInfo>(
      `/api/v2/mounts/${mountID}/files/info?path=${encodeURIComponent(remotePath)}`
    );

    const isFolder = res.type === "dir";
    return {
      key, keyRaw: key,
      mtimeSvr: res.modified ?? 0,
      mtimeCli: res.modified ?? 0,
      size: isFolder ? 0 : (res.size ?? 0),
      sizeRaw: isFolder ? 0 : (res.size ?? 0),
      hash: res.hash,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    const mountID = await this.ensureMountID();
    const folderName = key.replace(/\/+$/, "").split("/").pop()!;
    const parentKey = key.replace(/\/+$/, "");
    const parentPath = parentKey.includes("/")
      ? `/${this.remoteBaseDir}/${parentKey.slice(0, parentKey.lastIndexOf("/"))}`
      : `/${this.remoteBaseDir}`;

    try {
      await this._postJson(
        `/api/v2/mounts/${mountID}/files/folder?path=${encodeURIComponent(parentPath)}`,
        { name: folderName }
      );
    } catch (e: unknown) {
      // Already exists is fine
      if (!String(e).includes("409") && !String(e).includes("AlreadyExists")) {
        throw e;
      }
    }

    return { key, keyRaw: key, size: 0, sizeRaw: 0 };
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const mountID = await this.ensureMountID();
    const remotePath = getRemotePath(key, this.remoteBaseDir);
    const fileName = key.split("/").pop()!;
    const parentPath = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";

    const token = await this.ensureToken();

    // Koofr file upload uses multipart form with PUT
    const formData = new FormData();
    formData.append("file", new Blob([content]), fileName);

    const resp = await retryFetch(
      `${this.apiBase}/api/v2/mounts/${mountID}/files/put?path=${encodeURIComponent(parentPath)}&filename=${encodeURIComponent(fileName)}&autorename=false&overwrite=true`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }
    );

    if (!resp.ok) {
      throw Error(`[BYOC] Koofr: upload failed for '${key}': ${resp.status}`);
    }

    return {
      key, keyRaw: key,
      mtimeCli: mtime, ctimeCli: ctime,
      size: content.byteLength,
      sizeRaw: content.byteLength,
    };
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const mountID = await this.ensureMountID();
    const remotePath = getRemotePath(key, this.remoteBaseDir);
    const token = await this.ensureToken();

    const resp = await retryFetch(
      `${this.apiBase}/api/v2/mounts/${mountID}/files/get?path=${encodeURIComponent(remotePath)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!resp.ok) {
      throw Error(`[BYOC] Koofr: download failed for '${key}': ${resp.status}`);
    }
    return resp.arrayBuffer();
  }

  async rename(key1: string, key2: string): Promise<void> {
    const mountID = await this.ensureMountID();
    const from = getRemotePath(key1, this.remoteBaseDir);
    const to = getRemotePath(key2, this.remoteBaseDir);
    const toName = key2.split("/").pop()!;
    const toParent = to.slice(0, to.lastIndexOf("/")) || "/";

    await this._postJson(
      `/api/v2/mounts/${mountID}/files/move?path=${encodeURIComponent(from)}`,
      {
        toMountId: mountID,
        toPath: toParent,
        toName: toName,
      }
    );
  }

  async rm(key: string): Promise<void> {
    const mountID = await this.ensureMountID();
    const remotePath = getRemotePath(key, this.remoteBaseDir);

    try {
      await this._delete(
        `${this.apiBase}/api/v2/mounts/${mountID}/files/remove?path=${encodeURIComponent(remotePath)}`
      );
    } catch (e: unknown) {
      // 404 = already gone
      if (!String(e).includes("404") && !String(e).includes("NotFound")) throw e;
    }
  }

  async checkConnect(callbackFunc?: (err: unknown) => unknown): Promise<boolean> {
    return this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    const res = await this._getJson<KoofrUser>("/api/v2/user");
    return `${res.firstName ?? ""} ${res.lastName ?? ""}`.trim() || "Koofr User";
  }

  async revokeAuth(): Promise<void> {
    this.config.accessToken = "";
    this.config.refreshToken = "";
    this.config.mountID = "";
    await this.saveFunc();
  }

  supportsRename(): boolean { return true; }

  allowEmptyFile(): boolean {
    return true;
  }
}
