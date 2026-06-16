import picomatch from "picomatch";

// Match each pattern as both a glob and a regex, so users can write either.
// Patterns that aren't valid regex fall back to glob only.
function makeMatcher(patterns: string[]): (keyRaw: string) => boolean {
  const globMatch = picomatch(patterns, { dot: true });
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern));
    } catch {
      // not a valid regex; the glob pass covers this pattern
    }
  }
  return (keyRaw: string) =>
    globMatch(keyRaw) || regexes.some((re) => re.test(keyRaw));
}

export function shouldSyncPath(
  keyRaw: string,
  ignorePaths: string[],
  onlyAllowPaths: string[]
): boolean {
  // If onlyAllowPaths is non-empty, the file must match at least one pattern
  if (onlyAllowPaths.length > 0) {
    if (!makeMatcher(onlyAllowPaths)(keyRaw)) return false;
  }

  // If ignorePaths is non-empty, the file must NOT match any pattern
  if (ignorePaths.length > 0) {
    if (makeMatcher(ignorePaths)(keyRaw)) return false;
  }

  return true;
}
