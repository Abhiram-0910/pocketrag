# ARCHITECTURE.md — PocketRAG

Claude reads this file at the start of every session to orient itself in the codebase.
Keep this updated as the project evolves.

---

## Stack
| Layer | Technology | Why chosen |
|-------|-----------|------------|
| Frontend | React + Vite + TypeScript | Fast dev loop, no server needed for a browser-only app |
| Styling | Tailwind CSS v4, no config file (CSS-first `@theme`) | Utility-first, no CSS-in-JS runtime cost |
| Design system | Minimalist Swiss, light+dark (`prefers-color-scheme` only, no manual toggle) | Session 14 — matches a privacy-focused local-first tool's "professional tool" positioning; see AGENTS.md Session 14 for the full rationale and `src/components/ui/` for the shared `Button`/`StatusBanner` primitives |
| Icons | `@phosphor-icons/react` | Session 14's one new dependency — the app previously had zero icons beyond a Unicode `✕` |
| Font | Inter, self-hosted (`public/fonts/`) | Not Google Fonts CDN — avoids a third-party request on every load, consistent with this app's local-first posture |
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
│   ├── components/         # DropZone, DocumentList, QueryPanel
│   ├── lib/                 # Pure logic: pdf.ts, chunker.ts, similarity.ts, retrieval.ts,
│   │                         # db.ts, embeddingClient.ts
│   ├── store/               # documentStore.ts (Zustand)
│   └── workers/             # embedding.worker.ts, backend.ts, embedding.types.ts
├── worker/                  # Cloudflare Worker — separate npm project, separate deploy
│   └── src/                 # index.ts, validate.ts, prompt.ts, labels.ts, grounding.ts,
│                             # rateLimit.ts, cors.ts, gemini.ts
├── scripts/                 # check-bundle-size.mjs (build-time Pages size guard)
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
| `src/lib/db.ts` | IndexedDB via `idb`: `documents` + `chunks` object stores, `documentId` index on chunks. `saveDocument()`, `getChunksForDocument()` (this-document scope), `getAllChunks()` (all-documents scope), `getAllDocuments()` (restore-on-reload), `deleteDocument()` (atomic readwrite over both stores, via the `documentId` index). Requests `navigator.storage.persist()` once on first save |
| `src/lib/queryScope.ts` | `canRunQuery()` — pure readiness check extracted from `QueryPanel` so scope/selection logic is unit-testable without a DOM |
| `src/lib/embeddingClient.ts` | Main-thread singleton wrapper around the embedding Worker (typed postMessage protocol): `embedDocument()` and `embedQuery()` |
| `src/workers/embedding.worker.ts` | Loads tokenizer + model, chunks each page, embeds, and separately embeds single query strings — all model logic lives here, never on the main thread |
| `src/workers/backend.ts` | `resolveBackend()` — pure, worker-independent WebGPU/WASM detection and fallback logic, unit-tested without a browser |
| `src/store/documentStore.ts` | Zustand store: `documents: DocEntry[]` (per-document id/fileName/status/progress/chunkCount), `selectedId`, plus session-global backend + model-progress. Actions: add/update/remove/restore/select |
| `src/components/DropZone.tsx` | Drag-and-drop + browse; queues a whole batch up front, then embeds one document at a time. `processFile` resolves (never rejects) on ready or error so one bad file can't block the rest. Auto-selects the first ready doc |
| `src/components/DocumentList.tsx` | The multi-document library: one row per doc with live status, click-to-select (ready docs only), ✕ to dismiss an error row, inline two-step "Delete permanently?" confirm on ready rows (destructive — calls `deleteDocument()` then `removeDocument()`; failure keeps the row with a brief inline error) |
| `src/components/QueryPanel.tsx` | Scope toggle (this doc / all docs) → embed query → rank the scoped chunk pool from IndexedDB → POST to the Worker → composed answer as primary result, `Doc N = fileName` legend, raw ranked chunks as collapsible "Sources," visible failure note (not silent fallback) if the Worker call fails |
| `worker/src/index.ts` | `POST /answer` handler: CORS → rate limit → validate → build prompt → call Gemini → groundedness check → JSON response |
| `worker/src/validate.ts` | Caps chunk count (5) and per-chunk text length (2000 chars) server-side — never trusts the client |
| `worker/src/prompt.ts` | Grounded-QA prompt: answer only from passages, cite `(Doc N, page M)`, admit gaps |
| `worker/src/labels.ts` | `assignDocLabels()` — per-request `Doc N` ↔ documentId map (see Key Architectural Decisions) |
| `worker/src/grounding.ts` | `checkGrounding()` — citation-level groundedness heuristic over `(Doc N, page)` pairs |
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
- **Two-tab privacy model (planned, Milestone 9 — Handwritten/Scanned Notes):** the
  app will have two structurally separate tabs, not a single upload flow with a
  format-detection branch. The "Documents" tab is the existing PDF pipeline and stays
  100% local — nothing about its code path changes. The "Handwritten/Scanned Notes"
  tab is a distinct feature that explicitly uploads the file to a cloud OCR service,
  gated behind a per-file consent prompt ("this file will be uploaded for cloud OCR")
  before anything is sent. Keeping them as separate tabs/code paths — rather than one
  tab that sometimes uploads and sometimes doesn't depending on file type — is what
  keeps "Documents stays 100% local" a claim that's true by construction, not just by
  current behavior that a future change could quietly violate.
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
  persistence round-trip actually works (write → read back → rank) and is what the
  restore-on-reload path (below) depends on — the in-memory array wouldn't survive.
- **Restore-on-reload (Milestone 6):** on load, `App` reads `getAllDocuments()` and
  merges them into the store as `ready` (persisted docs are fully embedded). Nothing is
  auto-selected — multi-document is the model now, so landing on the list is correct.
  `restoreDocuments` merges by id (appends only ids not already present) so it's
  idempotent under StrictMode's double-invoke and can't clobber a doc dropped in the
  same instant. Deliberately deferred back in Milestone 3 (asked the user rather than
  guessing multi-doc UX); the `documentId` foreign key meant no schema migration.
- **Retrieval scope toggle ("this document" vs "all documents"):** "this document"
  ranks `getChunksForDocument(selectedId)`; "all documents" ranks `getAllChunks()`
  (every stored chunk). `rankChunks` is scope-agnostic — it just ranks whatever pool it
  is handed, so scoping is enforced purely by *which* chunks are fetched, and a
  document-scoped query can never surface another document's chunk. Cosine scores are
  **directly comparable across documents** because every embedding is unit-normalized by
  the same model, so a single global ranking over the pooled chunks is meaningful (no
  per-document score normalization needed).
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
- **Multi-document citations via per-request `Doc N` labels (Worker-owned):** with
  retrieval able to span multiple documents, a page number alone is ambiguous, so
  passages are labelled `[Doc N, Page M]` and the model cites `(Doc N, page M)`. The
  **Worker** is the single source of truth for the label mapping — `assignDocLabels()`
  (`worker/src/labels.ts`) assigns `Doc N` per distinct `documentId` in first-appearance
  order over that query's ranked chunks, and the Worker both builds the prompt and grounds
  against that same mapping. It returns the `label → documentId` map to the client, which
  joins `documentId → fileName` (known only in the browser) to render a legend under the
  answer (`Doc 1 = report.pdf · Doc 2 = notes.pdf`) and the Sources list. Filenames never
  leave the browser; only opaque `documentId` UUIDs are sent. **These labels are generated
  fresh per answer and are NOT stable across queries** — the same document can be `Doc 1`
  for one question and `Doc 2` for another, depending on which chunks rank where. Nothing
  should assume a persistent document-number.
- **Citation-level groundedness check (`checkGrounding`), not semantic verification:**
  from the Milestone 4 grill-me discussion — flags an answer if it cites a `(Doc N, page M)`
  pair that wasn't in the input passages (which now also catches citing a valid document but
  the wrong page, or a document that wasn't provided), or cites nothing at all without an
  explicit "not in the passages" disclaimer. A bare "page M" with no `Doc N` isn't treated
  as a citation for the unknown-citation check, but still counts as "some citation exists"
  so a well-cited answer isn't falsely flagged. Does not catch a real `(doc, page)` being
  cited with content that isn't actually there — that needs a second verification LLM call
  or human review, deliberately not built (would double Gemini usage against the free quota
  this rate limiter exists to protect). Documented as a known limitation, not silently absent.
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
  cached). A follow-up investigation (Session 5) could not reproduce this under
  controlled testing (cold start, warm repeats, minimal and full-size prompts — all
  consistently under 1.5s); root cause remains unconfirmed.
- **`attemptAnswer()` (`src/lib/answerRequest.ts`) wraps one answer attempt in an
  `AbortController`-based ~60s timeout, returning a discriminated `{outcome}` instead
  of throwing** — mirrors `resolveBackend()`'s pattern (pure function, injectable
  dependency, no React/DOM coupling) so the timeout logic is unit-testable with a
  mocked hanging `fetch` and `vi.useFakeTimers()`, without rendering the component.
  On a first timeout, `QueryPanel` shows a "Try again" button that reuses the
  already-ranked chunks in memory — retry never re-embeds the query or re-reads
  IndexedDB. A second timeout on retry falls back to the same visible hard-failure
  note as any other failure, not another retry loop (deliberately: one friendly
  retry, then treat it like any other failure).
- **Frontend deployed via direct `wrangler pages deploy`, not Git integration:**
  the app is a pure static SPA (one page, no client-side router, no Pages Functions —
  the API is entirely the separate `pocketrag-answer` Worker), so there's no server
  logic on the Pages side needing a build pipeline beyond `npm run build`. Direct
  upload matches how the Worker was already deployed — one tool, one pattern, no
  GitHub integration to set up for a project this size.
- **`scripts/check-bundle-size.mjs` build-time guard, not a WASM-shrinking fix:**
  see Known Technical Debt below — checked exact numbers against actual Cloudflare
  docs rather than assuming "under the limit" was good enough, then chose the
  lower-risk mitigation (loud build failure before the real cap) over a
  higher-risk, unverified binary swap.

---

## Environment Variables Required
```bash
# Frontend (repo root)
# .env.development (committed): VITE_ANSWER_API_URL=http://localhost:8787/answer
# .env.production (committed): VITE_ANSWER_API_URL=https://pocketrag-answer.abhiram-dev.workers.dev/answer

# worker/.dev.vars (gitignored, local dev only — see worker/.dev.vars.example)
GEMINI_API_KEY=
DISCORD_WEBHOOK_URL=

# Deployed Worker secrets (never in a file):
#   cd worker && wrangler secret put GEMINI_API_KEY
#   cd worker && wrangler secret put DISCORD_WEBHOOK_URL
```

`DISCORD_WEBHOOK_URL` is optional — the Worker checks it for truthiness before doing
anything, so the notification system stays fully inert (no KV read, no fetch) until
the secret is set. When set, every provider-call failure across all 5 BYOK providers
(`worker/src/index.ts`'s `notifyDiscordOfFailure`, called from both `/answer` and
`/models`'s catch blocks) posts a sanitized embed (provider, model, status, message —
same already-key-free string `logProviderError` uses, never the raw error/key) to the
webhook, registered via `ctx.waitUntil` so it survives after the response is sent
without blocking or delaying it. Suppressed to one alert per (provider, endpoint) per
10-minute window (`discord-notify:<provider>:<answer|models>` in the existing
`RATE_LIMIT_KV`, see `worker/src/discord.ts`) so a real outage or abuse burst doesn't
spam the channel — `/answer` and `/models` are tracked independently since they hit
different provider endpoints and can fail on their own (a `/models` failure never
suppresses a subsequent `/answer` alert for the same provider, or vice versa).

**Live production:**
- Frontend: `https://pocketrag.pages.dev` (Cloudflare Pages, project `pocketrag`,
  production branch `main`)
- API: `https://pocketrag-answer.abhiram-dev.workers.dev` (Cloudflare Worker)

Both deployed and verified end-to-end against the real production URLs in Session 5
(real browser, real PDF, real question, real Gemini answer, correct CORS). An earlier
note claiming this dev sandbox couldn't reach `*.workers.dev` was DNS propagation
delay for a brand-new subdomain, not a persistent restriction — both domains are
directly reachable from here now.

---

## Known Technical Debt
- [ ] `embedding.worker.ts` bundles onnxruntime-web's WASM runtime (22.47 MiB) —
      already loaded lazily (separate chunk, fetched only when the Worker is first
      used, not at page load), but the file itself is large: 10.1% headroom under
      Cloudflare Pages' 25 MiB per-file hard limit. Investigated forcing a smaller
      onnxruntime-web variant (13/14 MiB alternatives exist) — deferred deliberately,
      not a shortcut: the smaller variants may lack async interop our dual
      WebGPU/WASM pipeline needs, and onnxruntime-web's published bundle hardcodes
      the variant choice rather than exposing a safe switch. `scripts/check-bundle-size.mjs`
      (build-time guard, fails at 24 MiB) is the interim mitigation — it makes a
      future onnxruntime-web version bump fail loudly at build time instead of
      silently breaking a deploy, but doesn't reduce the size itself.
- [ ] `resolveBackend()`'s `webgpu` and `wasm-failed` states are unit-tested with a
      mocked GPU but have not been exercised against real WebGPU hardware (this dev
      sandbox has no GPU) — re-verify when real hardware is available.
- [ ] `checkGrounding()` only catches citation-level inconsistency, not content-level
      hallucination against a correctly-cited page — see Key Architectural Decisions.
- [ ] Root cause of Session 4's one-time 30s-280s latency outlier remains unconfirmed
      — Session 5 could not reproduce it (four separate timed tests, all under 1.5s).
      A 60s client-side timeout + manual retry now bounds the worst case regardless
      (`src/lib/answerRequest.ts`), so this is no longer a demo-day risk, just an
      open question if it recurs.
(Resolved in Session 5: the Worker is deployed and publicly reachable at
`pocketrag-answer.abhiram-dev.workers.dev`, `PAGES_ORIGIN` is set to the live Pages
origin, and the earlier "sandbox can't reach `*.workers.dev`" finding was just DNS
propagation delay for a brand-new subdomain, not an egress restriction.)
