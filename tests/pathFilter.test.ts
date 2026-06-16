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

  // The setting is labeled "regex" (remotely-save #1124, #1080), so regular
  // expression patterns must match, alongside globs.
  it("allows a dot-folder via a regex allow pattern", () => {
    assert.equal(shouldSyncPath(".makemd/config.json", [], ["\\.makemd/.*"]), true);
    assert.equal(shouldSyncPath(".space/notes.md", [], ["(^|/)\\.(makemd|space)/"]), true);
  });

  it("blocks a non-matching path when a regex allow pattern is set", () => {
    assert.equal(shouldSyncPath("notes/foo.md", [], ["\\.makemd/.*"]), false);
  });

  it("ignores paths via a regex ignore pattern", () => {
    assert.equal(shouldSyncPath("daily/2026-01-01.md", ["\\d{4}-\\d{2}-\\d{2}\\.md$"], []), false);
    assert.equal(shouldSyncPath("notes/foo.md", ["\\d{4}-\\d{2}-\\d{2}\\.md$"], []), true);
  });

  it("still supports glob patterns (backward compatible)", () => {
    assert.equal(shouldSyncPath("images/bar.png", ["**/*.png"], []), false);
    assert.equal(shouldSyncPath("notes/foo.md", [], ["notes/**"]), true);
  });

  it("does not throw on a glob-only pattern that is not valid regex", () => {
    assert.equal(shouldSyncPath("a/b/foo", [], ["**/foo"]), true);
  });
});
