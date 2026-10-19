// The ONNX Runtime build the embedding worker runs, and where it comes from. transformers.js
// sets onnxruntime-web's wasmPaths to jsDelivr at this exact version and fetches the .wasm
// and .mjs from there at runtime (asyncify pair on Chromium/Firefox/WebGPU, plain pair on
// Safari); the .mjs is then imported from a blob: URL.
//
// What is protected: public/_headers' connect-src only allows ORT_CDN_BASE (this version's
// dist/ path) on cdn.jsdelivr.net, and script-src doesn't allow jsDelivr at all, so once the
// CSP is enforced no other host, package or version can be loaded.
// What isn't: the bytes served at that path. They are not integrity-checked at runtime —
// SRI was tried and dropped because it couldn't fail closed: onnxruntime-web re-fetches a
// rejected .wasm through XMLHttpRequest, and re-imports a rejected .mjs with import(), and
// neither can carry an integrity hash. Whatever jsDelivr serves there runs in the embedding
// worker, with this origin's privileges.
//
// ORT_FILE_SHA384 records the expected bytes (sha384 of the installed
// node_modules/onnxruntime-web/dist files, which matched jsDelivr when added) so a CDN
// response can be checked by hand. ortPin.test.ts fails if this table, ORT_VERSION, the
// installed onnxruntime-web, or public/_headers' connect-src path drift apart.
export const ORT_VERSION = '1.26.0-dev.20260416-b7804b056c'
export const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`

export const ORT_FILE_SHA384: Record<string, string> = {
  'ort-wasm-simd-threaded.asyncify.wasm': 'sha384-ppxy8GpR5oK0pciZqI/PSDs0fl2gPFvA509fIkdyEwIAvXabDahpzW9fPyZq/fLs',
  'ort-wasm-simd-threaded.asyncify.mjs': 'sha384-3PtbyJKPDRoZCNL6u5IQ3uw3aYqeALuxedvWoGF8Syni60K8769ZoBCVSyxZVllq',
  'ort-wasm-simd-threaded.wasm': 'sha384-ac1etqJINZEQKCzyc73jLkiBdavxbNEJ9zaX0uKADcjBIU3+Uj5sx7bW2kasMiZA',
  'ort-wasm-simd-threaded.mjs': 'sha384-CclkOX/Bse5EM7hBknuVBkrt9XxuaHzaSDsqYGa8L7gW9g9aVQJmmeuWugYUKPGs',
}
