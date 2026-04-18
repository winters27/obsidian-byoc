import picomatch from "picomatch";

export function shouldSyncPath(
  keyRaw: string,
  ignorePaths: string[],
  onlyAllowPaths: string[]
): boolean {
  // If onlyAllowPaths is non-empty, the file must match at least one pattern
  if (onlyAllowPaths.length > 0) {
    const allowMatcher = picomatch(onlyAllowPaths, { dot: true });
    if (!allowMatcher(keyRaw)) return false;
  }

  // If ignorePaths is non-empty, the file must NOT match any pattern
  if (ignorePaths.length > 0) {
    const ignoreMatcher = picomatch(ignorePaths, { dot: true });
    if (ignoreMatcher(keyRaw)) return false;
  }

  return true;
}
