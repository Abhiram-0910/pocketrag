# AGENTS.md — Session Handoff Log

This file is updated at the END of every Claude Code session.
Claude reads this at the START of every new session to understand what happened before.

---

## Project State
**Last updated:** 2026-07-25
**Current branch:** master (git initialized Session 3; first commit `e8b1344` covers
Milestone 1+2, second commit covers Milestone 3 — see below)
**Overall status:** Milestone 3 (storage + retrieval) done — drag/drop a PDF, extract
per-page text, chunk + embed in a Web Worker, persist chunks/embeddings to IndexedDB,
type a real question, get real cosine-ranked top-3 chunks with page numbers and scores.
No LLM-generated answer yet (Milestone 4) and no restore-on-reload UI (deliberate).

---

## Session Log

### Session 1 — 2026-07-24
**Goal:** Scaffold the project and prove the client-side ingestion path works: PDF in →
extracted text → token-aware overlapping chunks → chunk count + first chunks rendered in UI.

**Completed:**
- [x] Filled CLAUDE.md, TODO.md, ARCHITECTURE.md (were unfilled templates)
- [x] Scaffolded Vite + React 19 + TypeScript project, added Tailwind v4 (`@tailwindcss/vite`
      plugin, CSS-first config via `src/index.css`), Zustand, `pdfjs-dist`, Vitest
- [x] `src/lib/chunker.ts` — token-aware (word/punctuation regex approximation) overlapping
      chunker, pure function, 12 Vitest unit tests written first (boundaries, overlap
      correctness, coverage, validation) — all passing
- [x] `src/lib/pdf.ts` — pdf.js text extraction (`extractPdfText`), worker wired via Vite's
      `?url` import
- [x] `src/store/documentStore.ts` — Zustand store for fileName/chunks/status/error
- [x] `src/components/DropZone.tsx` + `src/components/ChunkPreview.tsx` — drag-and-drop +
      browse file input, renders chunk count and first 3 chunks
- [x] Verified end-to-end in a real headless-Chromium browser (Playwright, installed
      temporarily then removed): generated a real 4-page PDF, uploaded it through the file
      input, confirmed 14 chunks rendered with correct overlapping text and zero console
      errors. Screenshot inspected visually.
- [x] `npm run test`, `tsc -b --noEmit`, `oxlint`, `npm run build` all pass clean

**Decisions made:**
- Chunking uses a word/punctuation regex token approximation, not the real HF tokenizer —
  avoids a network-dependent unit test suite and a heavy dependency before the embedding
  Worker exists. Marked with a `ponytail:` comment in `chunker.ts` naming the upgrade path
  (swap to `@xenova/transformers` tokenizer in Milestone 2).
- Playwright was installed only to drive a real browser for manual verification of this
  session's UI work, then uninstalled — CLAUDE.md's testing section still lists it as a
  stretch goal, not yet a real project dependency.

**Problems encountered:**
- None blocking. `npm create vite` refuses to scaffold into a non-empty directory (the repo
  already had the four `.md` files) — worked around by scaffolding into `/tmp` and copying
  the generated files in.

**Left incomplete:**
- Nothing from this sprint's scope. Everything in TODO.md's "Current Sprint" is done.

**Next session should start with:**
- Milestone 2: Web Worker + transformers.js embedding pipeline (Xenova/all-MiniLM-L6-v2,
  WebGPU with WASM fallback), per TODO.md's "Up Next" section.

---

### Session 2 — 2026-07-24
**Goal:** Embedding Web Worker — real tokenizer, WebGPU/WASM backend with distinguished
failure states, model download progress, in-memory embeddings, visible proof (vector
dimension + similarity score) in the browser.

**Completed:**
- [x] Confirmed no Playwright leftover from Session 1 (`package.json`/lockfile checked —
      the only lockfile hit was Vitest's own optional-peer-dep metadata, never installed)
- [x] Verified the real `@huggingface/transformers` API empirically (Node probe script,
      deleted after use) before writing any Worker code: per-atom token-count summing
      equals whole-string tokenization exactly; `pipeline('feature-extraction', ...)` with
      `pooling:'mean', normalize:true` gives clean 384-dim vectors; `progress_callback`'s
      `progress_total` event gives one aggregate 0–100% across all model files
- [x] `src/lib/chunker.ts` rewritten: takes an injected `Tokenizer` interface instead of
      the Milestone-1 regex approximation — real per-atom subword token counts, exact
      original text still preserved via char offsets. Resolves the Milestone-1 `ponytail:`
      debt. 14 tests rewritten against the real tokenizer (network fetch once, cached)
- [x] `src/workers/backend.ts` — `resolveBackend()`, pure and Worker-independent, extracted
      specifically so the three backend states are unit-testable without a browser
- [x] `src/workers/backend.test.ts` — 5 tests, one per branch (no gpu / adapter null /
      adapter throws / webgpu succeeds / webgpu throws-then-wasm-succeeds), asserting both
      the reported `BackendState` and which device `createExtractor` was actually called with
- [x] `src/workers/embedding.worker.ts` — loads real tokenizer, chunks, resolves backend,
      loads model (progress streamed), embeds chunks one at a time (real per-chunk progress,
      not simulated)
- [x] `src/lib/similarity.ts` + `src/lib/embeddingClient.ts` (typed Worker message client,
      singleton so the model only loads once per session)
- [x] `src/store/documentStore.ts` extended (backend, backendDetail, modelProgress,
      embedProgress) and `src/components/EmbeddingProof.tsx` added: backend badge, model
      download %, embedding progress, vector dimension, similarity(chunk 0, chunk 1)
      overlapping vs similarity(chunk 0, last chunk) distant
- [x] Verified end-to-end in real headless Chromium (Playwright, installed then removed
      again): generated a topic-diverse test PDF (biology + cooking paragraphs, repeated to
      get 7 chunks) — natural run gave real 0.889 similarity for overlapping chunks vs 0.061
      for the cross-topic pair, 384-dim vectors, zero console errors. Screenshot inspected.
- [x] 22/22 tests, `tsc -b --noEmit`, `oxlint`, `npm run build` all pass clean
- [x] Playwright uninstalled again after verification; confirmed no leftover in
      `package.json`/lockfile

**Backend state observed this session:** `WASM (WebGPU unavailable)` — every real browser
run (this sandbox's headless Chromium has no GPU adapter; `requestAdapter()` returned
`null`). The `webgpu` and `wasm-failed` states were **not** exercised against a real
browser — only via `backend.test.ts`'s mocked-GPU unit tests. Re-verify against real
WebGPU hardware before trusting those two states in production.

**Decisions made:**
- Swapped `@xenova/transformers` (installed first, per the stack notes) for
  `@huggingface/transformers` after `npm audit` showed the former pulls a **critical**
  protobufjs RCE via its bundled `onnxruntime-web`. The successor package is the same
  author/API/model-IDs, actively maintained, no critical vuln. Two remaining high-severity
  advisories (`onnxruntime-node`, `sharp` — both Node-only optional backends this browser
  app never touches) have no fix available upstream; documented in ARCHITECTURE.md rather
  than blocking on them.
- Chunking moved from the main thread into the Worker: the real tokenizer is model logic,
  and CLAUDE.md requires all model logic to run in a Worker, never the main thread.
- Chunker takes an injected `Tokenizer` interface rather than importing the HF library
  directly — keeps it pure/testable and lets Node-based unit tests use the real tokenizer
  without needing a browser (tokenization doesn't touch WebGPU/WASM, only inference does).
- Embedding is done one chunk at a time (not batched) specifically to get real, granular
  `embed-progress` events instead of one opaque batched call.

**Problems encountered:**
- First test PDF was too repetitive (same sentence template x40) to demonstrate similarity
  meaningfully distinguishing related vs. unrelated chunks (0.966 vs 0.970 — no real
  contrast). Rebuilt the test fixture with two genuinely distinct topics (biology/cooking)
  to get a convincing 0.889 vs 0.061 contrast. Not a code bug — a test-fixture problem.
- Attempted to force the `wasm-unavailable` and `wasm-failed` states via Playwright's
  `page.addInitScript` patching `navigator.gpu`. Discovered this doesn't work: a dedicated
  Worker has its own isolated `navigator`, unreachable from a main-thread init script — so
  the "forced" scenarios silently produced identical results to the natural (unpatched) run.
  Resolved by extracting `resolveBackend()` into a pure, Worker-independent function and
  unit-testing the branching logic directly with a mocked GPU instead — see
  `src/workers/backend.test.ts`.
- `npm run dev` re-optimized dependencies mid-session (`@huggingface/transformers` wasn't
  pre-bundled), causing one page reload that raced with an in-flight Playwright file-upload
  test and made it look like nothing happened. Not a real bug — re-ran after the
  re-optimization settled and it worked.

**Left incomplete:**
- Nothing from this session's scope. Everything in the milestone spec is done, with the
  one caveat above (WebGPU/wasm-failed states unverified on real hardware).

**Next session should start with:**
- Milestone 3: IndexedDB storage layer (Document/Chunk/embedding schema via `idb`) so
  documents and embeddings survive a reload, then cosine-similarity retrieval over stored
  vectors. Per TODO.md's "Up Next" section.

---

### Session 3 — 2026-07-25
**Goal:** Git init + first commit (housekeeping), then Milestone 3: per-page text
extraction, IndexedDB persistence, and a query UI doing real cosine-ranked retrieval
against stored embeddings.

**Completed:**
- [x] `git init`, confirmed `.gitignore` already covered `node_modules`/`dist` from the
      Milestone 1 scaffold, first commit `e8b1344` (Milestone 1+2, 32 files)
- [x] `src/lib/pdf.ts` — `extractPdfText()` now returns `PageText[]` (one entry per PDF
      page) instead of one joined string
- [x] `src/workers/embedding.types.ts` / `embedding.worker.ts` — chunking moved to
      per-page (each page chunked independently via the existing `chunkText()`, then
      globally reindexed and tagged with `page`), so a chunk can never span a page
      boundary and page attribution needed no offset-to-page lookup. Added `embed-query`
      request / `query-embedding` response for embedding a single string with no chunking
- [x] Verified `idb` + `fake-indexeddb` API empirically (probe script, deleted after use)
      before writing `db.ts` — confirmed `getAllFromIndex`, transaction `put`/`done`,
      index-scoped queries all behave as expected
- [x] `src/lib/db.ts` — `documents` + `chunks` IndexedDB object stores via `idb`,
      `documentId` index on chunks, `saveDocument()` / `getChunksForDocument()`. 4 tests
      using `fake-indexeddb/auto` in Node (save+retrieve, cross-document scoping,
      embedding/page fidelity, empty-result case)
- [x] `src/lib/retrieval.ts` — `rankChunks()`, pure cosine-ranking generic over any
      `{embedding}` shape. 5 tests (known-similar vs. known-different ranking, exact
      identical/opposite-vector scores, topK default and override, empty input, object
      identity preserved)
- [x] `src/components/DropZone.tsx` — after the Worker's `result` message, generates a
      `documentId` (`crypto.randomUUID()`), maps `EmbeddedChunk[]` to `ChunkRecord[]`,
      calls `saveDocument()` before marking the document ready
- [x] `src/components/QueryPanel.tsx` (new) + `embedQuery()` in `embeddingClient.ts` —
      text input, disabled until a document is ready, embeds the query through the same
      Worker/model, pulls that document's chunks back out of IndexedDB, ranks, shows
      top 3 with page number and real score
- [x] `ChunkPreview.tsx` now shows each chunk's page number too
- [x] Verified end-to-end in real headless Chromium (Playwright, installed then removed
      again): dropped the topic-diverse test PDF, asked "How does a cell produce
      energy?" — top result was the mitochondrion/ATP chunk, page 1, score 0.578. Asked
      "What technique gives bread its chewy texture?" — top result was the exact
      kneading/gluten sentence, page 2, score 0.490. Zero console errors, both screenshots
      inspected visually.
- [x] 31/31 tests, `tsc -b --noEmit`, `oxlint`, `npm run build` all pass clean
- [x] Playwright uninstalled again after verification; confirmed no leftover in
      `package.json`/lockfile

**Decisions made:**
- **No restore-on-reload UI this milestone** — asked the user directly rather than
  guessing (grill-me question from the milestone spec). Re-dropping the file is
  required after a page reload; IndexedDB still persists everything correctly
  underneath, but there's no "recent documents" view yet. Reasoning: auto-restore
  requires deciding multi-document UX (which document loads? a picker?) that Milestone
  3 didn't otherwise need to decide. Schema (`documentId` foreign key) already supports
  it without migration.
- **Chunking moved to per-page** rather than chunking the whole concatenated document
  and computing which page(s) a char range falls into. Simpler, unambiguous, and a
  legitimate real-world RAG strategy — not a shortcut taken under time pressure.
- **Retrieval reads chunks back from IndexedDB**, not from the in-memory Zustand array
  that's already sitting there right after upload. Slightly more work this milestone,
  but proves the actual persistence round-trip and is what a future reload-restore
  UI would need anyway.
- **IndexedDB reads/writes happen on the main thread**, not in the embedding Worker —
  persistence isn't "model logic" under CLAUDE.md's Worker-isolation rule, and `idb`
  doesn't need any Worker-side capability.

**Problems encountered:**
- None blocking. `npm run dev`'s dependency re-optimization (new deps: `idb`) caused
  the same one-time reload-mid-request behavior seen in Session 2 — a plain `curl`
  warm-up before driving with Playwright wasn't enough to trigger it (the crawler only
  discovers `idb` once the browser actually requests the module chain that imports it),
  so the first driven run timed out waiting for a selector that never rendered. Re-ran
  after the reload settled and it worked normally. Documenting this pattern now: after
  adding a new dependency, expect one wasted `npm run dev` warm-up cycle before
  Playwright-driving it for real.

**Left incomplete:**
- Nothing from this session's scope.

**Next session should start with:**
- Milestone 4: Cloudflare Worker (TS) answer-composition endpoint calling Gemini 2.5
  Flash-Lite — send the top-K retrieved chunks + question, get back a real generated
  answer with citations, wire it into the UI in place of (or alongside) the raw
  ranked-chunks display. Per TODO.md's "Up Next" section.

---

<!-- Copy the block above for each new session -->
