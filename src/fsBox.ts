/**
 * BYOC — Box Filesystem Adapter
 * Clean-room implementation using Box Content API v2.
 * OAuth2 authorization code flow with silent token refresh.
 */

import { request, requestUrl } from "obsidian";
import {
  BOX_CLIENT_ID,
  BOX_CLIENT_SECRET,
  COMMAND_CALLBACK_BOX,
  DEFAULT_CONTENT_TYPE,
  type BoxConfig,
  type Entity,
} from "./baseTypes";
import { VALID_REQURL } from "./baseTypesObs";
import { FakeFs } from "./fsAll";
import { retryFetch } from "./misc";

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const BOX_AUTH_URL = "https://account.box.com/api/oauth2/authorize";
const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";
const REDIRECT_URI = "https://bringyourowncloud.xyz/auth/box/callback";

export const DEFAULT_BOX_CONFIG: BoxConfig = {
  accessToken: "",
  accessTokenExpiresInMs: 0,
  accessTokenExpiresAtTimeMs: 0,
  refreshToken: "",
  remoteBaseDir: "",
  credentialsShouldBeDeletedAtTimeMs: 0,
  kind: "box",
};

////////////////////////////////////////////////////////////////////////////////
// OAuth2 Helpers
////////////////////////////////////////////////////////////////////////////////

export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: BOX_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  return `${BOX_AUTH_URL}?${params.toString()}`;
}

export async function sendAuthReq(
  code: string,
  errorCallBack: (e: unknown) => Promise<void>
): Promise<any> {
  try {
    const rsp = await request({
      url: BOX_TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: BOX_CLIENT_ID,
        client_secret: BOX_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    return JSON.parse(rsp);
  } catch (e) {
    console.error(e);
    await errorCallBack(e);
  }
}

async function refreshAccessToken(
  refreshToken: string
): Promise<any> {
  const rsp = await request({
    url: BOX_TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: BOX_CLIENT_ID,
      client_secret: BOX_CLIENT_SECRET,
    }).toString(),
  });
  return JSON.parse(rsp);
}

export async function setConfigBySuccessfullAuthInplace(
  config: BoxConfig,
  authRes: any,
  saveFunc: () => Promise<void>
): Promise<void> {
  config.accessToken = authRes.access_token;
  config.refreshToken = authRes.refresh_token;
  config.accessTokenExpiresInMs = authRes.expires_in * 1000;
  config.accessTokenExpiresAtTimeMs =
    Date.now() + authRes.expires_in * 1000 - 300_000;
  // BYOC: No forced expiry
  config.credentialsShouldBeDeletedAtTimeMs = 0;
  await saveFunc();
}

////////////////////////////////////////////////////////////////////////////////
// Internal Helpers
////////////////////////////////////////////////////////////////////////////////

/**
 * Box uses folder IDs, not paths. We need to resolve a path to a folder ID.
 * This caches folder IDs as we discover them.
 */
class BoxPathResolver {
  private cache: Map<string, string> = new Map([["", "0"]]); // root = "0"

  async resolve(
    path: string,
    getJson: (url: string) => Promise<any>,
    createIfMissing = false,
    postJson?: (url: string, body: any) => Promise<any>
  ): Promise<string> {
    if (path === "" || path === "/") return "0";

    // Normalize: remove leading/trailing slashes
    const normalized = path.replace(/^\/+|\/+$/g, "");
    if (this.cache.has(normalized)) return this.cache.get(normalized)!;

    // Walk segments
    const segments = normalized.split("/");
    let parentId = "0";

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const partialPath = segments.slice(0, i + 1).join("/");

      if (this.cache.has(partialPath)) {
        parentId = this.cache.get(partialPath)!;
        continue;
      }

      // Search for folder in parent
      const searchUrl = `${BOX_API}/folders/${parentId}/items?fields=id,name,type&limit=1000`;
      const res = await getJson(searchUrl);
      const entries = res.entries || [];

      const match = entries.find(
        (e: any) => e.name === seg && e.type === "folder"
      );

      if (match) {
        parentId = match.id;
        this.cache.set(partialPath, parentId);
      } else if (createIfMissing && postJson) {
        // Create the folder
        const created = await postJson(`${BOX_API}/folders`, {
          name: seg,
          parent: { id: parentId },
        });
        parentId = created.id;
        this.cache.set(partialPath, parentId);
      } else {
        throw Error(`[BYOC] Box: folder '${seg}' not found in parent ${parentId}`);
      }
    }

    return parentId;
  }

  set(path: string, id: string) {
    this.cache.set(path.replace(/^\/+|\/+$/g, ""), id);
  }
}

function fromBoxItemToEntity(item: any, baseDirPrefix: string): Entity {
  let key = "";

  // Build the key from path_collection
  if (item.path_collection?.entries) {
    const parts = item.path_collection.entries
      .map((e: any) => e.name)
      .filter((n: string) => n !== "All Files");
    parts.push(item.name);
    key = parts.join("/");

    // Strip the base dir prefix
    if (baseDirPrefix && key.startsWith(`${baseDirPrefix}/`)) {
      key = key.slice(baseDirPrefix.length + 1);
    } else if (key === baseDirPrefix) {
      key = "";
    }
  } else {
    key = item.name || "";
  }

  const isFolder = item.type === "folder";
  if (isFolder && !key.endsWith("/")) {
    key = `${key}/`;
  }

  const mtime = item.modified_at
    ? new Date(item.modified_at).getTime()
    : Date.now();
  const ctime = item.created_at
    ? new Date(item.created_at).getTime()
    : mtime;

  return {
    key: key,
    keyRaw: key,
    mtimeSvr: mtime,
    mtimeCli: mtime,
    ctimeCli: ctime,
    size: isFolder ? 0 : (item.size ?? 0),
    sizeRaw: isFolder ? 0 : (item.size ?? 0),
    etag: item.etag,
  };
}

////////////////////////////////////////////////////////////////////////////////
// The Client
////////////////////////////////////////////////////////////////////////////////

export class FakeFsBox extends FakeFs {
  kind = "box";
  private config: BoxConfig;
  private vaultName: string;
  private saveFunc: () => Promise<void>;
  private pathResolver: BoxPathResolver;
  private remoteBaseDir: string;

  constructor(
    config: BoxConfig,
    vaultName: string,
    saveFunc: () => Promise<void>
  ) {
    super();
    this.config = config;
    this.vaultName = vaultName;
    this.saveFunc = saveFunc;
    this.pathResolver = new BoxPathResolver();
    this.remoteBaseDir = config.remoteBaseDir || vaultName || "";
  }

  private async ensureToken(): Promise<string> {
    if (!this.config.accessToken || !this.config.refreshToken) {
      throw Error("[BYOC] Box: user has not authorized yet.");
    }

    if (this.config.accessTokenExpiresAtTimeMs > Date.now()) {
      return this.config.accessToken;
    }

    // Refresh
    const res = await refreshAccessToken(this.config.refreshToken);
    if (res.error) {
      throw Error(`[BYOC] Box refresh error: ${res.error_description}`);
    }
    this.config.accessToken = res.access_token;
    this.config.refreshToken = res.refresh_token;
    this.config.accessTokenExpiresInMs = res.expires_in * 1000;
    this.config.accessTokenExpiresAtTimeMs =
      Date.now() + res.expires_in * 1000 - 300_000;
    await this.saveFunc();
    return this.config.accessToken;
  }

  private async _getJson(url: string): Promise<any> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${BOX_API}${url}`;
    return JSON.parse(
      await request({
        url: fullUrl,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  private async _postJson(url: string, body: any): Promise<any> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${BOX_API}${url}`;
    return JSON.parse(
      await request({
        url: fullUrl,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  private async _putJson(url: string, body: any): Promise<any> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${BOX_API}${url}`;
    return JSON.parse(
      await request({
        url: fullUrl,
        method: "PUT",
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  private async _delete(url: string): Promise<void> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${BOX_API}${url}`;
    await retryFetch(fullUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async getBaseFolderId(): Promise<string> {
    return this.pathResolver.resolve(
      this.remoteBaseDir,
      (u) => this._getJson(u),
      true,
      (u, b) => this._postJson(u, b)
    );
  }

  /**
   * Recursively list all items in a Box folder.
   */
  private async listFolder(
    folderId: string,
    pathPrefix: string
  ): Promise<any[]> {
    const items: any[] = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const res = await this._getJson(
        `${BOX_API}/folders/${folderId}/items?fields=id,name,type,size,modified_at,created_at,etag,path_collection&limit=${limit}&offset=${offset}`
      );
      const entries = res.entries || [];
      for (const entry of entries) {
        items.push(entry);
        if (entry.type === "folder") {
          const subItems = await this.listFolder(
            entry.id,
            `${pathPrefix}${entry.name}/`
          );
          items.push(...subItems);
        }
      }
      offset += entries.length;
      if (offset >= (res.total_count ?? entries.length)) break;
      if (entries.length === 0) break;
    }

    return items;
  }

  async listFoldersAtRoot(): Promise<string[]> {
    const res = await this._getJson(
      `${BOX_API}/folders/0/items?fields=id,name,type&limit=1000`
    );
    return (res.entries || [])
      .filter((e: any) => e.type === "folder")
      .map((e: any) => e.name as string)
      .sort((a: string, b: string) => a.localeCompare(b));
  }

  async createFolderAtRoot(name: string): Promise<void> {
    await this._postJson(`${BOX_API}/folders`, {
      name,
      parent: { id: "0" },
    });
  }

  async walk(): Promise<Entity[]> {
    const baseFolderId = await this.getBaseFolderId();
    const items = await this.listFolder(baseFolderId, "");

    return items.map((item) => {
      const isFolder = item.type === "folder";
      // Build key from the item — we need to resolve relative to our base
      let key = "";
      if (item.path_collection?.entries) {
        const parts = item.path_collection.entries.map((e: any) => e.name);
        parts.push(item.name);
        // Remove "All Files" and the base dir prefix
        const fullPath = parts.filter((n: string) => n !== "All Files").join("/");
        if (fullPath.startsWith(`${this.remoteBaseDir}/`)) {
          key = fullPath.slice(this.remoteBaseDir.length + 1);
        } else {
          key = item.name;
        }
      } else {
        key = item.name;
      }

      if (isFolder && !key.endsWith("/")) key = `${key}/`;

      const mtime = item.modified_at ? new Date(item.modified_at).getTime() : 0;
      const ctime = item.created_at ? new Date(item.created_at).getTime() : mtime;

      return {
        key, keyRaw: key,
        mtimeSvr: mtime, mtimeCli: mtime, ctimeCli: ctime,
        size: isFolder ? 0 : (item.size ?? 0),
        sizeRaw: isFolder ? 0 : (item.size ?? 0),
        etag: item.etag,
      };
    });
  }

  async walkPartial(): Promise<Entity[]> {
    return this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const isFolder = key.endsWith("/");
    if (isFolder) {
      const folderId = await this.pathResolver.resolve(
        `${this.remoteBaseDir}/${key.replace(/\/+$/, "")}`,
        (u) => this._getJson(u)
      );
      const res = await this._getJson(
        `${BOX_API}/folders/${folderId}?fields=id,name,type,size,modified_at,created_at`
      );
      return fromBoxItemToEntity(res, this.remoteBaseDir);
    }

    // For files, find by navigating to parent + searching
    const parentPath = key.includes("/")
      ? key.slice(0, key.lastIndexOf("/"))
      : "";
    const fileName = key.includes("/")
      ? key.slice(key.lastIndexOf("/") + 1)
      : key;

    const parentFolderId = await this.pathResolver.resolve(
      parentPath ? `${this.remoteBaseDir}/${parentPath}` : this.remoteBaseDir,
      (u) => this._getJson(u)
    );

    const res = await this._getJson(
      `${BOX_API}/folders/${parentFolderId}/items?fields=id,name,type,size,modified_at,created_at,etag`
    );
    const match = (res.entries || []).find(
      (e: any) => e.name === fileName && e.type === "file"
    );
    if (!match) throw Error(`[BYOC] Box: file '${key}' not found`);

    return {
      key, keyRaw: key,
      mtimeSvr: match.modified_at ? new Date(match.modified_at).getTime() : 0,
      mtimeCli: match.modified_at ? new Date(match.modified_at).getTime() : 0,
      size: match.size ?? 0,
      sizeRaw: match.size ?? 0,
      etag: match.etag,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    const fullPath = `${this.remoteBaseDir}/${key.replace(/\/+$/, "")}`;
    await this.pathResolver.resolve(
      fullPath,
      (u) => this._getJson(u),
      true,
      (u, b) => this._postJson(u, b)
    );
    return { key, keyRaw: key, size: 0, sizeRaw: 0 };
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const parentPath = key.includes("/")
      ? key.slice(0, key.lastIndexOf("/"))
      : "";
    const fileName = key.includes("/")
      ? key.slice(key.lastIndexOf("/") + 1)
      : key;

    const parentFolderId = await this.pathResolver.resolve(
      parentPath ? `${this.remoteBaseDir}/${parentPath}` : this.remoteBaseDir,
      (u) => this._getJson(u),
      true,
      (u, b) => this._postJson(u, b)
    );

    const token = await this.ensureToken();

    // Check if file already exists (for overwrite)
    let existingFileId: string | null = null;
    try {
      const res = await this._getJson(
        `${BOX_API}/folders/${parentFolderId}/items?fields=id,name,type&limit=1000`
      );
      const match = (res.entries || []).find(
        (e: any) => e.name === fileName && e.type === "file"
      );
      if (match) existingFileId = match.id;
    } catch {
      // ignore
    }

    if (existingFileId) {
      // Upload new version
      const formData = new FormData();
      formData.append("file", new Blob([content]), fileName);
      const resp = await retryFetch(
        `${BOX_UPLOAD_API}/files/${existingFileId}/content`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        }
      );
      if (!resp.ok) {
        throw Error(`[BYOC] Box: upload new version failed: ${resp.status}`);
      }
    } else {
      // Upload new file
      const formData = new FormData();
      formData.append(
        "attributes",
        JSON.stringify({ name: fileName, parent: { id: parentFolderId } })
      );
      formData.append("file", new Blob([content]), fileName);
      const resp = await retryFetch(`${BOX_UPLOAD_API}/files/content`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!resp.ok) {
        throw Error(`[BYOC] Box: upload new file failed: ${resp.status}`);
      }
    }

    return {
      key, keyRaw: key,
      mtimeCli: mtime, ctimeCli: ctime,
      size: content.byteLength,
      sizeRaw: content.byteLength,
    };
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    // Find file ID first
    const parentPath = key.includes("/")
      ? key.slice(0, key.lastIndexOf("/"))
      : "";
    const fileName = key.includes("/")
      ? key.slice(key.lastIndexOf("/") + 1)
      : key;

    const parentFolderId = await this.pathResolver.resolve(
      parentPath ? `${this.remoteBaseDir}/${parentPath}` : this.remoteBaseDir,
      (u) => this._getJson(u)
    );

    const res = await this._getJson(
      `${BOX_API}/folders/${parentFolderId}/items?fields=id,name,type&limit=1000`
    );
    const match = (res.entries || []).find(
      (e: any) => e.name === fileName && e.type === "file"
    );
    if (!match) throw Error(`[BYOC] Box: file '${key}' not found for read`);

    const token = await this.ensureToken();
    const resp = await retryFetch(`${BOX_API}/files/${match.id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
    });
    if (!resp.ok) {
      throw Error(`[BYOC] Box: readFile failed: ${resp.status}`);
    }
    return resp.arrayBuffer();
  }

  async rename(key1: string, key2: string): Promise<void> {
    // Box rename = update name on file/folder object
    const content = await this.readFile(key1);
    const now = Date.now();
    await this.writeFile(key2, content, now, now);
    await this.rm(key1);
  }

  async rm(key: string): Promise<void> {
    const isFolder = key.endsWith("/");
    const parentPath = key.includes("/")
      ? key.slice(0, key.lastIndexOf("/") || undefined).replace(/\/+$/, "")
      : "";
    const name = isFolder
      ? key.replace(/\/+$/, "").split("/").pop()!
      : key.split("/").pop()!;

    const parentFolderId = await this.pathResolver.resolve(
      parentPath ? `${this.remoteBaseDir}/${parentPath}` : this.remoteBaseDir,
      (u) => this._getJson(u)
    );

    const res = await this._getJson(
      `${BOX_API}/folders/${parentFolderId}/items?fields=id,name,type&limit=1000`
    );
    const itemType = isFolder ? "folder" : "file";
    const match = (res.entries || []).find(
      (e: any) => e.name === name && e.type === itemType
    );
    if (!match) return; // Already gone

    if (isFolder) {
      await this._delete(`${BOX_API}/folders/${match.id}?recursive=true`);
    } else {
      await this._delete(`${BOX_API}/files/${match.id}`);
    }
  }

  async checkConnect(callbackFunc?: (err: unknown) => unknown): Promise<boolean> {
    return this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    const res = await this._getJson(`${BOX_API}/users/me?fields=name`);
    return res.name || "Box User";
  }

  async revokeAuth(): Promise<void> {
    this.config.accessToken = "";
    this.config.refreshToken = "";
    await this.saveFunc();
  }

  supportsRename(): boolean { return true; }

  allowEmptyFile(): boolean {
    return true;
  }
}
