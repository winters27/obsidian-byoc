// Stubs the `obsidian` module for unit tests run under Node (no Obsidian app).
// Tests that exercise pure helpers from files which top-level-import `obsidian`
// (e.g. fsWebdis.ts → requestUrl) need this so mocha can load them at all.
// Source code is unchanged; production builds still mark `obsidian` as
// external and Obsidian's runtime supplies the real module.

const Module = require("module");

const stub = {
  requestUrl: () => {
    throw new Error("obsidian.requestUrl is stubbed in tests");
  },
  Modal: class {},
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Platform: { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false },
  TFile: class {},
  TFolder: class {},
  normalizePath: (p) => p,
  requireApiVersion: () => true,
  moment: require("moment"),
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") {
    return require.resolve("./_obsidianStub.cjs");
  }
  return origResolve.call(this, request, ...args);
};

// Source files that satisfy Obsidian's `prefer-active-doc` ESLint rule
// reference `activeWindow` / `activeDocument` / bare `DOMParser` instead of
// `window.X`. Existing tests populate `global.window` per-case (via crypto
// stub or JSDOM); mirror those onto the names the new source uses so test
// fixtures don't need per-file changes.
const mirror = (name, pick) =>
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      const w = globalThis.window;
      return w ? pick(w) : undefined;
    },
  });

mirror("activeWindow", (w) => w);
mirror("activeDocument", (w) => w.document);
mirror("DOMParser", (w) => w.DOMParser);

module.exports = stub;
