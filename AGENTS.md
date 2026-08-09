# AGENTS.md — Session Handoff Log

This file is updated at the END of every Claude Code session.
Claude reads this at the START of every new session to understand what happened before.

---

## Project State
**Last updated:** 2026-08-09
**Current branch:** master (through `f4e2806` BYOK Milestone 7a, deployed and
pushed — see below)
**Remote:** `github.com/Abhiram-0910/pocketrag` (private) — pushed and up to date.
**Overall status:** MVP **+ Milestone 6 (multi-document)** + **Milestone 7a (BYOK,
Gemini-only)** feature-complete and **fully deployed in production**. Frontend:
`https://pocketrag.pages.dev` (Cloudflare Pages). API:
`https://pocketrag-answer.abhiram-dev.workers.dev` (Cloudflare Worker). Supports a
multi-document library, bulk drag-and-drop, a this-document/all-documents retrieval
scope toggle with cross-document ranking, Worker-owned per-request `Doc N` citation
labels, restore-on-reload from IndexedDB, `navigator.storage.persist()`, deleting a
persisted document, and now bring-your-own-Gemini-API-key as an alternative to the
shared/free-tier key — live model-list fetch, model picker, real answer calls, key
never persisted anywhere server- or client-side. 60s timeout + manual retry still
there as a demo-day safety net.

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

### Session 4 — 2026-07-25
**Goal:** Cloudflare Worker answer-composition endpoint: real Gemini call, grounded-QA
prompt, KV rate limiting, CORS, wired into QueryPanel with composed answer as the
primary result and raw ranked chunks as a fallback/sources view.

**Environment check (before writing code, as instructed):** Wrangler was authenticated
(`dvabhiram2005@gmail.com`, account `da55acd99cee5a43df7d397dd80af4e3`); `GEMINI_API_KEY`
was not set anywhere in this environment. Reported both clearly and got explicit "Go —
build everything you can without the key first" before touching code.

**Grill-me answer given before starting:** asked how we'd notice a hallucinated-but-
plausible answer despite the prompt. Answer: we wouldn't, by default — added a real
(if limited) check: `checkGrounding()` flags an answer if it cites a page number not
in the input passages, or cites nothing without an explicit "not in the passages"
disclaimer. Documented what it does *not* catch (content misattributed to a real,
correctly-cited page) as a known limitation rather than pretending full coverage.

**Completed:**
- [x] `worker/` — standalone npm project, own `package.json`/`tsconfig.json`/
      `vitest.config.ts`, `wrangler.jsonc` (name `pocketrag-answer`, `nodejs_compat`,
      observability enabled)
- [x] Created the real `RATE_LIMIT_KV` KV namespace via `wrangler kv namespace create`
      (needed no Gemini key) and ran `wrangler types` to generate `Env` — never
      hand-wrote the binding interface, per workers-best-practices guidance
- [x] `worker/.dev.vars` (placeholder, gitignored) + `.dev.vars.example` (committed)
      created so `wrangler types` would pick up `GEMINI_API_KEY: string` in `Env`
      before the real key existed
- [x] Verified the exact Gemini `generateContent` REST contract (endpoint, body,
      response shape) via the official docs before writing `gemini.ts` — did not
      trust pre-trained knowledge of an external API contract
- [x] `worker/src/validate.ts` — caps chunks to 5 and chunk text to 2000 chars
      server-side (truncates, doesn't reject — the honest client only ever sends 3
      short chunks, this is an abuse guard)
- [x] `worker/src/prompt.ts`, `grounding.ts`, `rateLimit.ts` (KV counter + TTL,
      `ponytail:`-marked as a soft/non-atomic cap), `cors.ts` (localhost always
      allowed, production origin via `PAGES_ORIGIN` var), `gemini.ts` (injectable
      `fetchImpl` for testing) — all pure functions per the user's explicit testing
      requirement
- [x] `worker/src/index.ts` — `POST /answer` handler wiring all of the above,
      `satisfies ExportedHandler<Env>`
- [x] 40 Worker unit tests (mocked `KVLike`, mocked `fetch`, real `Request`/`Response`
      Web APIs in plain Node — no `@cloudflare/vitest-pool-workers`, per the user's
      explicit "don't require a live Gemini call or full Wrangler runtime" instruction)
- [x] `QueryPanel.tsx` rewritten: composed answer as primary result (with a caveat
      banner when `groundingWarning` is true), raw ranked chunks as a native
      `<details>` "Sources" section (collapsed when there's an answer, open when
      there isn't), visible amber failure note — not a silent fallback — when the
      Worker call fails
- [x] `.env.development` (`VITE_ANSWER_API_URL=http://localhost:8787/answer`),
      `src/vite-env.d.ts` for the `ImportMetaEnv` augmentation
- [x] User set the secret (`wrangler secret put GEMINI_API_KEY`, run from the wrong
      directory once — needs to be run from `worker/`, told them so) and created
      `worker/.dev.vars` locally
- [x] Live verification: `wrangler dev` + Vite dev together, direct `curl` to the
      Worker first (faster feedback than a full browser round-trip), then a full
      Playwright-driven browser run — dropped the topic-diverse test PDF, asked "How
      does a cell produce energy?", got a real Gemini-composed answer citing page 1
      correctly, `groundingWarning: false`, zero console errors. Screenshot inspected:
      answer shown as primary result, "Sources (3)" collapsed underneath, matches the
      design exactly.
- [x] 71 total tests (31 frontend + 40 Worker), both typecheck clean, both lint clean
      (frontend), both build clean. Playwright installed and removed again after
      verification; confirmed no leftover.

**Decisions made / problems encountered (the two are the same list this session):**
- **`gemini-2.5-flash-lite` (the model named in the original spec) is dead for this
  key.** First real Worker call returned `404: This model ... is no longer available
  to new users`. Verified this wasn't transient (tested twice), then queried the live
  models list with the real key to find what's actually available. Found
  `gemini-flash-lite-latest` works but silently resolves to `gemini-3.5-flash-lite`
  under the hood — a moving target, not a pin. Stopped and asked the user rather than
  picking one myself; they chose to pin explicitly to `gemini-3.5-flash-lite`. Updated
  `gemini.ts`, `gemini.test.ts`, `CLAUDE.md`, `ARCHITECTURE.md` to match.
- **`wrangler secret put` implicitly deployed the Worker** — before I'd fixed the model
  ID. Caught this by running `wrangler deployments list` after the fact (habit: verify,
  don't assume) and found the live deployment predated the fix. Redeployed with
  `wrangler deploy` after fixing the model.
- **`wrangler deploy` then failed**: this Cloudflare account has never registered a
  `workers.dev` subdomain, and registering one requires an interactive yes/no that
  can't be given non-interactively. The Worker code itself uploaded successfully
  (confirmed via the deploy output) — it's just not reachable at a public URL yet.
  Told the user clearly; left `cd worker && wrangler deploy` (say yes to the subdomain
  prompt) as their action item. This does not block anything else — local
  `wrangler dev` fully proved the code is correct.
- **Gemini call latency: 30s–280s observed in this sandbox**, not model-load time (the
  model loads once). The frontend's "Searching…" state doesn't set this expectation —
  a real UX gap, flagged in TODO.md, not fixed this session (out of scope, not asked).
- **Two `tsc` friction points fixed, both worth remembering:** (1) a `vars` value
  left as `""` in `wrangler.jsonc` gets inferred as the *literal* type `""`, not
  `string` — test code needed a local `TestEnv` widening type, not a change to the
  real `Env`. (2) A locally-constructed `new Request(...)` doesn't structurally match
  the ambient `IncomingRequestCfProperties`-typed `Request` that `ExportedHandler`
  expects (missing edge-only `cf` fields the handler never reads) — needed one
  documented cast helper (`asIncoming`) in test code only, never in `index.ts` itself.
- **Only 2 of the 3 backend states get exercised by anything live this session** (see
  Session 2's note) — unchanged, not revisited.

**Left incomplete:**
- `wrangler deploy`'s interactive subdomain registration (user's action item, see above).
- Once that URL exists: `.env.production`'s `VITE_ANSWER_API_URL`, and `PAGES_ORIGIN`
  in `worker/wrangler.jsonc`, both still placeholders.
- Frontend not yet deployed to Cloudflare Pages at all — out of this milestone's scope.
- Session 4's changes are **not yet committed** — 596+ lines across `worker/`,
  `QueryPanel.tsx`, `.env.development`, `vite-env.d.ts`, plus the `CLAUDE.md`/
  `ARCHITECTURE.md`/`TODO.md` doc updates. Ask before committing, per this project's
  standing git rule.

**Next session should start with:**
- Confirm the `workers.dev` subdomain got registered and grab the real Worker URL.
- Milestone 5 (likely): Cloudflare Pages deploy for the frontend, then wire
  `VITE_ANSWER_API_URL` / `PAGES_ORIGIN` to the real URLs and redeploy the Worker once
  more with the correct CORS origin.

---

### Session 5 — 2026-07-25
**Goal:** User registered the `workers.dev` subdomain and deployed (Worker live at
`https://pocketrag-answer.abhiram-dev.workers.dev`). Wire the real URL into
`.env.production`, then investigate last session's 30s–280s Gemini latency before
Milestone 5 — is it consistent, cold-start, request-size-related, or Gemini-side —
with real measured numbers, not a guess. Add an honest wait-time UI note regardless.

**Completed:**
- [x] `.env.production` created: `VITE_ANSWER_API_URL=https://pocketrag-answer.abhiram-dev.workers.dev/answer`
- [x] Latency investigation, four separate timed tests:
  1. Direct to Gemini (`generativelanguage.googleapis.com`, bypassing our Worker
     entirely), minimal prompt, 3 sequential calls: **1.00s, 0.77s, 1.27s**
  2. Direct to Gemini, full-size grounded-QA prompt (~3 chunks worth of text,
     matching real usage), 3 sequential calls: **0.88s, 0.87s, 0.77s**
  3. Through our Worker code (`wrangler dev`, warm/already-running), 5 sequential
     calls: **1.24s, 0.88s, 0.99s, 0.80s, 0.79s**
  4. Through our Worker code, **freshly restarted** `wrangler dev` (true cold
     start), first call only: **1.44s**
  - All four tests: consistently under 1.5s. Rules out request/response size and
    Worker/fetch-subsystem cold start as causes. Did **not** reproduce anything
    resembling the earlier 277s/30-280s observation under any condition tested.
- [x] Attempted to test the actual live `pocketrag-answer.abhiram-dev.workers.dev`
    URL directly via curl — discovered this sandbox cannot reach it (DNS resolves to
    real Cloudflare anycast IPs, but both IPv4 and IPv6 connections fail immediately,
    not slowly). Confirmed it's specific to this subdomain, not a general network
    outage: `generativelanguage.googleapis.com` returns 404 (real HTTP response) and
    base `workers.dev` returns 301 (real HTTP response) from the same shell. Looks
    like an egress allowlist gap for this specific new subdomain. Documented in
    TODO.md so future sessions don't waste time on the same dead end — test via
    `wrangler dev` locally instead (same code, real Gemini calls, no egress issue).
- [x] `src/components/QueryPanel.tsx` — added an `awaitingAnswer` state, scoped
    specifically to the Gemini-wait phase (not the fast local embed+retrieve phase
    that precedes it), with a visible, honest message: "Generating an answer… this
    usually takes a few seconds, but can occasionally take up to a few minutes on
    the free tier. Please don't close this tab." Not a fake progress bar — no signal
    exists to build one from (Gemini's `generateContent` is non-streaming).
- [x] Frontend tests (31), typecheck, lint all still pass after the change.
- [x] `src/lib/answerRequest.ts` — extracted `attemptAnswer()`, a pure function
    wrapping one answer attempt in an `AbortController`-based timeout, following the
    project's established pattern (injectable `FetchAnswerFn`, no React/DOM
    dependency, same shape as `resolveBackend()` in Session 2). Returns a discriminated
    `{outcome: 'success'|'timeout'|'error'}` rather than throwing, so the caller
    doesn't need try/catch gymnastics to tell a timeout apart from a real failure.
- [x] `answerRequest.test.ts` — 6 tests using `vi.useFakeTimers()` and a
    `hangingFetchAnswer()` mock that mimics real `fetch()`'s abort behavior (never
    resolves on its own, rejects with a real `DOMException('...', 'AbortError')` when
    the signal fires): success, timeout-after-60s, no-false-positive-just-before-
    deadline, plain error (non-timeout), and two tests specifically proving the retry
    path works identically to the first attempt with no leftover state between calls
    (the explicit ask: "verify the timeout actually fires and the retry path
    re-triggers correctly").
- [x] `QueryPanel.tsx` wired to `attemptAnswer`: first timeout shows a "This is
    taking longer than expected" + "Try again" button (reuses the already-in-memory
    `results` and `submittedQuestion` — retry never re-embeds the query or re-hits
    IndexedDB); a second timeout on retry produces the same amber hard-failure note
    as any other failure, not another retry loop. The "Generating an answer…" wait
    message from earlier this session is unchanged for the first 60s — `timedOut`
    only flips after the deadline, so the two messages never overlap.
- [x] 37 frontend tests (31 + 6 new), typecheck, lint, build all pass clean.

**Grill-me answer given earlier this session, now acted on:** recommended a ~60s
client-side timeout with manual retry over a pre-warm request (see reasoning above,
unchanged) — approved and implemented as described.

**Problems encountered:** none. The inability to curl the live URL directly (found
earlier this session) remained a non-issue — all new work is frontend-only and
doesn't touch the Worker.

**Left incomplete:**
- Root cause of the original 277s/30-280s observation remains **unconfirmed**, not
  "fixed" — it simply didn't reproduce under this session's testing conditions. If it
  recurs, the next thing to check would be Gemini-side per-minute rate limits
  triggering soft throttling under bursty request patterns (several rapid calls were
  made while debugging the model-ID issue in Session 4, which is when the slow calls
  were observed) rather than the endpoint being inherently slow. The new timeout+retry
  means this no longer blocks a demo even if unexplained — worst case, one retry click.

**Continued same session — Milestone 5: Cloudflare Pages deploy.**

**Goal:** Deploy the frontend to Cloudflare Pages. Before that: user flagged that
the ~22.5MB onnxruntime-web WASM asset noted earlier as "under the limit" needed a
real resolution, not a deferral — verify Cloudflare's actual per-file limit against
docs, report the real headroom number, and either fix it now or justify deferring
with real numbers. Then deploy, fix CORS (`PAGES_ORIGIN`), and verify end-to-end.

**Completed:**
- [x] Confirmed Cloudflare Pages' file size limit from actual docs (WebFetch against
      `developers.cloudflare.com/pages/platform/limits/`, not assumed): 25 MiB per
      asset, uniform across all plan tiers.
- [x] Measured the real WASM file: 23,567,050 bytes = **22.47 MiB against the 25 MiB
      limit — 2.52 MiB / 10.1% headroom.** Not "safely under" as previously stated.
- [x] Investigated shrinking it: onnxruntime-web ships four WASM variants
      (13/14/23/25 MiB). Traced why we get the 23MB one — `@huggingface/transformers`'s
      browser entry imports `onnxruntime-web/webgpu`, whose published bundle
      hardcodes the asyncify variant (needed for async interop between the WebGPU
      backend and WASM ops in a shared bundle), not a runtime-selectable choice.
      Decided **against** forcing a smaller variant: real risk of silently breaking
      WebGPU support on some browsers, can't verify safely without cross-browser
      testing this sandbox can't do. Documented as deliberately deferred, not
      neglected — see TODO.md Backlog.
- [x] Verified (bonus finding) that onnxruntime-web gracefully degrades to
      single-threaded execution when `crossOriginIsolated` is false — Cloudflare
      Pages doesn't set COOP/COEP headers by default, so the threaded WASM variant
      still works post-deploy, just without threading. Not a blocker.
- [x] Built `scripts/check-bundle-size.mjs`: fails `npm run build` (exit 1, clear
      message) if any `dist/` asset exceeds 24 MiB — 1 MiB safety margin before the
      real 25 MiB cap. Verified both directions: passes today, and correctly fails
      when tested with a dummy 25 MiB file (removed after testing). Wired into the
      `build` npm script.
- [x] `npx wrangler pages deploy dist --project-name=pocketrag` — hit a delegation
      attempt to a newer unified "Workers with static assets" model (no
      `wrangler.jsonc` for that model existed, so it failed cleanly); wrangler itself
      suggested `--force` to use the classic direct Pages path, which worked. Then
      discovered the Pages project didn't exist yet (`wrangler pages project create
      pocketrag --production-branch=main` — non-interactive, no blocker) and that a
      branch mismatch (git branch `master` vs. configured production branch `main`)
      caused the first deploy to land only as a Preview; fixed by redeploying with
      `--branch=main` explicitly, confirmed via `wrangler pages deployment list` that
      the second deploy correctly landed as Production.
- [x] Live at `https://pocketrag.pages.dev`.
- [x] Updated `worker/wrangler.jsonc`'s `PAGES_ORIGIN` to the real Pages URL, ran
      `wrangler types`, `tsc --noEmit`, `vitest run` (40/40 pass), then
      `wrangler deploy` — clean, no interactive prompt this time (subdomain already
      registered).
- [x] **Correction to an earlier finding:** re-tested `pocketrag-answer.abhiram-dev.workers.dev`
      directly via curl and it now connects fine (HTTP 404 on root, as expected —
      real connectivity, not a block). The "sandbox can't reach `*.workers.dev`"
      conclusion from earlier this session was **DNS propagation delay for a
      brand-new subdomain**, not a persistent egress restriction. Caught this by
      re-checking rather than assuming the earlier finding still held — same
      diligence habit as checking `wrangler deployments list` earlier in Session 4.
- [x] Given real connectivity, did genuine **live production verification** instead
      of local `wrangler dev` substitution: curled the live Worker directly first
      (real Gemini answer, correct CORS header for `https://pocketrag.pages.dev`,
      honest "not enough information" response to a deliberately sparse single-chunk
      test — good sign the grounded-QA prompt isn't overreaching), then a full
      Playwright run against `https://pocketrag.pages.dev` itself: real PDF upload,
      real question, real Gemini-composed answer with correct page citation, zero
      console errors. Screenshot inspected. Playwright installed then removed again.
- [x] Full frontend suite (37 tests), typecheck, lint, build (with the new guard)
      all pass clean.

**Problems encountered (all resolved same session, listed for future reference):**
- `wrangler pages deploy`'s auto-delegation to the newer Workers-assets model failed
  on first run — expected/documented behavior per wrangler's own error message, not
  a real blocker; `--force` was the tool-suggested fix, not a guess.
- Pages project didn't pre-exist; needed explicit `wrangler pages project create`.
- Setting `--production-branch=main` at project creation didn't match this repo's
  actual `master` branch, causing the first deploy to silently land as a Preview
  rather than Production — caught by checking `wrangler pages deployment list`
  rather than assuming the deploy succeeded as intended just because the command
  exited 0. Fixed with `--branch=main` on redeploy.

**Left incomplete:** nothing from this session's scope. MVP is feature-complete and
fully deployed end-to-end, verified live.

**Next session should start with:** no queued task — ask the user what's next
(styling pass, multi-document UI, restore-on-reload UI, or the deferred WASM-variant
work are the candidates currently sitting in TODO.md's Backlog).

---

### Session 6 — 2026-08-01
**Goal:** Milestone 6 — multi-document + bulk upload. Shipped across five commits;
this session's work was **Commit 5**: the multi-document ranking/scoping tests, a real
real-browser end-to-end verification of the whole milestone, and this doc wrap-up.

**Milestone 6 commits 1-4 (landed before this session's Commit 5):**
- `6168505` (1/5) — refactored `documentStore` from a single-document shape to a
  per-document `DocEntry[]` + `selectedId`.
- `9944005` (2/5) — `DocumentList.tsx` (row-per-document list/picker with selection).
- `7bd506a` (3/5) — document-scoped citations via **Worker-owned `Doc N` labels**
  (`worker/src/labels.ts`, `assignDocLabels()`); prompt + grounding moved to
  `(Doc N, page M)` pairs; client renders a `Doc N = fileName` legend.
- `79f918f` (4/5) — bulk drag-and-drop (sequential embed queue, one bad file can't
  block the rest), retrieval scope toggle (this document / all documents via
  `getAllChunks()`), restore-on-reload (`getAllDocuments()` → merge-by-id into the
  store on load), and `navigator.storage.persist()` on first save.

**Completed this session (Commit 5):**
- [x] `worker/src/labels.test.ts` — `assignDocLabels()`: 1-based first-appearance
      ordering, one shared label for repeated chunks of the same doc (interleaved),
      single-doc, empty input.
- [x] `src/lib/db.test.ts` — two new tests: `getAllChunks()` pools chunks across every
      document (asserting exact per-document counts, so a duplicate/leaked chunk fails);
      and **the explicit multi-document no-leak test** — a document-scoped query never
      surfaces another document's chunk *even when that other document holds the
      globally-closest match*, while "all documents" scope correctly returns that closest
      chunk. (Ties `getChunksForDocument`/`getAllChunks` + `rankChunks` together.)
- [x] `src/lib/db.getall.test.ts` (new, isolated file) — `getAllDocuments()` /
      `getAllChunks()` with **exact** counts: two saved docs round-trip to exactly those
      two records and all their chunks (embeddings/pages intact), and an empty DB returns
      `[]` for both. Isolated from `db.test.ts` because that file's shared fake-indexeddb
      accumulates docs across tests, which would break exact-count assertions.
- [x] `src/store/documentStore.test.ts` (new) — `restoreDocuments` merge: adds to an
      empty list, appends only not-already-present ids (idempotent under StrictMode
      double-invoke), and keeps a live in-memory doc over a restored one with the same id.
- [x] Frontend: 44 tests (was 37, +7), `tsc -b --noEmit` clean, `oxlint` clean,
      `npm run build` clean (bundle-size guard passes). Worker: 46 tests, `tsc --noEmit`
      clean.
- [x] **Real-browser E2E** (Playwright installed then removed again; two hand-generated
      test PDFs — `biology.pdf`, `cooking.pdf`, 2 pages each, distinct topics — verified
      text-extractable via pdf.js first). Drove `wrangler dev` + Vite dev + real Gemini:
      - Batch-dropped both PDFs at once → both reached `ready` (2 chunks each).
      - **Reloaded** → both documents restored from IndexedDB with no re-drop.
      - Selected **biology.pdf**, set scope to **All documents**, asked a **cooking**
        question ("What gives bread its chewy texture?").
      - Real Gemini answer: **"Gluten gives bread its chewy texture (Doc 1, page 1)."**
        Legend: **"Doc 1 = cooking.pdf · Doc 2 = biology.pdf"**. Top sources:
        cooking.pdf p1 (0.485), cooking.pdf p2 (0.267), biology.pdf p2 (0.105). Zero
        console errors. Screenshot inspected. This is the milestone's headline proof:
        cross-document retrieval answers from cooking.pdf while biology.pdf is selected,
        with correct Worker-owned Doc-N→filename attribution.
- [x] Doc wrap-up: this AGENTS entry; TODO.md (Milestone 6 checked off + Current Sprint
      advanced); ARCHITECTURE.md (restore-on-reload + scope-toggle decisions, Key Files
      for the new/refactored files, and cleaned up three Session-5 debt items that were
      resolved then but never updated: Worker public URL, `PAGES_ORIGIN`, `*.workers.dev`
      reachability).

**Decisions made:**
- **Direct-curl sanity check before the browser run.** Verified the live Gemini path
  through `wrangler dev` with a single cooking chunk (real answer + correct `(Doc 1,
  page 1)` citation + `groundingWarning:false`) before spending time driving a browser —
  same "cheap check first" habit as prior sessions.
- **Hand-wrote a minimal PDF generator** (`scratchpad/makepdf.mjs`) rather than adding a
  PDF library — no `pdfkit`/`pdf-lib` was installed, and a ~40-line generator emitting
  valid text streams + a correct xref table was enough for pdf.js extraction. Temporary,
  scratchpad-only, not a dependency.

**Problems encountered (all resolved this session):**
- First E2E run "failed" at 30s — a bug **in my test script, not the app**:
  Playwright's `waitForFunction(fn, arg, options)` takes the polling arg second and
  options third, so my `{ timeout: 240_000 }` was silently swallowed as the arg and the
  wait used the 30s default. Passed `null` as arg and moved options to the third slot.
- Second run passed the flow but screenshotted mid-generation and read the wrong element:
  the **selected document row shares `.bg-blue-50`** with the answer box. Retargeted the
  answer assertions to `.border-blue-200` (unique to the answer box) — then the real
  composed answer + legend were captured. The app was correct throughout; both were
  harness-selector mistakes.

**Left incomplete:** nothing from Milestone 6's scope. Commit 5 is staged and awaiting
the user's go-ahead to commit (per this project's standing git rule).

**Next session should start with:** no queued task — ask the user. Milestone 7 (BYOK)
is next in the TODO roadmap; a styling/UX pass and the deferred WASM-variant work are
the other standing candidates.

---

### Session 7 — 2026-08-08
**Goal:** Ship the "delete a persisted document" scope deferred out of Milestone 6
(TODO.md Backlog) — the Commit-4 error-row ✕ only ever cleared an unsaved in-memory
notice; nothing could remove a document actually saved to IndexedDB.

**Completed:**
- [x] `src/lib/db.ts` — `deleteDocument(documentId)`: single atomic readwrite
      transaction over `documents` + `chunks`, using the existing `documentId` index
      to find every chunk key to delete alongside the document record.
- [x] `src/lib/queryScope.ts` (new) — `canRunQuery(documents, selectedId, scope)`:
      pure readiness check extracted from `QueryPanel`'s inline `canQuery` computation,
      so scope/selection logic is unit-testable without adding a DOM-testing library.
- [x] `src/components/DocumentList.tsx` — delete action on `ready` (persisted) rows
      only: click "Delete" swaps that row's action area to an inline two-step confirm
      ("Delete permanently?" + Delete/Cancel, styled destructive) rather than
      `window.confirm()`. Confirm calls `deleteDocument()` first, then `removeDocument()`
      only on success; on failure the row stays with a brief inline error, no crash.
      In-flight (`queued`/`embedding`/etc.) rows get no action; error rows keep the
      existing single-click ✕ dismiss unchanged.
- [x] `src/components/QueryPanel.tsx` — inline `canQuery` computation replaced with
      `canRunQuery()`; no other logic changed.
- [x] Tests: `db.test.ts` `deleteDocument` round-trip (deletes one of two saved docs,
      confirms `getAllDocuments()` excludes it, `getChunksForDocument` on the deleted
      id returns `[]`, sibling doc's record + chunks intact); `documentStore.test.ts`
      two new `removeDocument` cases (clears `selectedId` when it matches the removed
      id, leaves it untouched otherwise — this behavior already existed, now directly
      covered); `queryScope.test.ts` (new) — 5 cases covering empty-docs, "all" scope
      with any ready doc, "document" scope with no/non-ready/ready selection.
- [x] Frontend: 52 tests (was 44, +8), `tsc -b --noEmit` clean, `oxlint` clean,
      `npm run build` clean (bundle-size guard passes). Worker untouched — no files
      under `worker/` changed, so its own test suite wasn't re-run.
- [x] **Real-browser E2E** (Playwright installed then removed again, same pattern as
      Session 6; two hand-generated 2-page test PDFs regenerated with a minimal PDF
      writer since Session 6's `scratchpad/` was already cleaned up — verified
      text-extractable via pdf.js before driving a browser). Drove `wrangler dev` +
      Vite dev:
      - Batch-dropped two PDFs → both reached `ready` (2 chunks each).
      - Clicked Delete on one → confirm prompt appeared → confirmed → its row
        disappeared, the other document's row was unaffected.
      - **Reloaded** → only the surviving document restored from IndexedDB; the
        deleted one did not reappear.
      - Zero console errors throughout. Screenshots inspected at each step.
- [x] Doc wrap-up: this AGENTS entry; TODO.md (Backlog item resolved, Current Sprint
      advanced, Completed entry added); ARCHITECTURE.md (Key Files rows for
      `deleteDocument`, `queryScope.ts`, and the updated `DocumentList.tsx` behavior).

**Decisions made:**
- Deletion confirm is inline in the row, not `window.confirm()` — matches the
  project's existing UI style (Tailwind-only, no native dialogs) and can be styled
  destructive (red) the way a native confirm can't.
- `canRunQuery()` takes `documents`/`selectedId`/`scope` as plain arguments rather than
  reading the Zustand store directly, so it stays a pure function testable with plain
  fixtures — no store mocking, no DOM.

**Problems encountered (all resolved this session):**
- First E2E attempt timed out at 240s with both documents stuck showing progress
  states that, per a diagnostic run, actually did reach `ready` within ~10s. Root
  cause: Vite's dependency pre-bundling triggered a mid-test "optimized dependencies
  changed, reloading" full page reload right after the file drop (first cold run only,
  from a fresh `npm install`), which wiped the in-progress client-side upload state
  before it could reach `ready`. Not an app bug — a warm-vs-cold dev-server artifact.
  Running the same test again once Vite's deps were already warm passed cleanly.

**Left incomplete:** nothing from this scope. This work is committed to `master` but
**not deployed** — Cloudflare Pages/Worker still serve the pre-delete-document build
until the user asks for a deploy.

**Next session should start with:** no queued task — ask the user. Deploying this
session's work, Milestone 7 (BYOK), a styling/UX pass, and the deferred WASM-variant
work are the standing candidates.

---

### Session 8 — 2026-08-09
**Goal:** Milestone 7a — BYOK, Gemini-only: prove the full trust model (key entry,
strictly in-memory/one-request-only handling, live model-list fetch, real answer call
with a user-supplied key) before extending to the other 4 providers in 7b. Staged
deliberately as its own reviewable unit given the trust surface involved — plan was
written and approved before any code.

**Completed:**
- [x] `worker/src/validate.ts` — `validateAnswerRequest` extended with optional
      `keySource: 'shared' | 'own'` (defaults to `'shared'` when absent — see Decisions
      below), `apiKey`/`provider`/`model` required and validated only when `keySource`
      is `'own'`. New `MAX_API_KEY_LENGTH` (200) and `MAX_MODEL_LENGTH` (128) caps,
      reject-not-truncate, same pattern as the existing `MAX_DOCUMENT_ID_LENGTH`. New
      `validateModelsRequest` + `SUPPORTED_PROVIDERS` allowlist (`['gemini']` for now).
- [x] `worker/src/rateLimit.ts` — `checkRateLimit` gained a `bucket` parameter (KV key
      is now `ratelimit:{bucket}:{ip}:{day}`); new `BYOK_DAILY_LIMIT` (500, an abuse
      guard on our own Worker, not quota protection — BYOK never touches our Gemini
      quota). Shared and BYOK requests from the same IP now track independent counters.
- [x] `worker/src/gemini.ts` moved to `worker/src/providers/gemini.ts` (directory
      convention for 7b's remaining providers). `callGemini` switched from a `?key=`
      URL query param to the `x-goog-api-key` header for both the shared and BYOK
      paths — URLs are far more likely to end up in some logging layer than headers
      are. Added `listGeminiModels()` (filters to `generateContent`-capable models,
      strips the `models/` name prefix).
- [x] `worker/src/index.ts` — split into `handleAnswer`/`handleModels`; new `POST
      /models` endpoint; BYOK vs shared bucket selection on both endpoints.
- [x] Frontend: `src/lib/answerRequest.ts` gained a `KeyConfig` discriminated union
      (`{keySource:'shared'}` | `{keySource:'own', apiKey, provider, model}`) threaded
      through `attemptAnswer`/`fetchAnswerFromWorker`. New `src/lib/models.ts`
      (`fetchModelsFromWorker`). New `src/components/ByokPanel.tsx` — toggle, key
      input, "Fetch models" button, model `<select>`; all state local to the component
      (not Zustand, not IndexedDB) so the key can't be picked up by a devtools/logging
      integration attached to shared state later, and disappears on reload by
      construction. Emits `KeyConfig | null` (`null` = BYOK selected but incomplete —
      never silently falls back to the shared key mid-setup). `QueryPanel` takes
      `keyConfig` as a prop and gates submission on it. `.env.development`/
      `.env.production` renamed `VITE_ANSWER_API_URL` → `VITE_API_BASE_URL` (derives
      both `/answer` and `/models` from one base).
- [x] Tests: worker 79 (was 46, +33) — new BYOK validation cases, the rate-limit
      bucket split, `providers/gemini.test.ts` (moved + `listGeminiModels` cases), and
      **two separate key-leak tests** per the user's explicit ask: `validateAnswerRequest`'s
      own rejection error strings never contain a raw oversized/malformed key, and
      `callGemini`/`listGeminiModels`'s thrown errors never contain the key either —
      deliberately treated as two different code paths since each constructs its own
      error text. Frontend 53 (was 52, +1: `attemptAnswer` passes `KeyConfig` through
      to `fetchAnswer` unchanged). No `models.test.ts` — matches the existing precedent
      that `fetchAnswerFromWorker`'s thin fetch-wrapper has no dedicated unit test
      either, verified live instead. `tsc`/`oxlint`/`build` clean both sides.
- [x] **Local browser E2E** (Playwright installed then removed again, `wrangler dev` +
      Vite dev, real Gemini): dropped a real PDF, toggled BYOK, entered a real key,
      **live-fetched 42 real Gemini models**, selected one, asked a question, got a
      real grounded answer. First run picked a model (`gemini-2.0-flash-lite`) that
      returned a genuine 429 quota-exhausted error from Gemini for that specific
      model/project — not a bug, confirmed by reading the real Gemini error body —
      switched the test to prefer `gemini-3.5-flash-lite` (the model the shared path
      already uses successfully) and it passed cleanly.
- [x] **Deployed the Worker to production** (backward compatible via `keySource`
      defaulting to `'shared'` — verified the *old* request shape, with no `keySource`
      field at all, still returns 200 against the *new* Worker, so the not-yet-deployed
      Pages frontend wasn't broken in the gap). Sent real BYOK `/models` and `/answer`
      requests directly against the deployed Worker, both 200. Ran `wrangler tail`
      during the live BYOK `/answer` call and grepped the captured request-lifecycle
      JSON for the literal key value: **confirmed clean** — not in headers, not in
      `logs`, not in `exceptions`. (Also incidentally confirmed Cloudflare's default
      Workers Logs capture incoming request headers/metadata but not outbound
      `fetch()` subrequest details — resolves the "Cloudflare's own logging is outside
      code-level proof" flag from the plan, at least for the default observability
      config this project uses.)
- [x] Committed (`f4e2806`) after the user reviewed full file contents for
      `providers/gemini.ts`, `ByokPanel.tsx`, and `models.ts` directly (not diffs —
      these were new files).
- [x] **Deployed Pages** (`npm run build` + `wrangler pages deploy dist
      --project-name=pocketrag --branch=main`, same process as every prior deploy).
      Confirmed via `wrangler pages deployment list` (Production, branch `main`,
      source `f4e2806`) and bundle-hash match between the live site and the local
      build (`index-D-aAcegy.js` both places — first hash-comparison attempt used a
      grep pattern that didn't handle a hyphen inside the hash itself and produced a
      false mismatch; re-checked with a corrected pattern before concluding anything).
- [x] **Live production BYOK E2E** against `pocketrag.pages.dev` itself (not local dev,
      not direct Worker calls): real visitor flow — drop PDF, toggle "Use your own
      Gemini API key," enter a real key, fetch the live model list, select a model, get
      a real grounded answer citing the dropped document. Zero console errors.
      Screenshots inspected.

**Decisions made (deviations from the approved plan, flagged as such):**
- **`keySource` defaults to `'shared'` instead of being strictly required.** The
  approved plan called it "new, required." Once at the deploy step it became clear
  that "required" would mean the *already-live* Pages frontend (which never sends
  `keySource`) gets 400-rejected the instant the new Worker deploys — breaking the
  shared-key flow for real users in the gap between the Worker and Pages deploys.
  Defaulting the missing field to `'shared'` makes the Worker deployable independently
  of the frontend, which is exactly what happened this session (Worker went out first,
  Pages followed later in the same session but could have been any time after).
- Rate-limit message reworded from "today's question limit" to "today's request
  limit" — one shared constant now serves both `/answer` and `/models`, and "question"
  didn't fit a model-list request.
- Worker-proxied (not direct-browser-to-Gemini) for both `/answer` and `/models`, per
  the plan's own recommendation — sidesteps provider-by-provider CORS-support
  uncertainty ahead of 7b's four remaining providers.

**Left incomplete:** nothing from 7a's scope. 7b (remaining 4 providers) and 7c (UI
polish/error states) are still ahead, per the original staged plan.

**Next session should start with:** no queued task — ask the user. Milestone 7b
(OpenAI/Anthropic/Grok/OpenRouter, reusing 7a's `providers/` pattern) is the natural
next step in the BYOK roadmap; a styling/UX pass and the deferred WASM-variant work
remain the other standing candidates.

---

<!-- Copy the block above for each new session -->
