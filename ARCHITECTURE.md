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
| Answer composition | Cloudflare Worker (TS) + Gemini 3.5 Flash-Lite | Only network hop; sees retrieved snippets + question, never the source file. Model pinned to 3.5 — `gemini-2.5-flash-lite` (originally specified) 404s as "no longer available to new users" for this project's API key |

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
├── worker/                  # Cloudflare Worker — separate npm project, separate deploy
│   └── src/                 # index.ts, validate.ts, prompt.ts, grounding.ts,
│                             # rateLimit.ts, cors.ts, gemini.ts
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
| `src/components/QueryPanel.tsx` | Query input → embed → rank from IndexedDB → POST to the Worker → composed answer as primary result, raw ranked chunks as collapsible "Sources," visible failure note (not silent fallback) if the Worker call fails |
| `worker/src/index.ts` | `POST /answer` handler: CORS → rate limit → validate → build prompt → call Gemini → groundedness check → JSON response |
| `worker/src/validate.ts` | Caps chunk count (5) and per-chunk text length (2000 chars) server-side — never trusts the client |
| `worker/src/prompt.ts` | Grounded-QA prompt: answer only from passages, cite pages, admit gaps |
| `worker/src/grounding.ts` | `checkGrounding()` — citation-level groundedness heuristic (see Key Architectural Decisions) |
| `worker/src/rateLimit.ts` | KV counter-per-IP-per-day, 50/day default |
| `worker/src/gemini.ts` | Thin, injectable-`fetch` wrapper around Gemini's `generateContent` endpoint |

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

**Answer composition:** ranked top-3 chunks (text, page, score) POSTed to the
Cloudflare Worker's `/answer` endpoint → Worker rate-limits by `CF-Connecting-IP` (KV,
50/day) → validates and caps the input → builds a grounded-QA prompt → calls Gemini
3.5 Flash-Lite → runs a citation-level groundedness check on the response → returns
`{ answer, groundingWarning }` → frontend shows the answer as the primary result, with
a caveat banner if `groundingWarning` is true, and the raw ranked chunks underneath as
a collapsible "Sources" section. If the Worker call fails for any reason, the frontend
falls back to just the raw ranked chunks with a **visible** failure note — never a
silent swap.

**Not yet built:** frontend deploy (Cloudflare Pages), so `PAGES_ORIGIN` CORS config
and `.env.production`'s `VITE_ANSWER_API_URL` are both still placeholders.

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
- **Gemini model pinned to `gemini-3.5-flash-lite`, not the floating
  `gemini-flash-lite-latest` alias:** the spec named `gemini-2.5-flash-lite`, which
  404s ("no longer available to new users") for this project's API key. Confirmed via
  the live models list and direct test calls before swapping — not guessed. Pinning to
  an explicit version means the model only changes when someone deliberately updates
  `MODEL_ID` in `worker/src/gemini.ts`, not silently when Google repoints "latest."
- **`worker/` is a fully separate npm project** (own `package.json`, `tsconfig.json`,
  `node_modules`), not part of the frontend's Vite/Vitest setup — it has a different
  runtime (Workers, not a browser), different ambient types
  (`@cloudflare/workers-types`, generated `Env` via `wrangler types`), and a genuinely
  separate deploy target.
- **Worker tests use plain Vitest with mocked KV and mocked `fetch`, not
  `@cloudflare/vitest-pool-workers`:** the user explicitly wanted the test suite
  runnable without a live Gemini call or a full Workers runtime. All Worker logic
  (`validate.ts`, `prompt.ts`, `grounding.ts`, `rateLimit.ts`, `gemini.ts`) is written
  as pure functions taking injected dependencies (a `KVLike` interface, an injectable
  `fetchImpl`) specifically to make this possible.
- **Citation-level groundedness check (`checkGrounding`), not semantic verification:**
  from the Milestone 4 grill-me discussion — flags an answer if it cites a page number
  that wasn't in the input passages, or cites nothing at all without an explicit
  "not in the passages" disclaimer. Does not catch a real page being cited with
  content that isn't actually there — that needs a second verification LLM call or
  human review, deliberately not built (would double Gemini usage against the free
  quota this rate limiter exists to protect). Documented as a known limitation, not
  silently absent.
- **Chunk count/text length capped server-side, not just validated:** the Worker
  truncates to 5 chunks / 2000 chars each rather than rejecting an oversized request —
  the honest client only ever sends 3 short chunks, so this is purely an abuse/bug
  guard, not a user-facing validation error.
- **Rate limiter is a KV counter with `expirationTtl`, not exact:** `ponytail:`-marked
  in `rateLimit.ts` — KV `get` then `put` isn't atomic, so concurrent requests from the
  same IP in the same instant could both read the same count. Acceptable for abuse
  protection (soft cap), not for exact billing-grade accounting. Upgrade path: a
  Durable Object, if exact accounting is ever needed.
- **Embedding request latency observed at 30s–280s in this sandbox** (a real Gemini
  API call, not the model itself being slow to load — the model loads once and is
  cached). The frontend's "Searching…" button state doesn't set this expectation
  explicitly; flagged in TODO.md as a real UX gap, not fixed this session.

---

## Environment Variables Required
```bash
# Frontend (repo root)
# .env.development (committed): VITE_ANSWER_API_URL=http://localhost:8787/answer
# .env.production (not yet created): VITE_ANSWER_API_URL=<deployed Worker URL>/answer

# worker/.dev.vars (gitignored, local dev only — see worker/.dev.vars.example)
GEMINI_API_KEY=

# Deployed Worker secret (never in a file):
#   cd worker && wrangler secret put GEMINI_API_KEY
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
- [ ] `checkGrounding()` only catches citation-level inconsistency, not content-level
      hallucination against a correctly-cited page — see Key Architectural Decisions.
- [ ] Deployed Worker has no public URL yet — the Cloudflare account has never
      registered a `workers.dev` subdomain. Code is deployed and correct (verified via
      `wrangler dev` + real browser); publishing needs one interactive confirmation
      only the user can give (`cd worker && wrangler deploy`, say yes to the subdomain
      prompt). See AGENTS.md Session 4.
- [ ] `PAGES_ORIGIN` in `worker/wrangler.jsonc` is still an empty placeholder — set it
      once the frontend is deployed to Cloudflare Pages.
