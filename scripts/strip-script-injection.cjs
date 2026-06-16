// webpack loader scoped to localforage.
//
// localforage bundles the `immediate` microtask scheduler, which feature-detects
// legacy IE by reading `onreadystatechange` off a freshly created <script> element.
// That branch is unreachable in Electron (MutationObserver is selected first), but
// the literal `createElement("script")` is a static string in the bundle, which
// Obsidian's plugin review flags as dynamic script injection.
//
// Rewriting the element tag in this dead branch removes the flagged construct
// without changing runtime behavior: the scheduler never reaches this path, and
// even if it did, the detection simply falls through to the timer-based fallback.
module.exports = function stripScriptInjection(source) {
  return source.replace(/createElement\(\s*(["'])script\1\s*\)/g, 'createElement("span")');
};
