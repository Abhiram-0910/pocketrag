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
| Storage | IndexedDB (via `idb`) | Persistent client-side storage for documents/chunks/vectors |
| Answer composition | Cloudflare Worker (TS) + Gemini 2.5 Flash-Lite | Only network hop; sees retrieved snippets + question, never the source file — not yet built (Milestone 4) |

---

## Folder Structure
```
pocketrag/
├── src/
│   ├── components/         # DropZone, ChunkPreview, EmbeddingProof, QueryPanel
│   ├── lib/                 # Pure logic: pdf.ts, chunker.ts, similarity.ts, retrieval.ts,
│   │                         # db.ts, embeddingClient.ts
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
| `src/lib/pdf.ts` | pdf.js text extraction (main thread) — returns per-page text (`PageText[]`), not one joined string |
| `src/lib/chunker.ts` | Token-aware overlapping chunking — pure function, takes an injected `Tokenizer` (real subword counts, exact original text preserved via char offsets). Called once per page by the Worker, so a chunk never spans a page boundary |
| `src/lib/similarity.ts` | Cosine similarity for already-normalized vectors |
| `src/lib/retrieval.ts` | `rankChunks()` — pure cosine-ranking over an array of `{embedding}` objects, generic over the chunk shape |
| `src/lib/db.ts` | IndexedDB via `idb`: `documents` + `chunks` object stores, `documentId` index on chunks, `saveDocument()` / `getChunksForDocument()` |
| `src/lib/embeddingClient.ts` | Main-thread singleton wrapper around the embedding Worker (typed postMessage protocol): `embedDocument()` and `embedQuery()` |
| `src/workers/embedding.worker.ts` | Loads tokenizer + model, chunks each page, embeds, and separately embeds single query strings — all model logic lives here, never on the main thread |
| `src/workers/backend.ts` | `resolveBackend()` — pure, worker-independent WebGPU/WASM detection and fallback logic, unit-tested without a browser |
| `src/store/documentStore.ts` | Zustand store: documentId, fileName, chunks (with embeddings), status, backend state, progress |

---

## Data Flow

**Ingestion:** Drag PDF → pdf.js extracts text per page (main thread) → pages posted
to the embedding Worker → Worker: load real tokenizer → chunk each page independently
(real per-atom token counts, page-scoped so a chunk never spans pages) → detect
WebGPU/WASM backend → load model (progress streamed) → embed each chunk (progress
streamed) → chunks + embeddings posted back → main thread renders proof (backend
badge, vector dimension, sample similarity) → main thread generates a `documentId`
and persists Document + Chunk records (with embeddings) to IndexedDB.

**Retrieval:** User types a question → query text posted to the same Worker
(`embed-query`) → single embedding returned → main thread pulls that document's
stored chunks back out of IndexedDB (`getChunksForDocument`) → `rankChunks()` cosine-
ranks them → top 3 rendered with page number and real score.

**Not yet built (Milestone 4):** no LLM-generated answer — the query UI shows raw
ranked chunks, not a composed response. Cloudflare Worker + Gemini call is next.

Note: chunking happens **inside the embedding Worker**, not on the main thread as
Milestone 1's diagram had it — the real tokenizer is model logic (CLAUDE.md: "All
embedding/model logic runs inside a Web Worker"), so chunking moved with it once
Milestone 2 swapped in the real tokenizer. IndexedDB reads/writes happen on the
**main thread** — persistence isn't model logic, and `idb` needs no Worker isolation.

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
- **Chunking moved to per-page, not whole-document:** `chunkText()` is called once
  per PDF page instead of once for the concatenated document. A chunk therefore
  never spans a page boundary, so page attribution is structurally unambiguous —
  no offset-range-to-page lookup needed. Trade-off: no chunk overlap carries across
  a page break (acceptable; a common real-world RAG chunking strategy, not a hack).
- **`rankChunks()` is generic over `{ embedding: number[] }`**, not tied to
  `ChunkRecord` — same function ranks IndexedDB-backed chunks now and could rank
  any other embedded-item shape later without change.
- **Retrieval reads from IndexedDB, not the in-memory Zustand chunks**, even though
  the just-embedded chunks are already in memory after upload. This proves the
  persistence round-trip actually works (write → read back → rank) and is what
  survives once a restore-on-reload UI exists later — the in-memory array wouldn't.
- **No restore-on-reload:** confirmed with the user rather than guessed. Dropping a
  file again after a reload is required for now; the `documentId` foreign key already
  supports multi-document / restore UI later without a schema migration.

---

## Environment Variables Required
```bash
# Cloudflare Worker (worker/.env or wrangler secrets) — not needed until Milestone 4
GEMINI_API_KEY=
```

---

## Known Technical Debt
- [ ] `embedding.worker.ts` bundles onnxruntime-web's WASM runtime (~23MB) eagerly —
      fine for local dev, worth code-splitting / lazy-loading before any real deploy.
- [ ] `resolveBackend()`'s `webgpu` and `wasm-failed` states are unit-tested with a
      mocked GPU but have not been exercised against real WebGPU hardware (this dev
      sandbox has no GPU) — re-verify when real hardware is available.
- [ ] No restore-on-reload UI (deliberate, confirmed with user) — see Key Architectural
      Decisions above. Schema supports it; UI doesn't exist yet.
