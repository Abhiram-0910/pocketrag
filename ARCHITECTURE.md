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
│   ├── components/          # DropZone, DocumentList, QueryPanel, ByokPanel, NotesDropZone,
│   │                         # LandingPage, ui/Button, ui/StatusBanner
│   ├── lib/                  # Pure logic — retrieval (retrieval.ts, bm25.ts, reranker.ts,
│   │                          # similarity.ts, conversation.ts), ingestion (pdf.ts, chunker.ts,
│   │                          # pageRender.ts, sessionFiles.ts), persistence (db.ts,
│   │                          # historyDb.ts, embeddingClient.ts), network (egress.ts,
│   │                          # answerRequest.ts, ocrRequest.ts, apiError.ts, models.ts,
│   │                          # sanitizeHtml.ts), UX state
│   │                          # (errorTaxonomy.ts, queryScope.ts, diagramHeuristic.ts,
│   │                          # diagramImageSetting.ts, webSearchSetting.ts,
│   │                          # landingVisitSetting.ts), export (pdfExport.ts)
│   ├── store/                # documentStore.ts, chatStore.ts (Zustand)
│   └── workers/              # embedding.worker.ts, backend.ts, embedding.types.ts,
│                              # ortPin.ts (pinned ONNX Runtime version + jsDelivr path)
├── public/                   # favicon, self-hosted fonts, _headers (CSP + security headers)
├── e2e/                      # Manual Playwright checks (global install, not a dependency)
├── worker/                   # Cloudflare Worker — separate npm project, separate deploy
│   └── src/                  # index.ts, validate.ts, prompt.ts, labels.ts, grounding.ts,
│                              # rateLimit.ts, cors.ts, discord.ts,
│                              # providers/{gemini,openai,anthropic,grok,openrouter}.ts
├── scripts/                  # check-bundle-size.mjs (build-time Pages size guard)
├── README.md
├── CLAUDE.md
├── AGENTS.md
├── ARCHITECTURE.md
├── SECURITY_REVIEW.md
├── SKILLS.md
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
| `src/lib/db.ts` | IndexedDB via `idb`: `documents` + `chunks` object stores, `documentId` index on chunks. `saveDocument()`, `getChunksForDocument()` (this-document scope), `getAllChunks()` (all-documents scope), `getAllDocuments()` (restore-on-reload), `deleteDocument()` (atomic readwrite over both stores, via the `documentId` index). `requestPersistOnce()` asks for `navigator.storage.persist()` once per session, on the first document or chat-turn save. A failed open isn't cached, so the next call retries |
| `src/lib/historyDb.ts` | Chat history in its own IndexedDB database, `pocketrag-history` (see Key Architectural Decisions): `conversations` + `turns` stores, turns linked into a tree by `parentId`. `saveTurn()` (turn + conversation in one transaction, grounded answer dropped), `getConversations()`, `getTurns()`, `deleteConversation()`, `deleteAllHistory()`, `sweepInterruptedTurns()` |
| `src/store/chatStore.ts` | Zustand store over `historyDb.ts`: `startTurn()` persists the turn as `pending` and returns the `history` / `docLabels` / blend question for its request; `settleTurn()`, `retryTurn()`, `selectBranch()`, deletes. Grounded answer text lives only in its in-memory `groundedText` map. Not wired into the UI yet (Phase 2) |
| `src/lib/egress.ts` | The one place the app makes network requests: `egressFetch()` (Worker calls) and `downloadFetch()` (transformers.js `env.fetch`). Records each request (host, payload categories, bytes, timing, outcome) in an in-memory session log. `egress.bypass.test.ts` fails on a raw `fetch(` / XHR / beacon / WebSocket / EventSource anywhere else in `src/` |
| `src/lib/queryScope.ts` | `canRunQuery()` — pure readiness check extracted from `QueryPanel` so scope/selection logic is unit-testable without a DOM |
| `src/lib/embeddingClient.ts` | Main-thread singleton wrapper around the embedding Worker (typed postMessage protocol): `embedDocument()` and `embedQuery()` |
| `src/workers/embedding.worker.ts` | Loads tokenizer + model, chunks each page, embeds, and separately embeds single query strings — all model logic lives here, never on the main thread |
| `src/workers/backend.ts` | `resolveBackend()` — pure, worker-independent WebGPU/WASM detection and fallback logic, unit-tested without a browser |
| `src/store/documentStore.ts` | Zustand store: `documents: DocEntry[]` (per-document id/fileName/status/progress/chunkCount), `selectedId`, plus session-global backend + model-progress. Actions: add/update/remove/restore/select |
| `src/components/DropZone.tsx` | Drag-and-drop + browse; queues a whole batch up front, then embeds one document at a time. `processFile` resolves (never rejects) on ready or error so one bad file can't block the rest. Auto-selects the first ready doc |
| `src/components/DocumentList.tsx` | The multi-document library: one row per doc with live status, click-to-select (ready docs only), ✕ to dismiss an error row, inline two-step "Delete permanently?" confirm on ready rows (destructive — calls `deleteDocument()` then `removeDocument()`; failure keeps the row with a brief inline error) |
| `src/components/QueryPanel.tsx` | Scope toggle (this doc / all docs) → embed query → rank the scoped chunk pool from IndexedDB → POST to the Worker → composed answer as primary result, `Doc N = fileName` legend, raw ranked chunks as collapsible "Sources," visible failure note (not silent fallback) if the Worker call fails |
| `src/components/ByokPanel.tsx` | BYOK provider picker (all 5), key input, live model-list fetch, "(Experimental)" labeling for the 3 unverified providers — key is request-scoped component state only, never persisted |
| `src/components/NotesDropZone.tsx` | Notes-tab drop zone — per-file OCR consent prompt before anything uploads, no "remember my choice" shortcut |
| `src/components/LandingPage.tsx` | First-visit-only landing screen, gated by `landingVisitSetting.ts`'s localStorage flag |
| `src/components/ui/Button.tsx`, `ui/StatusBanner.tsx` | Shared primitives (Session 14 design system) — every action button and every error/warning/info banner in the app routes through these two |
| `src/lib/bm25.ts` | BM25 keyword scoring, fused with cosine similarity via Reciprocal Rank Fusion in `retrieval.ts`'s `hybridRankChunks()` |
| `src/lib/reranker.ts` | Client-side cross-encoder reranking (`Xenova/ms-marco-MiniLM-L-2-v2`) over the hybrid-search pool, with graceful fallback to hybrid-only results if reranking fails |
| `src/lib/conversation.ts` | `buildRetrievalQuery()` — blends the immediately preceding question into retrieval only, never sent to the Worker as-is (see Key Architectural Decisions). Also the conversation-tree ops over `historyDb.ts` turns: `pathTo`, `childrenOf`, `latestLeafUnder`, `historyForRequest` (answered, non-grounded turns only), `previousQuestionFor`, `docLabelsFor` |
| `src/lib/answerRequest.ts` | `attemptAnswer()` — one answer attempt wrapped in an `AbortController` ~60s timeout, discriminated `{outcome}` return instead of throwing |
| `src/lib/errorTaxonomy.ts` | Maps every failure (rate-limit, provider-unavailable, network, corrupt-pdf, webgpu-unsupported, unknown) to a severity + plain-language message |
| `src/lib/apiError.ts` | `WorkerRequestError` + `parseWorkerErrorResponse` (status-gated `resetAt` / `code` / `source`), `FAILURE_CODES` (parity-tested against `worker/src/failureCodes.ts`), `failureAction()` |
| `e2e/step-b-failures.cjs` | Manual Playwright run (global install, not a dependency) against `vite preview`, route-mocked: each failure code's banner, action, focus target, and live-region placement |
| `e2e/step-c-csp.cjs` | Manual Playwright run against any server that applies `public/_headers` (`wrangler pages dev`, a preview, or production): 12 app flows with Worker calls mocked, CSP reports read off the `report-uri` request; exits 1 on any violation except the allowlisted Gemini-widget `<style>` |
| `public/_headers` | Cloudflare Pages response headers: the enforced CSP (defined once, under `/*`) and the other security headers — see Key Architectural Decisions (Step C) |
| `src/workers/ortPin.ts` | The pinned ONNX Runtime version, its jsDelivr `dist/` path (must equal `_headers`' `connect-src` entry), and the recorded sha384 of each runtime file; `ortPin.test.ts` keeps all of it in step with `node_modules` and `_headers` |
| `src/lib/diagramHeuristic.ts`, `src/lib/pageRender.ts`, `src/lib/sessionFiles.ts` | Diagram-aware Q&A (Milestone 10): lexical diagram-likely detection, on-demand page-image rendering, and the session-only (never persisted) raw-`File` cache page rendering needs |
| `src/lib/diagramImageSetting.ts`, `src/lib/webSearchSetting.ts`, `src/lib/landingVisitSetting.ts` | Opt-in localStorage flags (diagram image sending, Gemini web-search grounding, landing-page-seen) — all default OFF/unset, same read-once-at-mount pattern |
| `src/lib/ocrRequest.ts` | Client-side call to the Worker's `/ocr` endpoint for Notes-tab transcription |
| `src/lib/pdfExport.ts` | `buildConversationPdf()` — jsPDF conversation export with real manual page-break logic (`ensureSpace()`) |
| `src/lib/sanitizeHtml.ts` | DOMPurify wrapper for Gemini grounding's `searchEntryPointHtml` before it reaches `dangerouslySetInnerHTML` (Session 27 security fix) |
| `worker/src/index.ts` | Request router: `POST /answer`, `POST /models`, `POST /ocr` — CORS → rate limit → validate → dispatch to the selected provider → groundedness check (answer only) → JSON response |
| `worker/src/validate.ts` | Caps chunk count (5), per-chunk text length (2000 chars), history/doc-label array sizes, and OCR file size/MIME type server-side; pattern-checks BYOK `apiKey` (`API_KEY_PATTERN`) and `model` (`GEMINI_MODEL_PATTERN` / `MODEL_PATTERN`, `..` rejected for all) — never trusts the client |
| `worker/src/prompt.ts` | Grounded-QA prompt: answer only from passages, cite `(Doc N, page M)`, admit gaps |
| `worker/src/labels.ts` | `assignDocLabels()` — `Doc N` ↔ documentId map, frozen per conversation via an `existing` param (see Key Architectural Decisions) |
| `worker/src/grounding.ts` | `checkGrounding()` — citation-level groundedness heuristic over `(Doc N, page)` pairs |
| `worker/src/rateLimit.ts` | KV counter-per-IP-per-day — independent buckets per tier/endpoint (shared `/answer`, BYOK, `/ocr`) |
| `worker/src/providers/*.ts` | One file per BYOK provider (gemini, openai, anthropic, grok, openrouter) — each a thin, injectable-`fetch` wrapper around that provider's chat + model-list endpoints, same two-key-leak-test discipline |
| `worker/src/providers/errors.ts` | `providerError()` — the only way provider files throw: parses a non-2xx body for message/code, exact-key scrubs, caps at 200 chars, applies the prompt-echo guard, then drops the body. Also `redactKeys()`, the pattern backstop used at the log and Discord sinks |
| `worker/src/discord.ts` | Fire-and-forget (`ctx.waitUntil`) sanitized failure alerts to an optional webhook, suppressed per `(provider, endpoint, slot)` — 10 min for `shared`/`own`, 6 h for `shared-ratelimit` |

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
- **OCR'd documents (Notes tab) don't chunk deterministically across re-uploads of the
  same file**, unlike the Documents tab's typed-PDF pipeline (`pdf.js` text extraction
  is deterministic byte-for-byte). This is an expected property of LLM-based
  transcription — Gemini's exact transcribed text can vary slightly run to run, which
  shifts chunk boundaries/counts downstream — not a bug in `chunker.ts` or a regression.
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
- **Multi-document citations via `Doc N` labels, frozen per conversation (Worker-owned):**
  with retrieval able to span multiple documents, a page number alone is ambiguous, so
  passages are labelled `[Doc N, Page M]` and the model cites `(Doc N, page M)`. The
  **Worker** is the single source of truth for the label mapping — `assignDocLabels()`
  (`worker/src/labels.ts`) assigns `Doc N` per distinct `documentId` in first-appearance
  order over that query's ranked chunks, and the Worker both builds the prompt and grounds
  against that same mapping. It returns the `label → documentId` map to the client, which
  joins `documentId → fileName` (known only in the browser) to render a legend under the
  answer (`Doc 1 = report.pdf · Doc 2 = notes.pdf`) and the Sources list. Filenames never
  leave the browser; only opaque `documentId` UUIDs are sent.
  **Superseded in Milestone 11 Phase C:** labels used to be generated fresh per answer and
  explicitly documented as NOT stable across queries — the same document could be `Doc 1`
  for one question and `Doc 2` for another. That's deliberately no longer true. The client
  now echoes back the `docLabels` map it last received (an optional `docLabels` field on
  `AnswerRequestBody`, capped server-side at `MAX_DOC_LABELS` and rejected outright if
  malformed or containing a duplicate `label`/`documentId`), and `assignDocLabels()` takes
  that map as an `existing` parameter: entries already in it are never reassigned or
  reordered, only appended to for documents seen for the first time in that call. A
  document is `Doc 1` for the rest of a conversation once assigned, even if a later
  question in between doesn't retrieve it. Numbering restarts at `Doc 1` only when the
  client-side conversation state resets (a page reload, or the explicit "Clear
  conversation" control added in Phase C2, below). The Worker remains the sole owner of
  the mapping — the client only ever echoes back what the Worker last told it, never
  invents label numbers itself. `checkGrounding()` needed no logic change for this: it
  only ever compares an answer against the *current* turn's `(label, page)` pairs, built
  fresh from that turn's chunks through whatever `labelOf` map resulted — whether a label
  is new or carried over from an earlier turn is invisible to it.
- **Conversation context — retrieval-query blending + prompt history (Milestone 11 Phase
  C2), two deliberately separate mechanisms:** (1) **Retrieval-query blending**
  (`src/lib/conversation.ts`'s `buildRetrievalQuery()`) folds the immediately preceding
  question — and only that one (`RETRIEVAL_HISTORY_TURNS = 1`) — into the query text used
  for embedding and BM25 matching (`hybridRankChunks`), so a vague follow-up like "what
  page is that on?" still retrieves the right chunk. This never crosses the wire — the
  literal, unblended question is still what the Worker answers, and the cross-encoder
  reranker (Phase B) also scores against the literal question, not the blended one, since
  reranking targets precision on what's actually being asked rather than recall. (2)
  **Prompt history** is the opposite: a capped list of recent `{question, answer}` pairs
  (`history` on `AnswerRequestBody`, `MAX_HISTORY_TURNS = 3`, truncated not rejected —
  this is content the app itself already produced/received, not attacker-controlled
  payload) that *does* cross the wire and gets interpolated into `buildPrompt()`'s
  "Conversation so far" section, shown to the model for context with an explicit "do not
  cite from this" instruction. Client-side, `QueryPanel.tsx` stores a capped
  (`MAX_STORED_TURNS = 10`) conversation-turn array; only the most recent
  `SENT_HISTORY_TURNS` (3) are sent on each request — the Worker independently re-caps to
  `MAX_HISTORY_TURNS` regardless. A "Clear conversation" control resets the turn list, the
  frozen `docLabels` map, and the current answer — restarting `Doc N` numbering — without
  touching document selection/scope, which are library state, not conversation state.
  **Grounding risk, documented as a known limitation rather than built around:** because
  the prompt now shows a prior answer's own citations, a model could echo one it recalled
  from history instead of from this turn's actual passages — `checkGrounding()` correctly
  flags this as `hasUnknownCitation` regardless, since `providedPairs` is always built
  fresh from *this turn's* chunks (see the doc-comment in `grounding.ts`).
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
  checked exact numbers against actual Cloudflare docs rather than assuming "under
  the limit" was good enough, then chose the lower-risk mitigation (loud build failure
  before the real cap) over a higher-risk, unverified binary swap. Step C later found
  that the 22.48 MiB wasm it was guarding was never fetched at runtime and stopped
  emitting it (see the Step C entry); the guard stays as a backstop for any asset.
- **Provider failures are classified, not passed through (Step A, `85a925d`).**
  `worker/src/index.ts`'s `classify()` turns a `ProviderError` (status + sanitized
  provider code + scrubbed message) into one of four codes, and the client gets a
  fixed string for that code — never provider text. HTTP status stays **502** for
  every provider failure (the frontend's `errorTaxonomy.ts` keys off it); `code`, and
  `source` (`shared`|`own`) on rate limits, are additive JSON fields that only pick a
  UI action (Step B, below). Checked in order:

  | Tier | Status / signal | `code` | Client copy |
  |---|---|---|---|
  | shared | 429 | `provider_rate_limited` (`source: shared`) | "The free shared tier is at capacity right now. Try again later, or use your own API key." |
  | shared | anything else, incl. network/shape errors | `provider_unavailable` | "The free tier couldn't respond right now. Try again in a moment, or use your own API key." |
  | own | provider code `API_KEY_INVALID` / `invalid_api_key`, or 401 / 403, or 400 whose message matches `/\bapi key\b/i` | `key_rejected` | "The provider rejected your API key. Check that it's correct, active, and has access to this model." |
  | own | 429 / 402 | `provider_rate_limited` (`source: own`) | "Your provider account hit its rate limit, quota, or credit balance. Wait a moment or check your plan." |
  | own | 400 / 404 / 413 / 422 | `request_rejected` | "The provider rejected this request. The selected model may not be available to your key; try another." |
  | own | ≥ 500 | `provider_unavailable` | "The provider couldn't respond right now. Please try again in a moment." |
  | own | any other status, or no status (network failure, bad response shape, empty answer) | `provider_unavailable`, *unclassified* | Same as above — except on an `EXPERIMENTAL_PROVIDERS` provider, where it's "This provider isn't fully supported yet…" (`/answer`) / "This provider's model list isn't available yet…" (`/models`) |

  The shared tier never says "your key" or "your request" — the key is ours. `/models`
  is always classified as `own`. Our own per-IP rate limit is separate: it returns
  429 before any provider call.
- **The UI shows the Worker's `error` verbatim; `code` only picks an action (Step B,
  `32e3d09`).** `src/lib/apiError.ts`'s `parseWorkerErrorResponse` reads fields by
  status — `resetAt` only on our own 429, `code`/`source` only on a 502, unknown values
  dropped — so a provider rate limit can never render as ours, and an older Worker
  with no `code` still shows its message with no action. `failureAction(code, source)`
  maps `key_rejected` → "Check your key", `provider_rate_limited` + `shared` → "Use
  your own key" (own → none), `request_rejected` → "Choose another model",
  `provider_unavailable` → "Try again". `FAILURE_CODES` lives in
  `worker/src/failureCodes.ts` and is copied (never imported) into `apiError.ts`;
  `src/lib/failureCodes.test.ts` fails if they drift. The key and model list stay in
  `ByokPanel`'s local state, so `QueryPanel`'s actions reach it through a
  `ByokPanelHandle` ref (`useImperativeHandle`, wired in `App.tsx`): check-key clears
  the model list and selection and focuses the key input (key kept, re-fetchable
  without retyping); choose-model focuses the model select without clearing it;
  use-own-key turns BYOK on and focuses the provider select; retry re-runs the answer
  and then focuses the question input. Failure banners render inside always-mounted
  `aria-live="polite" aria-atomic="true"` containers (`StatusBanner inLiveRegion`
  drops its own role so nothing is announced twice).
- **Explicit model choice after a fetch (Step B).** `src/lib/models.ts`'s
  `defaultModelFor` pre-selects only Gemini's pinned `PREFERRED_GEMINI_MODEL`, and only
  if the fetched list contains it; every other case leaves a disabled "Choose a model"
  placeholder and no key config, so Search stays disabled until the user picks. No
  provider's list order is a safe default (OpenAI/OpenRouter/Grok are unordered or
  include models that can't answer; Anthropic's newest-first would pick the priciest).
- **Enforced Content-Security-Policy (Step C, `2146f71` + `41931e3`, production
  `8c992a01`).** `public/_headers` sends one policy under `/*`. Every source below was
  measured, not assumed: a Playwright run of every flow under a deliberately strict
  report-only policy logged each request and each violation (including the ones raised
  inside the workers, which only reach `report-uri`), then the final policy was run
  report-only on a preview, enforced on the preview, then enforced in production.
  - `default-src 'none'` — everything not listed below is refused.
  - `script-src 'self' 'wasm-unsafe-eval' blob:` — `'self'` for the bundles and both
    workers; `'wasm-unsafe-eval'` because ONNX Runtime compiles its wasm (measured
    `wasm-eval` violation); `blob:` because transformers.js fetches ORT's `.mjs` and
    imports it from a `blob:` URL (`loadWasmFactory`). No `'unsafe-inline'`/`'unsafe-eval'`:
    `dist/` has no inline script and no `eval`/`new Function`.
  - `style-src 'self'` — Tailwind is a static file and the app sets no `style`
    attributes. Kept strict deliberately: React mirrors the BYOK API key into the
    input's `value` *attribute*, so injected CSS (e.g. `input[value^="sk-a"]` with a
    background URL) could leak it; strict `style-src` plus `img-src`/`font-src`
    `'self'` closes that path. The only report is Chromium flagging the Gemini
    search-suggestions widget's leading `<style>` while DOMPurify parses it — which
    DOMPurify then drops anyway, so nothing renders differently.
  - `img-src 'self'` (the favicon is the app's only image), `font-src 'self'`
    (self-hosted Inter), `worker-src 'self'` (the embedding and pdf.js workers are
    same-origin URL workers; no `blob:` workers).
  - `connect-src` — the Worker origin; `https://huggingface.co` plus `https://*.hf.co`
    (model files redirect to Hugging Face's CDN, e.g. `us.aws.cdn.hf.co`; removing it
    breaks embedding, and the violation report only names the pre-redirect
    `huggingface.co` URL); `https://*.huggingface.co` as a hedge for Hugging Face's
    older LFS CDN; and jsDelivr restricted to the exact ORT version path
    `https://cdn.jsdelivr.net/npm/onnxruntime-web@<ORT_VERSION>/dist/` (from
    `src/workers/ortPin.ts`). No `'self'`: the app makes no same-origin fetch.
  - `object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    and `report-uri /__csp-report` (a path nothing serves; it exists so the e2e can
    read reports — production violations are not collected).
  - Other headers: `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (replacing
    Pages' default `strict-origin-when-cross-origin`; nothing reads the Referer),
    `Permissions-Policy` denying camera/mic/geolocation/payment/usb/serial/hid/midi/
    display-capture/browsing-topics, `Cross-Origin-Opener-Policy: same-origin`, and
    `! Access-Control-Allow-Origin` removing Pages' default `*` (nothing of ours is
    loaded cross-origin). `X-Content-Type-Options: nosniff` is Pages' default.
  - No COEP: cross-origin isolation (and with it threaded wasm) is a separate
    experiment, not part of this policy; COOP alone doesn't isolate the page, so ORT
    still runs single-threaded on the WASM path.
  - The CSP is defined exactly once: Pages comma-joins a header set by two matching
    rules, which for CSP would mean two policies enforced together.
- **ONNX Runtime stays on jsDelivr, at a pinned path (Step C).** transformers.js sets
  onnxruntime-web's `wasmPaths` to jsDelivr itself. Self-hosting was rejected: today's
  asyncify wasm (22.48 MiB) would fit, but transformers.js 4.3.x brings ORT 1.31 whose
  asyncify wasm is 25.62 MiB — over Pages' 25 MiB per-file cap — so self-hosting would
  block every future upgrade. Instead `vite.config.ts` resolves onnxruntime-web with the
  `onnxruntime-web-use-extern-wasm` export condition, which drops the bundle entry's
  `new URL()` fallback that made Vite emit an unused 22.48 MiB wasm into `dist/` (the
  largest `dist/` file is now pdf.js's 2.12 MiB worker). The jsDelivr files are not
  integrity-checked at runtime — see SECURITY_REVIEW.md §7 for why SRI was dropped.
- **Chat history lives in its own IndexedDB database, `pocketrag-history` (Phase 1,
  2026-10-19).** Not two new stores in `pocketrag` at version 2, because of rollback:
  if `pocketrag` went to v2 and Pages were rolled back to a build from before history,
  that build's `openDB('pocketrag', 1)` would throw `VersionError`, and `App.tsx`'s
  restore `.catch(() => {})` would show an empty library with every save failing and no
  error visible. With a separate database the older build never opens the history DB,
  and the documents DB stays at the version every build expects. The cost: no
  transaction spans both, so deleting a document can't cascade into history; turns hold
  only `chunkId`/`documentId` references, so a deleted document's text doesn't linger
  in history (an answer may still paraphrase it).
  - **Schema** (`historyDb.ts`, v1): `conversations` (`activeLeafId` = the branch
    shown) and `turns`. A turn has question, answer, status (`pending` / `answered` /
    `failed` / `timed-out` / `interrupted`), the Worker's full `docLabels` map after
    that turn, citations (chunk/document ids, page, rank, score — no text), scope, tier,
    provider, model (`null` on the shared tier: the Worker picks it and doesn't say),
    image/web-search flags, `webGrounded`, the Step A/B failure (`code`, `source`, HTTP
    status, and the Worker's fixed `error` copy, stored because the UI shows it verbatim
    and never rebuilds copy from `code`), and `egress` records (empty until Phase 2).
  - **Tree:** editing or regenerating a turn adds a sibling under the same `parentId`.
    A new turn's request `history` = the last 3 answered, non-grounded turns on its
    root-to-parent path; its echoed `docLabels` = the nearest answered ancestor's map,
    so each branch keeps its own consistent Doc N numbering. Retry after a failure
    reuses the same turn.
  - **Written `pending` before the request goes out**, so a tab that dies mid-request
    still leaves the turn. On load, `pending` turns older than `STALE_PENDING_MS` (5 min)
    become `interrupted`; younger ones may be another tab's request still in flight.
  - **Grounded answers are never persisted** — `saveTurn()` nulls `answer` whenever
    `webGrounded`, and `chatStore` keeps the text in an in-memory map for the session.
    `webSources` and `searchEntryPointHtml` have no field at all. Grounded turns are
    also never sent upstream as `history`. Basis: the Gemini terms (SECURITY_REVIEW.md
    §1.1, correction).
  - **Migrations:** each future version is its own `if (oldVersion < N)` step in
    `upgrade()`. The upgrade is one versionchange transaction, so a throw rolls it back
    to the previous version with data intact (`historyDb.test.ts` checks this on
    fake-indexeddb). **Never await a non-IndexedDB promise inside `upgrade()`**: the
    transaction auto-commits and the migration is left half-done. If the open fails,
    history degrades to memory-only for the session; documents are unaffected. The
    connection closes itself when another tab opens a newer version (`blocking`), so
    that tab's upgrade isn't stuck — shipped in v1 because deployed builds can't be
    patched later.
  - **Storage:** quota, eviction and `persist()` behave per MDN's "Storage quotas and
    eviction criteria" (Chromium 60% of disk; Firefox best-effort min(10% of disk,
    10 GiB group); Safari 17+ ~60%). Eviction takes the whole origin at once, so
    documents, history and the model cache go together, and Safari deletes
    script-written data after 7 days without interaction. A failed write
    (`QuotaExceededError` or otherwise) only flips `chatStore.storage`; the
    conversation stays in memory.
- **Every outbound request goes through `src/lib/egress.ts` (Phase 1, 2026-10-19).**
  `egressFetch()` wraps the three Worker calls (`/answer`, `/models`, `/ocr`);
  `downloadFetch()` is installed as transformers.js's `env.fetch` in the embedding
  worker, which covers model files (`hub.js`) and ONNX Runtime's `.wasm`/`.mjs`
  (`cacheWasm.js`) on the normal path. Each request is recorded twice (in flight, then
  settled) with destination host, post-redirect host, via worker or direct, upstream
  provider, payload categories, UTF-8 body bytes, timing, HTTP status and outcome.
  Worker records go to an in-memory session log; per-turn persistence and the
  Receipts view are Phase 2. Model downloads stay session-level records: they carry no
  user data, happen once per browser (cache hits never reach `env.fetch`), and can't be
  pinned to a turn without guessing.
  - **Categories come from the body, not the caller:** a fixed map of top-level keys
    (`question` → question, `chunks` → passage text + document ids, `docLabels` →
    document ids, `history` → history, `image` → page image, `base64` → OCR file,
    `apiKey` → API key; `keySource`/`provider`/`model`/`enableWebSearch`/`mimeType` carry
    none). An empty value carries nothing. A key not in the map throws in dev and tests,
    so a new request field can't ship without a ledger decision; in production the
    request still goes out and is recorded `uncategorized`.
  - **Bypass guard:** `src/lib/egress.bypass.test.ts` scans every non-test `src/` file
    (comments stripped) for `fetch(`, `globalThis`/`window`/`self.fetch`,
    `XMLHttpRequest`, `sendBeacon`, `new WebSocket`, `new EventSource` outside
    `egress.ts`, and checks the worker still assigns `env.fetch`. A scan, not a lint
    rule, because `no-restricted-globals` misses `globalThis.fetch`.
  - **What it can't see:** ONNX Runtime's fallback path (when its cached load fails it
    re-fetches the `.wasm` with `XMLHttpRequest` and re-imports the `.mjs` with
    `import()`, neither through `env.fetch`); intermediate redirect hops; browser-
    initiated same-origin loads (app shell, fonts, pdf.js worker); navigations (a
    clicked web-source link, `window.open`); WebRTC. The enforced CSP is the bound on
    that gap: `connect-src` limits fetch/XHR/beacon/WebSocket/EventSource — from the page
    and both workers — to the Worker origin, Hugging Face, and the one pinned jsDelivr
    path, so ORT's XHR fallback can only reach a host the ledger already names, and
    `script-src` blocks the cross-origin `import()`. CSP covers neither navigations nor
    WebRTC. Details: SECURITY_REVIEW.md §8.

---

## Environment Variables Required
```bash
# Frontend (repo root)
# .env.development (committed): VITE_API_BASE_URL=http://localhost:8787
# .env.production (committed): VITE_API_BASE_URL=https://pocketrag-answer.abhiram-dev.workers.dev
# (answerRequest.ts / models.ts / ocrRequest.ts append /answer, /models, /ocr)

# worker/.dev.vars (gitignored, local dev only — see worker/.dev.vars.example)
GEMINI_API_KEY=
DISCORD_WEBHOOK_URL=

# Deployed Worker secrets (never in a file):
#   cd worker && wrangler secret put GEMINI_API_KEY
#   cd worker && wrangler secret put DISCORD_WEBHOOK_URL
```

`DISCORD_WEBHOOK_URL` is optional — the Worker checks it for truthiness before doing
anything, so the notification system stays fully inert (no KV read, no fetch) until
the secret is set. When set, a provider-call failure from `/answer` or `/models`
(`worker/src/index.ts`'s `notifyDiscordOfFailure`) posts a sanitized embed (provider,
model, status, tier, failure `code`, provider code, and the same scrubbed message
`logProviderError` uses, passed through `redactKeys` — never the raw error/key) to the
webhook, registered via `ctx.waitUntil` so it survives after the response is sent
without blocking or delaying it. Gating (`shouldAlert`, Step A):

- **Shared tier always alerts** — our key, our problem.
- **Own key alerts only when it might be ours to fix:** `provider_unavailable`, or
  `request_rejected` on an `EXPERIMENTAL_PROVIDERS` provider (our request shape is
  unproven there). A user's bad key or exhausted quota is theirs, not an incident.

Suppression is one alert per (provider, endpoint, slot) per window
(`discord-notify:<provider>:<answer|models>:<slot>` in the existing `RATE_LIMIT_KV`,
see `worker/src/discord.ts`). Slots: `shared` and `own` use a 10-minute window;
`shared-ratelimit` (shared-tier `provider_rate_limited`) uses 6 h, since free-tier
quota exhaustion is a daily condition, and having its own slot means it never
suppresses a different shared-tier failure. `/answer` and `/models` are tracked
independently (a `/models` failure never suppresses a subsequent `/answer` alert for
the same provider, or vice versa).

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
- [x] ~~`embedding.worker.ts` bundles onnxruntime-web's WASM runtime (22.47 MiB)~~ —
      resolved in Step C: that file was emitted into `dist/` but never fetched
      (transformers.js loads ORT from jsDelivr), and the extern-wasm resolve condition
      now stops emitting it. Remaining size risk moved to upgrades: transformers.js
      4.3.x's ORT wasm (25.62 MiB) can't be self-hosted on Pages, hence the exact pin.
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
