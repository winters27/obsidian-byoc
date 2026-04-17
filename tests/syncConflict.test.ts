import { strict as assert } from "assert";
import { generateConflictFileName } from "../src/sync/conflict";

describe("Sync Conflict Resolver", () => {
  it("should generate a sync conflict filename preserving extensions", () => {
    const original = "my notes/ideas.md";
    const conflictName = generateConflictFileName(original);
    
    // e.g., 'ideas (sync conflict).md' or similar prefix/suffix
    assert.ok(conflictName.startsWith("my notes/ideas"));
    assert.ok(conflictName.endsWith(".md"));
    assert.ok(conflictName.includes("sync-conflict-"));
  });

  it("should handle files without extensions correctly", () => {
    const original = "my notes/ideas";
    const conflictName = generateConflictFileName(original);
    assert.ok(conflictName.startsWith("my notes/ideas"));
    assert.ok(conflictName.includes("sync-conflict-"));
  });
});
