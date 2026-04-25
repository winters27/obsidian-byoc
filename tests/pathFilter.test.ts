import { strict as assert } from "assert";
import { shouldSyncPath } from "../src/sync/pathFilter";

describe("shouldSyncPath", () => {
  it("allows everything when both lists are empty", () => {
    assert.equal(shouldSyncPath("notes/foo.md", [], []), true);
  });

  it("blocks a file matching ignorePaths", () => {
    assert.equal(shouldSyncPath("big.pdf", ["*.pdf"], []), false);
  });

  it("allows a file not matching ignorePaths", () => {
    assert.equal(shouldSyncPath("notes/foo.md", ["*.pdf"], []), true);
  });

  it("allows a file matching onlyAllowPaths", () => {
    assert.equal(shouldSyncPath("notes/foo.md", [], ["notes/**"]), true);
  });

  it("blocks a file not matching onlyAllowPaths", () => {
    assert.equal(shouldSyncPath("images/bar.png", [], ["notes/**"]), false);
  });

  it("ignorePaths takes precedence over onlyAllowPaths", () => {
    assert.equal(shouldSyncPath("notes/secret.md", ["**/secret.*"], ["notes/**"]), false);
  });

  it("supports dot-files in globs", () => {
    assert.equal(shouldSyncPath(".obsidian/snippets/custom.css", [], [".obsidian/snippets/**"]), true);
  });

  it("blocks dot-files when ignored", () => {
    assert.equal(shouldSyncPath(".obsidian/plugins/foo/data.json", [".obsidian/plugins/*/data.json"], []), false);
  });
});
