// Test-only globals so modules that transitively import the encryption web
// worker (fsEncrypt -> encryptRClone -> encryptRClone.worker) can load under
// Node. The worker module references `self` / `addEventListener` at import
// time, before any mocha before() hook runs, so this must be a --require.
// Source is unchanged; production runs these in a real Worker context.
if (typeof globalThis.self === "undefined") {
  globalThis.self = globalThis;
}
if (typeof globalThis.addEventListener !== "function") {
  globalThis.addEventListener = () => {};
}
if (typeof globalThis.postMessage !== "function") {
  globalThis.postMessage = () => {};
}
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = require("crypto").webcrypto;
}
