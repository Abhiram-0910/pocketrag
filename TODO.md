# TODO.md — PocketRAG

Claude updates this at the end of every session.
Read this at the start of every session to know what to work on next.

---

## 🔴 Current Sprint
Milestone 2 complete — see 🟡 Up Next for Milestone 3.

---

## 🟡 Up Next
- [ ] IndexedDB storage layer (Document/Chunk/embedding schema, via `idb`) — hold
      embeddings across reloads instead of only in-memory
- [ ] Cosine similarity retrieval over stored embeddings

---

## 🟢 Backlog
- [ ] Cloudflare Worker answer-composition endpoint + Gemini call
- [ ] Rate limiting (Cloudflare KV)
- [ ] Citations UI, landing page, styling pass
- [ ] Code-split `embedding.worker.ts` / onnxruntime-web WASM (currently a 23MB
      asset bundled eagerly) — only matters once this ships past local dev

---

## ✅ Completed
- [x] Scaffold Vite + React + TypeScript + Tailwind project — Session 1, 2026-07-24
- [x] Drag-and-drop file input, accepts PDF — Session 1, 2026-07-24
- [x] pdf.js extracts raw text from dropped PDF — Session 1, 2026-07-24
- [x] Token-aware overlapping chunking — Session 1, 2026-07-24
- [x] Render chunk count + first few chunks in UI (proof of pipeline) — Session 1, 2026-07-24
- [x] Embedding Web Worker: transformers.js, Xenova/all-MiniLM-L6-v2 (q8), WebGPU
      primary / WASM fallback with distinguished failure states — Session 2, 2026-07-24
- [x] Model download progress surfaced in UI (real percent, not simulated) — Session 2, 2026-07-24
- [x] Chunker swapped to real per-atom subword token counts from the model's own
      tokenizer (Milestone-1 `ponytail:` debt resolved) — Session 2, 2026-07-24
- [x] In-memory embeddings for current document + vector-dimension/similarity proof
      in UI — Session 2, 2026-07-24

---

## 🐛 Known Bugs
(none yet)

---

## 💡 Ideas / Notes
- `resolveBackend()` (src/workers/backend.ts) is the one piece of Milestone 2 logic
  that couldn't be verified against real hardware in this sandbox (no GPU) — the
  `webgpu` and `wasm-failed` states are covered by exhaustive unit tests with a
  mocked GPU/pipeline instead of a live browser run. Re-verify against real WebGPU
  hardware when available.
