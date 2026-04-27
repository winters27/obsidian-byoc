/**
 * BYOC — Azure Blob Storage Filesystem Adapter
 * Clean-room implementation using Azure Blob REST API with SAS tokens.
 * No OAuth needed — users provide a Container SAS URL directly.
 */

import { requestUrl } from "obsidian";
import type { AzureBlobStorageConfig, Entity } from "./baseTypes";
import { DEFAULT_CONTENT_TYPE } from "./baseTypes";
import { FakeFs } from "./fsAll";

export const DEFAULT_AZUREBLOBSTORAGE_CONFIG: AzureBlobStorageConfig = {
  containerSasUrl: "",
  containerName: "",
  remotePrefix: "",
  generateFolderObject: false,
  partsConcurrency: 5,
  kind: "azureblobstorage",
};

/**
 * Parse the container SAS URL into base URL + SAS token components.
 */
function parseSasUrl(containerSasUrl: string): {
  baseUrl: string;
  sasToken: string;
} {
  const questionIdx = containerSasUrl.indexOf("?");
  if (questionIdx === -1) {
    return { baseUrl: containerSasUrl, sasToken: "" };
  }
  return {
    baseUrl: containerSasUrl.slice(0, questionIdx),
    sasToken: containerSasUrl.slice(questionIdx), // includes the '?'
  };
}

/**
 * Build the full URL for a blob, including the SAS token.
 */
function getBlobUrl(
  baseUrl: string,
  sasToken: string,
  prefix: string,
  blobName: string
): string {
  let fullPath = blobName;
  if (prefix) {
    fullPath = `${prefix}/${blobName}`;
  }
  // Encode path segments but preserve '/'
  const encoded = fullPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${baseUrl}/${encoded}${sasToken}`;
}

/**
 * Normalize a key from Azure listing to our Entity key format.
 * Strips the prefix and ensures folders end with '/'.
 */
function normalizeKey(blobName: string, prefix: string): string {
  let key = blobName;
  if (prefix && key.startsWith(`${prefix}/`)) {
    key = key.slice(prefix.length + 1);
  }
  return key;
}

export class FakeFsAzureBlobStorage extends FakeFs {
  kind = "azureblobstorage";
  private config: AzureBlobStorageConfig;
  private vaultName: string;
  private baseUrl: string;
  private sasToken: string;

  constructor(
    config: AzureBlobStorageConfig,
    vaultName: string
  ) {
    super();
    this.config = config;
    this.vaultName = vaultName;
    const parsed = parseSasUrl(config.containerSasUrl);
    this.baseUrl = parsed.baseUrl;
    this.sasToken = parsed.sasToken;
  }

  private getPrefix(): string {
    return this.config.remotePrefix || this.vaultName;
  }

  private blobUrl(blobName: string): string {
    return getBlobUrl(this.baseUrl, this.sasToken, this.getPrefix(), blobName);
  }

  /**
   * List Blobs — Azure Blob REST API
   * https://learn.microsoft.com/en-us/rest/api/storageservices/list-blobs
   */
  async walk(): Promise<Entity[]> {
    const entities: Entity[] = [];
    let marker = "";
    const prefix = this.getPrefix();

    do {
      let listUrl = `${this.baseUrl}${this.sasToken}&restype=container&comp=list&prefix=${encodeURIComponent(prefix ? `${prefix}/` : "")}`;
      if (marker) {
        listUrl += `&marker=${encodeURIComponent(marker)}`;
      }

      const resp = await requestUrl({ url: listUrl, throw: false });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `[BYOC] Azure Blob list failed: ${resp.status}`
        );
      }

      const text = resp.text;
      const parser = new DOMParser();
      const xml = parser.parseFromString(text, "text/xml");

      // Parse blobs
      const blobs = xml.querySelectorAll("Blob");
      for (const blob of blobs) {
        const name = blob.querySelector("Name")?.textContent ?? "";
        const key = normalizeKey(name, prefix);
        if (!key) continue;

        const propsEl = blob.querySelector("Properties");
        const contentLength = propsEl?.querySelector("Content-Length")?.textContent;
        const lastModified = propsEl?.querySelector("Last-Modified")?.textContent;
        const etag = propsEl?.querySelector("Etag")?.textContent;

        const size = contentLength ? parseInt(contentLength, 10) : 0;
        const mtime = lastModified ? new Date(lastModified).getTime() : 0;

        // Detect "folder" markers (zero-byte blobs ending with '/')
        const isFolder = key.endsWith("/");

        entities.push({
          keyRaw: key,
          key: key,
          mtimeSvr: mtime,
          size: isFolder ? 0 : size,
          sizeRaw: isFolder ? 0 : size,
          etag: etag ?? undefined,
        });
      }

      // Check for continuation
      const nextMarker = xml.querySelector("NextMarker")?.textContent ?? "";
      marker = nextMarker;
    } while (marker);

    return entities;
  }

  async walkPartial(): Promise<Entity[]> {
    // Azure Blob doesn't have a delta mechanism; full listing each time
    return this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const url = this.blobUrl(key);
    const resp = await requestUrl({ url, method: "HEAD", throw: false });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `[BYOC] Azure Blob stat failed for '${key}': ${resp.status}`
      );
    }

    const headers = resp.headers;
    const size = parseInt(headers["content-length"] ?? "0", 10);
    const lastModified = headers["last-modified"];
    const mtime = lastModified ? new Date(lastModified).getTime() : 0;
    const etag = headers["etag"] ?? undefined;

    return {
      keyRaw: key,
      key: key,
      mtimeSvr: mtime,
      size: size,
      sizeRaw: size,
      etag: etag,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!this.config.generateFolderObject) {
      // Azure Blob doesn't need explicit folder objects; just skip
      return {
        keyRaw: key,
        key: key,
        size: 0,
        sizeRaw: 0,
      };
    }

    const folderKey = key.endsWith("/") ? key : `${key}/`;
    const url = this.blobUrl(folderKey);

    const headers: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
      "Content-Length": "0",
      "Content-Type": DEFAULT_CONTENT_TYPE,
    };

    const resp = await requestUrl({
      url,
      method: "PUT",
      headers,
      body: "",
      throw: false,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `[BYOC] Azure Blob mkdir failed for '${folderKey}': ${resp.status}`
      );
    }

    return {
      keyRaw: folderKey,
      key: folderKey,
      size: 0,
      sizeRaw: 0,
    };
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const url = this.blobUrl(key);

    const headers: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": DEFAULT_CONTENT_TYPE,
      "Content-Length": `${content.byteLength}`,
    };

    const resp = await requestUrl({
      url,
      method: "PUT",
      headers,
      body: content,
      throw: false,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `[BYOC] Azure Blob writeFile failed for '${key}': ${resp.status} ${resp.text}`
      );
    }

    return {
      keyRaw: key,
      key: key,
      mtimeCli: mtime,
      size: content.byteLength,
      sizeRaw: content.byteLength,
    };
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const url = this.blobUrl(key);
    const resp = await requestUrl({ url, throw: false });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `[BYOC] Azure Blob readFile failed for '${key}': ${resp.status}`
      );
    }

    return resp.arrayBuffer;
  }

  async rename(key1: string, key2: string): Promise<void> {
    // Azure Blob doesn't have a native rename; copy + delete
    const content = await this.readFile(key1);
    const now = Date.now();
    await this.writeFile(key2, content, now, now);
    await this.rm(key1);
  }

  supportsRename(): boolean { return false; }

  async rm(key: string): Promise<void> {
    const url = this.blobUrl(key);
    const resp = await requestUrl({ url, method: "DELETE", throw: false });

    if ((resp.status < 200 || resp.status >= 300) && resp.status !== 404) {
      throw new Error(
        `[BYOC] Azure Blob rm failed for '${key}': ${resp.status}`
      );
    }
  }

  async checkConnect(callbackFunc?: (err: unknown) => unknown): Promise<boolean> {
    return this.checkConnectCommonOps(callbackFunc);
  }

  getUserDisplayName(): Promise<string> {
    if (!this.config.containerSasUrl) {
      return Promise.resolve("Azure Blob Storage (not configured)");
    }
    return Promise.resolve(
      `Azure Blob: ${this.config.containerName || "container"}`
    );
  }

  revokeAuth(): Promise<void> {
    // SAS tokens don't have a revoke flow — user regenerates on Azure portal
    this.config.containerSasUrl = "";
    this.config.containerName = "";
    return Promise.resolve();
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
