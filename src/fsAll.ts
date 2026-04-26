import isEqual from "lodash/isEqual";
import { nanoid } from "nanoid";
import type { Entity } from "./baseTypes";

export abstract class FakeFs {
  abstract kind: string;
  abstract walk(): Promise<Entity[]>;
  abstract walkPartial(): Promise<Entity[]>;
  abstract stat(key: string): Promise<Entity>;
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;
  abstract writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity>;
  abstract readFile(key: string): Promise<ArrayBuffer>;
  abstract rename(key1: string, key2: string): Promise<void>;
  /** Returns true if this provider supports atomic rename without copy+delete. */
  abstract supportsRename(): boolean;
  abstract rm(key: string): Promise<void>;
  abstract checkConnect(callbackFunc?: any): Promise<boolean>;
  async checkConnectCommonOps(callbackFunc?: any) {
    try {
      console.debug(`check connect: create folder`);
      const folderName = `rs-test-folder-${nanoid()}/`;
      await this.mkdir(folderName);
      // await delay(3000);

      console.debug(`check connect: upload file`);
      const filename = `${folderName}rs-test-file-${nanoid()}`;
      const ctime = Date.now();
      const mtime1 = Date.now();
      const content1 = new ArrayBuffer(100);
      await this.writeFile(filename, content1, mtime1, ctime);
      // await delay(3000);

      console.debug(`check connect: overwrite file`);
      const mtime2 = Date.now();
      const content2 = new ArrayBuffer(200);
      await this.writeFile(filename, content2, mtime2, ctime);
      // await delay(3000);

      console.debug(`check connect: download file`);
      const content3 = await this.readFile(filename);
      if (!isEqual(content2, content3)) {
        throw Error(`downloaded file is not equal with uploaded file!`);
      }
      // await delay(3000);

      console.debug(`check connect: delete file`);
      await this.rm(filename);
      // await delay(3000);

      console.debug(`check connect: delete folder`);
      await this.rm(folderName);
      // await delay(3000);

      return true;
    } catch (err) {
      console.error(err);
      callbackFunc?.(err);
      return false;
    }
  }
  abstract getUserDisplayName(): Promise<string>;
  abstract revokeAuth(): Promise<any>;
  abstract allowEmptyFile(): boolean;

  /**
   * List folder names at the cloud root (ignoring this.remoteBaseDir).
   * Used by the post-OAuth folder picker so users can choose where their
   * vault lives in their cloud, instead of silently defaulting to the
   * vault name and triggering a destructive first-sync plan.
   *
   * Default: throws. Override in providers that support OAuth folder picking.
   */
  async listFoldersAtRoot(): Promise<string[]> {
    throw new Error(`[BYOC] listFoldersAtRoot not implemented for ${this.kind}`);
  }

  /**
   * Create a folder at the cloud root (ignoring this.remoteBaseDir).
   * Used by the folder picker's "Create new folder" option.
   *
   * Default: throws. Override in providers that support OAuth folder picking.
   */
  async createFolderAtRoot(name: string): Promise<void> {
    throw new Error(`[BYOC] createFolderAtRoot not implemented for ${this.kind}`);
  }
}
