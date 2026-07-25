# ARCHITECTURE.md — PocketRAG

Claude reads this file at the start of every session to orient itself in the codebase.
Keep this updated as the project evolves.

---

## Stack
| Layer | Technology | Why chosen |
|-------|-----------|------------|
| Frontend | React + Vite + TypeScript | Fast dev loop, no server needed for a browser-only app |
| Styling | Tailwind CSS | Utility-first, no CSS-in-JS runtime cost |
| State | Zustand | Minimal cross-component state without Redux boilerplate |
| PDF parsing | pdf.js | Runs entirely client-side via WASM, no server upload |
| Embeddings | `@huggingface/transformers` (Xenova/all-MiniLM-L6-v2, q8) | Runs in-browser via WebGPU/WASM in a Worker, keeps documents local. Not `@xenova/transformers` — that package is deprecated and pulled in a critical protobufjs RCE via its bundled onnxruntime-web; `@huggingface/transformers` is the maintained successor, same API, same model IDs |
| Storage | IndexedDB (via `idb`) | Persistent client-side storage for documents/chunks/vectors — not yet wired up (Milestone 3) |
| Answer composition | Cloudflare Worker (TS) + Gemini 2.5 Flash-Lite | Only network hop; sees retrieved snippets + question, never the source file |

---

## Folder Structure
```
pocketrag/
├── src/
│   ├── components/         # DropZone, ChunkPreview, EmbeddingProof
│   ├── lib/                 # Pure logic: pdf.ts, chunker.ts, similarity.ts, embeddingClient.ts
│   ├── store/               # documentStore.ts (Zustand)
│   └── workers/             # embedding.worker.ts, backend.ts, embedding.types.ts
├── worker/                  # Cloudflare Worker (answer composition, separate deploy) — not started
├── CLAUDE.md
├── AGENTS.md
├── ARCHITECTURE.md
└── TODO.md
```

---

## Key Files
| File | Purpose |
|------|---------|
| `src/lib/pdf.ts` | pdf.js text extraction (main thread) |
| `src/lib/chunker.ts` | Token-aware overlapping chunking — pure function, takes an injected `Tokenizer` (real subword counts, exact original text preserved via char offsets) |
| `src/lib/similarity.ts` | Cosine similarity for already-normalized vectors |
| `src/lib/embeddingClient.ts` | Main-thread singleton wrapper around the embedding Worker (typed postMessage protocol) |
| `src/workers/embedding.worker.ts` | Loads tokenizer + model, chunks, embeds — all model logic lives here, never on the main thread |
| `src/workers/backend.ts` | `resolveBackend()` — pure, worker-independent WebGPU/WASM detection and fallback logic, unit-tested without a browser |
| `src/store/documentStore.ts` | Zustand store: fileName, chunks (with embeddings), status, backend state, progress |

---

## Data Flow
Drag PDF → pdf.js extracts text (main thread) → raw text posted to the embedding
Worker → Worker: load real tokenizer → chunk (real per-atom token counts) → detect
WebGPU/WASM backend → load model (progress streamed) → embed each chunk (progress
streamed) → chunks + embeddings posted back → main thread renders proof (backend
badge, vector dimension, sample similarity) → IndexedDB → cosine search on query →
Cloudflare Worker → Gemini Flash-Lite → answer + citation

**Milestone 2 (current):** flow stops after in-memory embeddings — no IndexedDB, no
retrieval, no Cloudflare Worker/Gemini call yet.

Note: chunking now happens **inside the Worker**, not on the main thread as
Milestone 1's diagram had it — the real tokenizer is model logic (CLAUDE.md: "All
embedding/model logic runs inside a Web Worker"), so chunking moved with it once
Milestone 2 swapped in the real tokenizer.

---

## Key Architectural Decisions
- **Browser-only ingestion:** PDF parsing and embedding happen entirely client-side
  so the source document never leaves the browser — only the network call at answer
  time sends retrieved snippets + question to the Cloudflare Worker.
- **Chunker takes an injected `Tokenizer` interface** (`{ countTokens(text): number }`)
  rather than importing `@huggingface/transformers` directly. Keeps `chunker.ts`
  pure and testable (unit tests use the real tokenizer directly in Node — no browser
  needed since tokenization, unlike inference, doesn't touch WebGPU/WASM), and lets
  the Worker supply the real model tokenizer at runtime.
- **Per-atom real token counts, not whole-string tokenization:** BERT's WordPiece
  tokenizer operates on already word/punctuation-split atoms, so summing per-atom
  token counts (from the same regex boundaries as Milestone 1) equals whole-string
  tokenization exactly (verified empirically) — this lets chunks keep byte-exact
  original text (case, punctuation, spacing) while `tokenCount` reflects real
  subword counts, instead of losing text fidelity to tokenizer `decode()`.
- **`resolveBackend()` extracted into its own pure function** (`src/workers/backend.ts`),
  independent of `self`/Worker globals, specifically so the three backend states —
  `webgpu`, `wasm-unavailable` (no adapter), `wasm-failed` (adapter acquired, pipeline
  init threw) — can be unit-tested deterministically with a mocked GPU. A real
  dedicated Worker has its own isolated `navigator`, which Playwright's
  `page.addInitScript` cannot reach from the main thread — browser-level mocking of
  WebGPU state doesn't work for Worker code, so this is the only reliable way to
  test the fallback branches without real WebGPU hardware.
- **Model download progress uses the `progress_total` event** from transformers.js's
  `progress_callback`, not the per-file `progress` events — gives one aggregate 0–100
  bar across all model files instead of jumping between files.
- **Embedding loop is per-chunk, not batched:** trades a little throughput for real,
  granular `embed-progress` events (`done`/`total`) instead of one opaque batch call.

---

## Environment Variables Required
```bash
# Cloudflare Worker (worker/.env or wrangler secrets) — not needed until Milestone 3+
GEMINI_API_KEY=
```

---

## Known Technical Debt
- [ ] `embedding.worker.ts` bundles onnxruntime-web's WASM runtime (~23MB) eagerly —
      fine for local dev, worth code-splitting / lazy-loading before any real deploy.
- [ ] `resolveBackend()`'s `webgpu` and `wasm-failed` states are unit-tested with a
      mocked GPU but have not been exercised against real WebGPU hardware (this dev
      sandbox has no GPU) — re-verify when real hardware is available.
