import { describe, it, assert } from "vitest";
import { shouldSyncPath } from "../src/sync/pathFilter";

describe("shouldSyncPath", () => {
  it("allows everything when both lists are empty", () => {
    assert.isTrue(shouldSyncPath("notes/foo.md", [], []));
  });

  it("blocks a file matching ignorePaths", () => {
    assert.isFalse(shouldSyncPath("big.pdf", ["*.pdf"], []));
  });

  it("allows a file not matching ignorePaths", () => {
    assert.isTrue(shouldSyncPath("notes/foo.md", ["*.pdf"], []));
  });

  it("allows a file matching onlyAllowPaths", () => {
    assert.isTrue(shouldSyncPath("notes/foo.md", [], ["notes/**"]));
  });

  it("blocks a file not matching onlyAllowPaths", () => {
    assert.isFalse(shouldSyncPath("images/bar.png", [], ["notes/**"]));
  });

  it("ignorePaths takes precedence over onlyAllowPaths", () => {
    assert.isFalse(shouldSyncPath("notes/secret.md", ["**/secret.*"], ["notes/**"]));
  });

  it("supports dot-files in globs", () => {
    assert.isTrue(shouldSyncPath(".obsidian/snippets/custom.css", [], [".obsidian/snippets/**"]));
  });

  it("blocks dot-files when ignored", () => {
    assert.isFalse(shouldSyncPath(".obsidian/plugins/foo/data.json", [".obsidian/plugins/*/data.json"], []));
  });
});
