/**
 * BYOC — Google Drive Filesystem Adapter
 * Clean-room implementation using Google Drive API v3.
 *
 * Google does NOT support custom URI schemes (obsidian://) as redirect URIs.
 * This adapter uses a manual code-paste flow:
 *   1. User visits the auth URL in their browser
 *   2. Google redirects to localhost (or shows a code page)
 *   3. User copies the authorization code
 *   4. User pastes the code into BYOC settings
 *   5. BYOC exchanges the code for tokens
 *
 * The scope is drive.file — only files created by this app are accessible.
 */

import { request } from "obsidian";
import {
  GOOGLEDRIVE_CLIENT_ID,
  GOOGLEDRIVE_CLIENT_SECRET,
  type Entity,
  type GoogleDriveConfig,
} from "./baseTypes";
import { FakeFs } from "./fsAll";
import { retryFetch } from "./misc";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
// Bridge page catches Google's redirect and bounces the auth code into
// Obsidian's protocol handler (obsidian://bring-your-own-cloud-cb-googledrive).
const REDIRECT_URI = "https://bringyourowncloud.xyz/auth/googledrive/callback";

export const DEFAULT_GOOGLEDRIVE_CONFIG: GoogleDriveConfig = {
  accessToken: "",
  accessTokenExpiresInMs: 0,
  accessTokenExpiresAtTimeMs: 0,
  refreshToken: "",
  remoteBaseDir: "",
  credentialsShouldBeDeletedAtTimeMs: 0,
  scope: SCOPES as any,
  kind: "googledrive",
};

////////////////////////////////////////////////////////////////////////////////
// OAuth2 Helpers
////////////////////////////////////////////////////////////////////////////////

export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: GOOGLEDRIVE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function sendAuthReq(
  code: string,
  errorCallBack: (e: any) => Promise<void>
): Promise<any> {
  try {
    const rsp = await request({
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: GOOGLEDRIVE_CLIENT_ID,
        client_secret: GOOGLEDRIVE_CLIENT_SECRET,
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
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: GOOGLEDRIVE_CLIENT_ID,
      client_secret: GOOGLEDRIVE_CLIENT_SECRET,
    }).toString(),
  });
  return JSON.parse(rsp);
}

export async function setConfigBySuccessfullAuthInplace(
  config: GoogleDriveConfig,
  authRes: any,
  saveFunc: () => Promise<void>
): Promise<void> {
  config.accessToken = authRes.access_token;
  config.refreshToken = authRes.refresh_token || config.refreshToken;
  config.accessTokenExpiresInMs = (authRes.expires_in ?? 3600) * 1000;
  config.accessTokenExpiresAtTimeMs =
    Date.now() + (authRes.expires_in ?? 3600) * 1000 - 300_000;
  config.credentialsShouldBeDeletedAtTimeMs = 0;
  await saveFunc();
}

////////////////////////////////////////////////////////////////////////////////
// Google Drive Specifics
////////////////////////////////////////////////////////////////////////////////

/**
 * Google Drive allows multiple files with the same name in the same folder.
 * We must use file IDs for all operations and search by name + parent.
 */

interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  trashed?: boolean;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

////////////////////////////////////////////////////////////////////////////////
// The Client
////////////////////////////////////////////////////////////////////////////////

export class FakeFsGoogleDrive extends FakeFs {
  kind = "googledrive";
  private config: GoogleDriveConfig;
  private vaultName: string;
  private saveFunc: () => Promise<any>;
  private remoteBaseDir: string;
  private baseFolderId: string | null = null;
  // Cache folder name -> id mappings
  private folderCache: Map<string, string> = new Map();

  constructor(
    config: GoogleDriveConfig,
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
      throw Error("[BYOC] Google Drive: not authorized.");
    }

    if (
      this.config.refreshToken &&
      this.config.accessTokenExpiresAtTimeMs > 0 &&
      this.config.accessTokenExpiresAtTimeMs < Date.now()
    ) {
      const res = await refreshAccessToken(this.config.refreshToken);
      if (res.error) {
        throw Error(`[BYOC] Google Drive refresh error: ${res.error_description}`);
      }
      this.config.accessToken = res.access_token;
      if (res.refresh_token) this.config.refreshToken = res.refresh_token;
      this.config.accessTokenExpiresAtTimeMs =
        Date.now() + (res.expires_in ?? 3600) * 1000 - 300_000;
      await this.saveFunc();
    }

    return this.config.accessToken;
  }

  private async _getJson(url: string): Promise<any> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${DRIVE_API}${url}`;
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
    const fullUrl = url.startsWith("http") ? url : `${DRIVE_API}${url}`;
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

  private async _patchJson(url: string, body: any): Promise<any> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${DRIVE_API}${url}`;
    return JSON.parse(
      await request({
        url: fullUrl,
        method: "PATCH",
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  private async _delete(url: string): Promise<void> {
    const token = await this.ensureToken();
    const fullUrl = url.startsWith("http") ? url : `${DRIVE_API}${url}`;
    await retryFetch(fullUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  /**
   * Find or create a folder by name under a parent.
   */
  private async findOrCreateFolder(
    name: string,
    parentId: string
  ): Promise<string> {
    const cacheKey = `${parentId}/${name}`;
    if (this.folderCache.has(cacheKey)) {
      return this.folderCache.get(cacheKey)!;
    }

    // Search for existing
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
    const res = await this._getJson(
      `/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`
    );

    if (res.files && res.files.length > 0) {
      const id = res.files[0].id;
      this.folderCache.set(cacheKey, id);
      return id;
    }

    // Create
    const created = await this._postJson("/files", {
      name: name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    });
    this.folderCache.set(cacheKey, created.id);
    return created.id;
  }

  /**
   * Get or create the base vault folder in Drive root.
   */
  private async getBaseFolderId(): Promise<string> {
    if (this.baseFolderId) return this.baseFolderId;

    // Walk through the path segments
    const segments = this.remoteBaseDir.split("/").filter(Boolean);
    let parentId = "root";
    for (const seg of segments) {
      parentId = await this.findOrCreateFolder(seg, parentId);
    }

    this.baseFolderId = parentId;
    return parentId;
  }

  /**
   * Resolve a key like "subfolder/file.md" to a folder ID for its parent
   * and return both parent ID and filename.
   */
  private async resolveParent(
    key: string
  ): Promise<{ parentId: string; name: string }> {
    const baseFolderId = await this.getBaseFolderId();
    const parts = key.replace(/\/+$/, "").split("/").filter(Boolean);

    if (parts.length === 0) {
      return { parentId: baseFolderId, name: "" };
    }

    const name = parts.pop()!;
    let parentId = baseFolderId;

    for (const seg of parts) {
      parentId = await this.findOrCreateFolder(seg, parentId);
    }

    return { parentId, name };
  }

  /**
   * Find a file by name in a folder.
   */
  private async findFile(
    name: string,
    parentId: string,
    mimeType?: string
  ): Promise<GDriveFile | null> {
    let q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
    if (mimeType) q += ` and mimeType='${mimeType}'`;

    const res = await this._getJson(
      `/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime,createdTime,parents)&pageSize=1`
    );

    return res.files && res.files.length > 0 ? res.files[0] : null;
  }

  /**
   * Recursively list all files under a folder.
   */
  private async listRecursive(
    folderId: string,
    pathPrefix: string,
    entities: Entity[]
  ): Promise<void> {
    let pageToken = "";

    do {
      let url = `/files?q='${folderId}'+in+parents+and+trashed%3Dfalse&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime)&pageSize=1000`;
      if (pageToken) url += `&pageToken=${pageToken}`;

      const res = await this._getJson(url);
      const files: GDriveFile[] = res.files || [];

      for (const f of files) {
        const isFolder = f.mimeType === FOLDER_MIME;
        const key = isFolder
          ? `${pathPrefix}${f.name}/`
          : `${pathPrefix}${f.name}`;

        const mtime = f.modifiedTime
          ? new Date(f.modifiedTime).getTime()
          : 0;
        const ctime = f.createdTime
          ? new Date(f.createdTime).getTime()
          : mtime;
        const size = f.size ? parseInt(f.size, 10) : 0;

        entities.push({
          key, keyRaw: key,
          mtimeSvr: mtime, mtimeCli: mtime, ctimeCli: ctime,
          size: isFolder ? 0 : size,
          sizeRaw: isFolder ? 0 : size,
        } as Entity);

        if (isFolder) {
          await this.listRecursive(f.id, `${pathPrefix}${f.name}/`, entities);
        }
      }

      pageToken = res.nextPageToken || "";
    } while (pageToken);
  }

  async listFoldersAtRoot(): Promise<string[]> {
    const q = `'root' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
    const res = await this._getJson(
      `/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1000`
    );
    return (res.files || [])
      .map((f: GDriveFile) => f.name)
      .sort((a: string, b: string) => a.localeCompare(b));
  }

  async createFolderAtRoot(name: string): Promise<void> {
    await this._postJson("/files", {
      name,
      mimeType: FOLDER_MIME,
      parents: ["root"],
    });
  }

  async walk(): Promise<Entity[]> {
    const baseFolderId = await this.getBaseFolderId();
    const entities: Entity[] = [];
    await this.listRecursive(baseFolderId, "", entities);
    return entities;
  }

  async walkPartial(): Promise<Entity[]> {
    return this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const isFolder = key.endsWith("/");
    const { parentId, name } = await this.resolveParent(key);

    if (!name) {
      // Stat on root
      return { key, keyRaw: key, size: 0, sizeRaw: 0 } as Entity;
    }

    const file = await this.findFile(
      name,
      parentId,
      isFolder ? FOLDER_MIME : undefined
    );

    if (!file) {
      throw Error(`[BYOC] Google Drive: '${key}' not found`);
    }

    const mtime = file.modifiedTime
      ? new Date(file.modifiedTime).getTime()
      : 0;
    const ctime = file.createdTime
      ? new Date(file.createdTime).getTime()
      : mtime;
    const size = file.size ? parseInt(file.size, 10) : 0;

    return {
      key, keyRaw: key,
      mtimeSvr: mtime, mtimeCli: mtime, ctimeCli: ctime,
      size: isFolder ? 0 : size,
      sizeRaw: isFolder ? 0 : size,
    } as Entity;
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    const { parentId, name } = await this.resolveParent(key);
    if (name) {
      await this.findOrCreateFolder(name, parentId);
    }
    return { key, keyRaw: key, size: 0, sizeRaw: 0 } as Entity;
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const { parentId, name } = await this.resolveParent(key);
    const token = await this.ensureToken();

    // Check if file already exists
    const existing = await this.findFile(name, parentId);

    const metadata: any = {
      modifiedTime: new Date(mtime).toISOString(),
    };

    if (existing) {
      // Update existing file
      const resp = await retryFetch(
        `${DRIVE_UPLOAD_API}/files/${existing.id}?uploadType=multipart&fields=id,name,size,modifiedTime`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}` },
          body: createMultipartBody(metadata, content, name),
        }
      );
      if (!resp.ok) {
        throw Error(
          `[BYOC] Google Drive: update failed for '${key}': ${resp.status}`
        );
      }
    } else {
      // Create new file
      metadata.name = name;
      metadata.parents = [parentId];

      const resp = await retryFetch(
        `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,size,modifiedTime`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: createMultipartBody(metadata, content, name),
        }
      );
      if (!resp.ok) {
        throw Error(
          `[BYOC] Google Drive: create failed for '${key}': ${resp.status}`
        );
      }
    }

    return {
      key, keyRaw: key,
      mtimeCli: mtime, ctimeCli: ctime,
      size: content.byteLength,
      sizeRaw: content.byteLength,
    } as Entity;
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const { parentId, name } = await this.resolveParent(key);
    const file = await this.findFile(name, parentId);

    if (!file) {
      throw Error(`[BYOC] Google Drive: '${key}' not found for read`);
    }

    const token = await this.ensureToken();
    const resp = await retryFetch(
      `${DRIVE_API}/files/${file.id}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!resp.ok) {
      throw Error(
        `[BYOC] Google Drive: download failed for '${key}': ${resp.status}`
      );
    }

    return resp.arrayBuffer();
  }

  async rename(key1: string, key2: string): Promise<void> {
    // Google Drive rename = move + rename in one PATCH call
    const { parentId: parent1, name: name1 } = await this.resolveParent(key1);
    const { parentId: parent2, name: name2 } = await this.resolveParent(key2);

    const isFolder = key1.endsWith("/");
    const file = await this.findFile(
      name1,
      parent1,
      isFolder ? FOLDER_MIME : undefined
    );

    if (!file) {
      throw Error(`[BYOC] Google Drive: '${key1}' not found for rename`);
    }

    await this._patchJson(
      `/files/${file.id}?addParents=${parent2}&removeParents=${parent1}`,
      { name: name2 }
    );
  }

  async rm(key: string): Promise<void> {
    const isFolder = key.endsWith("/");
    const { parentId, name } = await this.resolveParent(key);

    const file = await this.findFile(
      name,
      parentId,
      isFolder ? FOLDER_MIME : undefined
    );

    if (!file) return; // Already gone

    // Permanently delete (not trash)
    await this._delete(`/files/${file.id}`);
  }

  async checkConnect(callbackFunc?: any): Promise<boolean> {
    return this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    try {
      const res = await this._getJson("/about?fields=user");
      return res.user?.displayName || res.user?.emailAddress || "Google Drive User";
    } catch {
      return "Google Drive (not configured)";
    }
  }

  async revokeAuth(): Promise<any> {
    // Optionally revoke the token at Google
    if (this.config.accessToken) {
      try {
        await fetch(
          `https://oauth2.googleapis.com/revoke?token=${this.config.accessToken}`,
          { method: "POST" }
        );
      } catch {
        // Best effort
      }
    }
    this.config.accessToken = "";
    this.config.refreshToken = "";
    await this.saveFunc();
  }

  supportsRename(): boolean { return true; }

  allowEmptyFile(): boolean {
    return true;
  }
}

////////////////////////////////////////////////////////////////////////////////
// Multipart Upload Helper
////////////////////////////////////////////////////////////////////////////////

/**
 * Create a multipart/related body for Google Drive API uploads.
 * This combines JSON metadata and file content in one request.
 */
function createMultipartBody(
  metadata: any,
  content: ArrayBuffer,
  filename: string
): Blob {
  const boundary = "byoc_boundary_" + Date.now();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataStr =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: application/octet-stream\r\n\r\n';

  const metadataBlob = new Blob([metadataStr]);
  const contentBlob = new Blob([content]);
  const closeBlob = new Blob([closeDelimiter]);

  return new Blob([metadataBlob, contentBlob, closeBlob], {
    type: `multipart/related; boundary=${boundary}`,
  });
}
