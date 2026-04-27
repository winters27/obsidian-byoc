import type { Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";

const notImplemented = () =>
  Promise.reject(new Error("Method not implemented."));

export class FakeFsMock extends FakeFs {
  kind: "mock";

  constructor() {
    super();
    this.kind = "mock";
  }

  walk(): Promise<Entity[]> {
    return notImplemented();
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  stat(key: string): Promise<Entity> {
    return notImplemented();
  }

  mkdir(key: string, mtime: number, ctime: number): Promise<Entity> {
    return notImplemented();
  }

  writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    return notImplemented();
  }

  readFile(key: string): Promise<ArrayBuffer> {
    return notImplemented();
  }

  rename(key1: string, key2: string): Promise<void> {
    return notImplemented();
  }

  rm(key: string): Promise<void> {
    return notImplemented();
  }

  async checkConnect(callbackFunc?: (err: unknown) => unknown): Promise<boolean> {
    return await this.checkConnectCommonOps(callbackFunc);
  }

  getUserDisplayName(): Promise<string> {
    return notImplemented();
  }

  revokeAuth(): Promise<void> {
    return notImplemented();
  }

  supportsRename(): boolean { return true; }

  allowEmptyFile(): boolean {
    throw new Error("Method not implemented.");
  }
}
