# AGENTS.md — Session Handoff Log

This file is updated at the END of every Claude Code session.
Claude reads this at the START of every new session to understand what happened before.

---

## Project State
**Last updated:** 2026-08-11
**Current branch:** master (through `305ef4a` — Grok/OpenRouter Experimental BYOK
providers + uniform error sanitization, deployed and pushed — see below)
**Remote:** `github.com/Abhiram-0910/pocketrag` (private) — pushed and up to date
(confirmed `origin/master` == `305ef4a` as of this push, 2026-08-11).
**Overall status:** MVP **+ Milestone 6 (multi-document)** + **Milestone 7a+7b (BYOK,
all 5 providers)** feature-complete and **fully deployed in production**. Frontend:
`https://pocketrag.pages.dev` (Cloudflare Pages). API:
`https://pocketrag-answer.abhiram-dev.workers.dev` (Cloudflare Worker). Supports a
multi-document library, bulk drag-and-drop, a this-document/all-documents retrieval
scope toggle with cross-document ranking, Worker-owned per-request `Doc N` citation
labels, restore-on-reload from IndexedDB, `navigator.storage.persist()`, deleting a
persisted document, and bring-your-own-key across 5 providers (Gemini, OpenAI,
Anthropic, Grok, OpenRouter — provider picker in the BYOK panel) as an alternative to
the shared/free-tier key. **Gemini and OpenAI are fully proven** (real grounded-answer
E2E verified live). **Anthropic, Grok, and OpenRouter are Experimental** — selectable
with a visible caveat, code-complete and unit-tested, and their *failure* path is
live-verified (real invalid-key 502 + clean structured server-side log, confirmed via
`wrangler tail` for all three), but their *success* path (an actual working answer) is
not yet proven against a real key for any of the three. A uniform log-and-sanitize
path (`logProviderError` in `worker/src/index.ts`) covers all 5 providers: any
provider-call failure logs a structured, key-free entry server-side and returns a calm
generic message to the client instead of raw provider error text. 60s timeout + manual
retry still there as a demo-day safety net.

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

### Session 9 — 2026-08-10
**Goal:** Milestone 7b (first provider) — extend BYOK to OpenAI, reusing 7a's
`worker/src/providers/` pattern and trust model exactly. "Prove one, then extend"
discipline: OpenAI only this session, Anthropic/Grok/OpenRouter deferred to future
sessions. Plan (real OpenAI docs research, not assumed from training data) written
and approved before any code, per this project's standing rule.

**Completed:**
- [x] Verified the real OpenAI API contract before writing code: Chat Completions
      (`POST /v1/chat/completions`, fully supported, not deprecated) chosen over the
      newer Responses API — user's explicit call, since Chat Completions' stateless
      single-request/response shape structurally mirrors `providers/gemini.ts`
      almost 1:1, keeping the diff small versus also absorbing Responses' typed
      `output` array and unused statefulness. Models list (`GET /v1/models` →
      `{ data: [{ id, object, created, owned_by }] }`) confirmed via a working docs
      mirror after `platform.openai.com`'s reference pages 403'd. CORS confirmed
      (was flagged as an assumption in 7a's own plan, not settled before now):
      `api.openai.com` sends no `Access-Control-Allow-Origin`, direct browser calls
      are blocked — validates 7a's Worker-proxy architecture as required, not just
      convenient.
- [x] `worker/src/providers/openai.ts` (+test) — `callOpenAI` / `listOpenAIModels`,
      mirroring `gemini.ts`'s two-function shape. `Authorization: Bearer` header
      (never the URL). Models list returned **unfiltered** — OpenAI's `/v1/models`
      has no capability field like Gemini's `supportedGenerationMethods` to filter
      chat-capable models from embedding/moderation/image ones; a wrong pick
      surfaces as a normal 502 on the next question rather than being hidden by a
      staleness-prone hardcoded prefix allowlist. Deliberate tradeoff, documented in
      code and the approved plan, not an oversight.
- [x] `worker/src/validate.ts` — `SUPPORTED_PROVIDERS` extended to
      `['gemini', 'openai']` (one line; validation logic itself was already
      provider-agnostic). `worker/src/index.ts` — `handleAnswer`/`handleModels` now
      dispatch to `callOpenAI`/`listOpenAIModels` vs `callGemini`/`listGeminiModels`
      based on the validated provider (plain if/switch, no factory — two providers
      doesn't justify one yet).
- [x] `src/components/ByokPanel.tsx` — provider `<select>` (Gemini/OpenAI) added
      above the key input; changing provider clears the fetched model list same as
      changing the key does. `src/lib/answerRequest.ts` / `src/lib/models.ts` —
      provider union widened to `'gemini' | 'openai'`.
- [x] Tests: worker 91 (was 79, +12) — `openai.test.ts` (mirrors `gemini.test.ts`
      exactly, including the two key-leak tests), `validate.test.ts` extended (the
      old "openai is unsupported" rejection fixture flipped to an acceptance case;
      a new `'anthropic'` fixture took over the rejection-coverage role so it wasn't
      lost), `index.test.ts` gained explicit provider-dispatch proof for both
      `/answer` and `/models` (a stale test that asserted `provider: 'openai'` was
      *rejected* also got fixed — it would have silently started asserting the wrong
      thing once openai became supported). Frontend 53 (unchanged — `ByokPanel`
      stays unit-test-free per existing precedent for thin UI-wiring components,
      verified live instead). `tsc`/`oxlint`/`build` clean both sides.
- [x] **Local E2E** (Playwright installed then removed, `wrangler dev` + Vite dev,
      real OpenAI key from a scratch file outside the repo, never printed to the
      transcript — see Decisions): dropped a real PDF, toggled BYOK, selected
      OpenAI, live-fetched 124 real models, picked `gpt-4o-mini`, asked a question,
      got a real grounded answer with correct citation. One harness bug caught and
      fixed along the way: the readiness-check regex was anchored to end-of-string,
      but a ready document row's `<li>` also contains the "Delete" button's text
      after the status text, so the anchor never matched — not an app bug, same
      class of harness-selector mistake as Session 6's `.bg-blue-50` mixup.
- [x] **Deployed the Worker** (backward compatible — `SUPPORTED_PROVIDERS` gaining
      `'openai'` doesn't affect existing `'gemini'` requests). Live BYOK `/models`
      and `/answer` curled directly against the deployed Worker with `provider:
      'openai'`: `/models` 200 immediately; `/answer` 400'd once right after deploy
      (propagation lag across edge PoPs, not a bug — two immediate retries both
      returned clean 200s with real grounded answers) then stayed consistently 200.
      All response bodies checked programmatically for the raw key: absent in every
      case.
- [x] **`wrangler tail` key-leak check — completed via a documented workaround, not
      skipped.** See the new Known Environment Limitation below. The user ran
      `wrangler tail --format json` themselves in a terminal outside this session
      while Claude fired a live BYOK `/answer` request via `curl`; user confirmed
      the captured request-lifecycle JSON was clean across `headers`, `logs`, and
      `exceptions` — same three places checked for Gemini in Session 8.
- [x] **Deployed Pages**, bundle-hash-verified against the live site
      (`index-CJiIaKQt.js` both places). **Live production BYOK E2E** against
      `pocketrag.pages.dev` itself (not local dev): real visitor flow — drop PDF,
      toggle BYOK, select OpenAI, real key, live model fetch, real question, real
      grounded answer citing the dropped document. Zero console errors. Screenshot
      inspected.
- [x] Committed (`152121b`) after the user reviewed the full literal content of
      `providers/openai.ts` and `ByokPanel.tsx` directly (not diffs), same standard
      as 7a. Pushed immediately — user's explicit instruction was not to leave BYOK
      code for a second provider sitting local-only even briefly.

**Decisions made:**
- **API key handoff via an external scratch file, not pasted in chat.** User's
  explicit call: pasting a real key into the conversation leaves a permanent copy in
  session history (including this memory system) for zero benefit, when a file
  outside the repo — Claude reads it at runtime, never echoes it — accomplishes the
  same live test. Verified the scratch path is not merely gitignored but entirely
  outside the repo's working tree (`/tmp/...` vs `/home/abhi/NewProjects/pocketrag`),
  one level stronger than the `worker/.dev.vars` precedent. All curl calls to the
  deployed Worker used the same pattern: a Node subprocess reads the key file and
  builds the request body via process substitution, so the raw value never appears
  in a visible Bash command string either.
- **Driver scripts (Playwright script, PDF generator) live in the repo's own
  `scratchpad/`**, not the external key-only location — Node's ESM module resolution
  for the `playwright` bare specifier walks up from the *script's own directory*
  looking for `node_modules`, which the external `/tmp` path has no path to. Only
  the key file itself needed to stay external; the driver scripts contain no secret
  material and were deleted before this session ends, matching Session 6/7's
  scratchpad-cleanup precedent.

**Known Environment Limitation (new — record for future sessions):**
- **`wrangler tail` cannot connect from this session's Bash execution environment.**
  Confirmed via five separate methods (plain redirect, `--format json`, `--debug`,
  forced line-buffering via `stdbuf`, and a real pty via `script -qc`), including one
  full 60-second wait — it never gets past its initial connecting spinner. This is
  **not** a general network block: plain HTTPS via `curl` to both
  `api.cloudflare.com` and the deployed Worker's own `*.workers.dev` URL succeed
  instantly from the same environment, and `wrangler dev`/`wrangler deploy`/
  `wrangler pages deploy` all work normally too. The restriction is specific to
  whatever connection `wrangler tail` needs for its log-streaming relay (almost
  certainly WebSocket-based) — distinct from the DNS-propagation-for-a-new-subdomain
  issue documented in Session 4/5, which was transient and resolved itself.
  **Workaround, used this session and expected to work again:** run
  `wrangler tail` in a terminal the user controls directly, outside this session's
  Bash tool, while Claude fires the live request via `curl` (which does work from
  here) at the user's signal. The user then reads their own terminal's tail output
  and reports back. Do not re-attempt `wrangler tail` from within this session's
  Bash tool expecting a different result — the limitation reproduced consistently.

**Problems encountered (all resolved this session):**
- `platform.openai.com`'s API reference pages returned HTTP 403 to WebFetch — worked
  around via a working docs mirror (`developers.openai.com`) and targeted web search
  for the exact request/response shapes, rather than falling back to pre-trained
  knowledge of an external API contract (this project's standing rule).
- The first live BYOK `/answer` call against the freshly-deployed Worker 400'd with
  "provider must be one of: gemini." while the immediately-preceding `/models` call
  (same code path's `SUPPORTED_PROVIDERS` check) had just returned 200 — looked like
  a real bug at first. Two retries both returned clean 200s; concluded edge
  propagation lag for a deploy that had completed seconds earlier, not a code issue.
  Confirmed stable across three total attempts before moving on.
- `wrangler tail` hanging — see Known Environment Limitation above. Diagnosed
  thoroughly (five methods) before concluding it was a real, reproducible limitation
  rather than a transient fluke, then escalated to the user with a specific
  workaround rather than silently skipping the check.

**Left incomplete:** nothing from 7b's OpenAI scope. Milestone 7b's remaining three
providers (Anthropic, Grok, OpenRouter) and 7c (UI polish/error states) are still
ahead, per the original 7-milestone staged plan.

**Next session should start with:** no queued task — ask the user. Milestone 7b
continuing with the next provider (Anthropic is the natural pick — reuses the same
now-twice-proven `providers/` pattern), a styling/UX pass, and the deferred
WASM-variant work remain the other standing candidates.

---

### Session 10 — 2026-08-10
**Goal:** Milestone 7b (second provider) — extend BYOK to Anthropic (Claude), reusing
the now-twice-proven `worker/src/providers/` pattern. Explicit constraint going in
(user-flagged): PocketRAG holds no Anthropic key of its own — Anthropic is BYOK-only,
no shared-tier path exists or will exist for it. Code/unit tests need no real key
(mocked fetch, same as `gemini.test.ts`/`openai.test.ts`); live E2E verification does,
and no key was available this session. Plan (real Anthropic docs research, not assumed
from training data) written and approved before any code, staged explicitly as
**Phase A (no key needed) → Phase B (needs a real key, blocked)**.

**API contract verified against current docs before writing code:**
- Messages API: `POST https://api.anthropic.com/v1/messages`, headers
  `anthropic-version: 2023-06-01` + `x-api-key`, body requires `max_tokens` (genuinely
  new — Gemini/OpenAI calls send no cap and rely on a provider-side default). Response
  text sits in a `content` array of typed blocks (`content[].type === 'text'`), not a
  flat path — read via `.find(block => block.type === 'text')` rather than blindly
  indexing `content[0]`, since a thinking-enabled model could emit a non-text block first.
- Models list: `GET /v1/models` confirmed to exist (not every provider has one — this
  needed checking, not assuming), but is **paginated** (default page size 20, unlike
  Gemini/OpenAI's single-shot lists) — sidestepped with `?limit=1000` on one GET rather
  than building a pagination loop for a >1000-models scenario that isn't real. Anthropic
  also returns a real `display_name` field per model (Gemini has one, OpenAI doesn't).
- CORS: confirmed the `anthropic-dangerous-direct-browser-access` header flagged during
  7a's planning is real and does what it sounds like — an opt-in that lets a *browser*
  call Anthropic directly, named "dangerous" because a key embedded in client JS is
  visible to anyone on that page. **Confirmed irrelevant to this project's architecture**:
  the Worker calls Anthropic server-to-server, no browser involved in that hop, so the
  header is simply not needed. Validates the existing Worker-proxy decision rather than
  challenging it.

**Completed (Phase A — no key needed, fully self-contained):**
- [x] `worker/src/providers/anthropic.ts` (+ `anthropic.test.ts`, 10 tests) —
      `callAnthropic`/`listAnthropicModels`, structured like `openai.ts`. New
      `ANTHROPIC_API_VERSION`/`ANTHROPIC_MAX_OUTPUT_TOKENS` (2048, bumped up from an
      initial 1024 proposal at the user's explicit call — a truncated answer/citation
      is a new failure mode the other two providers don't have, but it's the BYOK
      user's own cost to bear, not the shared tier's) named constants. Same
      injectable-`fetchImpl`, throw-with-status-and-body, never-leak-the-key discipline
      as `gemini.ts`/`openai.ts`, including the two separate key-leak tests.
- [x] `worker/src/validate.ts` — `SUPPORTED_PROVIDERS` extended to `['gemini', 'openai',
      'anthropic']` (one line; validation logic already provider-agnostic). No other
      validate.ts change needed — the BYOK-only constraint (no shared/free path for
      Anthropic) falls out for free from `index.ts`'s existing shared-branch hardcoding
      `provider = 'gemini'`, not a new guard.
- [x] `worker/src/index.ts` — dispatch in `handleAnswer`/`handleModels` switched from
      the prior binary ternary to a `switch` (3 providers now, still no
      factory/abstraction — readability call, approved).
- [x] `worker/src/validate.test.ts` / `index.test.ts` — the old "anthropic is
      unsupported" rejection fixtures (added in Session 9 to cover the not-yet-supported
      case) flipped to acceptance cases, same maneuver Session 9 did for openai;
      rejection-coverage role handed to a new `'grok'` placeholder fixture so it wasn't
      lost; explicit anthropic-dispatch tests added for both `/answer` and `/models`.
- [x] Worker: 105 tests (was 91, +14). Frontend: unchanged at first (53, `ByokPanel`
      still test-free by precedent) — see below for the later gating change.
- [x] `tsc --noEmit` clean both sides, `oxlint` clean, `npm run build` clean (bundle
      guard passes). Full literal content of `anthropic.ts`/`anthropic.test.ts` shown
      to and reviewed by the user directly in chat (not just via a file read), matching
      the same full-content review standard as Gemini/OpenAI.

**Decision — gate Anthropic out of the UI instead of shipping it live (user-directed,
after Phase A):** Phase B (live E2E, Worker/Pages deploy, `wrangler tail` check) never
ran this session — no real Anthropic key was available. Rather than leave the milestone
blocked indefinitely or ship an unverified provider at the same trust level as
Gemini/OpenAI, added a `VERIFIED_PROVIDERS: Provider[] = ['gemini', 'openai']` allowlist
in `ByokPanel.tsx`. Any `PROVIDER_LABELS` entry not in `VERIFIED_PROVIDERS` renders as a
`disabled` `<option>` with " (coming soon)" appended to its label — disabled options
can't be reached via mouse or keyboard, so this fully blocks a real user from selecting
Claude through the normal UI. The Worker-side code stays exactly as built and deployed
(nothing hidden or half-built there) — flipping `VERIFIED_PROVIDERS` to include
`'anthropic'` is the entire remaining step once a real key allows Phase B to run.
**This is now the standard pattern** (recorded in TODO.md's Ideas/Notes) for any future
BYOK provider whose Worker code ships before a test key is available — Grok/OpenRouter
should use the same gate if they land key-less too.

**Completed (the gating change itself):**
- [x] `src/components/ByokPanel.tsx` — `VERIFIED_PROVIDERS` constant added; the
      provider `<select>`'s `.map()` now renders `disabled={!verified}` and a
      "(coming soon)" suffix for any ungated-but-unverified provider.
- [x] Frontend: 53 tests (unchanged — no new test, `ByokPanel` stays test-free by
      existing precedent), `tsc -b --noEmit` clean, `oxlint` clean, `npm run build`
      clean. Worker unaffected (untouched by this specific change; re-ran its suite
      anyway to confirm no regression — still 105/105).
- [x] TODO.md updated: Current Sprint section, Milestone 7b checklist item changed
      from a plain unchecked `[ ]` to an explicit `[~]` "code complete, pending live
      verification" entry (not marked done the way OpenAI was), new Ideas/Notes entry
      documenting `VERIFIED_PROVIDERS` as the standard pattern going forward.

**Left incomplete:** Anthropic's live verification (Phase B) — blocked on a real
Anthropic key, not on anything code-side. Grok/OpenRouter (Milestone 7b's remaining
providers) and 7c (UI polish/error states) are still ahead. **This session's changes are
not yet committed** — awaiting the user's go-ahead per this project's standing git rule;
once committed this is expected to deploy normally (Worker + Pages) since the gating
change itself is small and low-risk (a UI-only gate, touches no key-handling logic) and
doesn't need the full live-E2E bar a working provider would.

**Next session should start with:** no queued task unless the user supplies an
Anthropic key (unblocks Phase B immediately) — otherwise ask the user. Grok/OpenRouter
(same `VERIFIED_PROVIDERS`-gated approach if no key is available for those either), a
styling/UX pass, and the deferred WASM-variant work remain the other standing
candidates.

---

### Session 11 — 2026-08-11
**Goal:** Milestone 7b — add Grok (xAI) and OpenRouter as the remaining two BYOK
providers, both key-less like Anthropic was, but under a **new strategy** the user
explicitly chose over Session 10's gate: ship them **selectable** in the UI as
"Experimental" rather than disabled, since a calm server-logged failure is an
acceptable risk for real users to hit — and flip Anthropic to the same treatment for
consistency, since it's in the identical technical state (built, mock-tested, never
tried against a real key). This required designing and building a new error-capture
path first: log full diagnostic detail server-side (key-free), show the user only a
generic message. Plan (real xAI/OpenRouter docs research) written and approved before
any code, per this project's standing rule.

**API contracts verified against current docs before writing code:**
- xAI (Grok): `POST https://api.x.ai/v1/chat/completions`, `Authorization: Bearer`,
  OpenAI-compatible request/response shape (`choices[].message.content`), no required
  `max_tokens`. Models list at `GET /v1/language-models` (**not** `/v1/models`) wrapped
  under a `models` key (**not** `data`) — the one genuinely new shape difference from
  every prior provider; no display-name field, same as OpenAI (falls back to id).
- OpenRouter: `POST https://openrouter.ai/api/v1/chat/completions`, same
  OpenAI-compatible shape, plus two **optional** identifying headers (`HTTP-Referer`,
  `X-Title`) — the first provider on this roadmap needing anything beyond an auth
  header on the chat call. Models list at `GET /v1/models` → `data[]` (confirmed via a
  direct fetch of the real endpoint), each entry has a real `name` field.
- CORS: no documented policy found for either provider (unlike Anthropic's explicit
  dangerous-browser-access header) — noted as a real research gap rather than assumed,
  but moot either way since Worker-proxy stays the architecture regardless.

**Completed — provider code:**
- [x] `worker/src/providers/grok.ts` + `grok.test.ts` (10 tests), `openrouter.ts` +
      `openrouter.test.ts` (10 tests) — same injectable-`fetchImpl`,
      throw-with-status-and-body, two-key-leak-test discipline as every prior provider.
- [x] `worker/src/validate.ts` — `SUPPORTED_PROVIDERS` now `['gemini', 'openai',
      'anthropic', 'grok', 'openrouter']`. `worker/src/index.ts` — `switch` dispatch in
      both `handleAnswer`/`handleModels` extended with `grok`/`openrouter` cases.

**Completed — the new error-capture/sanitization path (applied to all 5 providers,
not just the 3 experimental ones — user's explicit call after I flagged this as an
open decision, since it changes Gemini/OpenAI's existing behavior too):**
- [x] `logProviderError(provider, model, err)` in `index.ts` — on any provider-call
      failure, logs a structured JSON entry via `console.error` (`provider`, `model`,
      `status` extracted by regex from the existing `"<Provider> API error <status>:
      <body>"` shape every provider file already throws, `message`). No new error-class
      hierarchy across provider files — one line of regex against an already-consistent
      string shape. Lands in Cloudflare Workers Logs automatically, no new infra.
- [x] Client-facing response changed from raw `err.message` to a fixed generic message
      per endpoint: `"This provider is temporarily unavailable. Please try again
      later."` (`/answer`) / `"This provider's model list is temporarily unavailable.
      Please try again later."` (`/models`). Checked first that no existing test
      asserted on the specific *content* of the old raw-error client response (only
      status codes) — safe to change without breaking anything.
- [x] Frontend needed **zero code change** for the sanitization to reach the user —
      checked `answerRequest.ts`/`models.ts` first and confirmed both already just
      forward whatever `error` string the Worker sends (`throw new Error(data?.error ??
      ...)`), no raw-error parsing existed to remove. `QueryPanel.tsx`'s existing amber
      failure-note display picks up the new generic message automatically.
- [x] Two new dedicated log-safety tests in `index.test.ts` (one for `/answer`, one for
      `/models`), built to the user's explicit refinement: **exercise the real dispatch
      path** (mock the global `fetch`, let the real provider file construct the real
      `"<Provider> API error <status>: <body>"` string) rather than hand-building an
      `Error` object — so the test proves `logProviderError`'s regex-extraction logic
      actually works against production code, not a shortcut that could pass even if
      that logic were broken. Mocked failure bodies are realistic (e.g. `"Incorrect API
      key provided: xai-****...fake9999"`, a masked-key-lookalike a real provider might
      legitimately include) rather than trivial stand-ins. Each test asserts the parsed
      log JSON's `status`/`provider`/`model`/`message` fields are all correct **and**
      that the real distinctive secret passed as the request's `apiKey` never appears
      anywhere in the logged string. Also strengthened the three pre-existing "returns
      502" tests to assert the client response is the sanitized message, not the raw
      provider text.
- [x] Worker: 132 tests (was 105, +27). Frontend: 53 (unchanged).

**Completed — frontend gating strategy change:**
- [x] `src/components/ByokPanel.tsx` — Session 10's `VERIFIED_PROVIDERS`
      disabled-"coming soon" gate **replaced** (not extended) with
      `EXPERIMENTAL_PROVIDERS = ['anthropic', 'grok', 'openrouter']`. All 5 providers
      are now selectable `<option>`s (no `disabled`); the 3 experimental ones get an
      "(Experimental)" label suffix and a visible amber caveat paragraph (reusing the
      existing grounding-warning visual language, not inventing new styling) when
      selected: *"Experimental — this provider hasn't been verified against a live
      account yet. If something goes wrong, you'll see a generic error message."*
      `PROVIDER_LABELS`/`Provider` type widened to all 5; `answerRequest.ts`/`models.ts`
      provider unions widened to match.
- [x] `tsc`/`oxlint`/`build`/`vitest` clean both sides (worker 132/132, frontend
      53/53). Full literal content of `grok.ts`, `openrouter.ts`, `index.ts`, and
      `ByokPanel.tsx` shown to and reviewed by the user directly in chat (pasted as
      literal text, not referenced via a tool call — the user explicitly corrected an
      earlier pattern this session where tool-call markers appeared instead of actual
      file content, and asked that direct-paste be the standing pattern going forward
      for any file requested "in full").

**Deployed and verified:**
- [x] Committed `305ef4a`, pushed. Worker deployed, Pages built and deployed
      (`--branch=main`), confirmed landed as Production via `wrangler pages deployment
      list` (source `305ef4a`). Bundle-hash check against the live site initially
      appeared to mismatch (`index-BLr4Py1t.js` old vs `index-D-4DzaOV.js` new) —
      diagnosed as a stale-edge-cache read on the first plain `curl`, not a real
      deployment problem; a cache-busting query param and the deployment-specific URL
      both immediately showed the correct new hash, and a plain re-check 3s later
      confirmed the production URL had caught up too. Documenting this pattern:
      **don't conclude a deploy failed from one immediate post-deploy hash check** —
      retry with cache-busting or a short wait before treating a mismatch as real.
- [x] **Post-deploy invalid-key exercise, live, all 3 Experimental providers**: fired a
      deliberately-invalid key against the live Worker's `/answer` for Anthropic, Grok,
      and OpenRouter in turn. All three returned a real `502` with the sanitized
      message — confirms the real API rejection path and the sanitization both work
      end-to-end in production, not just against mocks.
- [x] **`wrangler tail` workaround, live, all 3 providers**: user ran `wrangler tail
      --format json` in their own terminal (session Bash still can't connect, per the
      Session 9 Known Environment Limitation); Claude fired the same three requests one
      at a time so each was easy to isolate in the tail output. User confirmed all
      three structured log entries were clean: real per-provider error bodies captured
      correctly (Anthropic 401 `"invalid x-api-key"`, Grok 400 `"Incorrect API key
      provided"`, OpenRouter 401 `"Missing Authentication header"`), status correctly
      regex-extracted in all three despite three different real providers' real error
      text, and the fake key absent from all three entries.

**Important honest caveat, raised by the user and worth preserving verbatim in
substance:** the live `wrangler tail` check proves the log pipeline is clean
end-to-end (regex extraction → JSON serialization → `console.error` → Workers Logs),
but it does **not** prove leak-resistance against a provider that tries to echo the
raw key back in its own error text — none of the three providers did that for an
invalid key, so there was never a value in this specific live check that *could* have
leaked. That harder case (a response body that itself contains something
key-shaped) is what the unit tests' deliberately-crafted fake-secret-in-body scenarios
exist to cover, not this live check. The live check's real contribution is confirming
the exact code path those unit tests exercise is the one actually running in
production — not a broader leak-proof guarantee than that.

**Decisions made:**
- **Uniform sanitize-and-log across all 5 providers, not scoped to just the 3
  experimental ones** — flagged explicitly as an open decision during planning since it
  changes already-shipped Gemini/OpenAI behavior; user approved applying it uniformly.
  Simpler (one code path instead of a provider-conditional branch) and arguably a
  correctness fix for Gemini/OpenAI too, since a raw provider error body was never a
  deliberate UX choice for those two either — it was just what fell out of Session 4's
  original pass-through implementation.
- **`EXPERIMENTAL_PROVIDERS` replaces `VERIFIED_PROVIDERS` as the standing pattern**
  for a key-less provider (see TODO.md's Ideas/Notes) — selectable-with-caveat instead
  of disabled, now that the log-and-sanitize safety net makes a live failure an
  acceptable (and now proven) outcome instead of something that needed to be prevented
  outright.

**Problems encountered (all resolved this session):**
- Bundle-hash mismatch on first post-deploy check — see Deployed section above;
  resolved as a stale-cache read, not a real deploy issue.
- File-content review didn't actually reach the user twice this session (once for
  `anthropic.ts`/`anthropic.test.ts` carried over from Session 10's tail end, once for
  `grok.ts`/`openrouter.ts`/`ByokPanel.tsx` this session) — tool-call markers appeared
  in the transcript instead of literal text. Resolved by pasting file contents directly
  in the reply body rather than relying on a Read tool-call reference; user asked this
  be the standing pattern for any future "show me the full file" request.

**Left incomplete:** Anthropic/Grok/OpenRouter's *success* path (a real answer/model
list through any of the three) — still unverified, blocked on real test keys for each.
Milestone 7c (UI polish/error states) and the rest of the roadmap (8-16) remain ahead.

**Next session should start with:** no queued task — ask the user. Live-verifying any
of the 3 Experimental providers' success path (whenever a real key for that provider
becomes available) is the natural BYOK follow-up; a styling/UX pass and the deferred
WASM-variant work remain the other standing candidates.

---

### Session 12 — 2026-08-11
**Goal:** none queued from Session 11 — session opened with a state-check request
(git log/status, TODO.md, AGENTS.md) rather than new feature work.

**Found while reporting state:** `ebc1670` ("Reword sanitized provider-failure
messages to point users at Gemini/OpenAI") was on `master`/`origin/master` but had no
corresponding AGENTS.md entry and no recorded deploy — Session 11's entry only covers
`305ef4a`. Changed `worker/src/index.ts`'s two sanitized client-facing messages from
the old "temporarily unavailable... try again later" copy (which wrongly implied a
retry would help an Experimental provider) to: `"This provider isn't fully supported
yet. Please try Gemini or OpenAI for now — we're working on it."`
(`/answer`) / equivalent for `/models`. Message-copy only — `logProviderError`, the
log-safety tests, and `EXPERIMENTAL_PROVIDERS` untouched.

**Live re-verified this session, not just trusted from git history:** fired a
deliberately-invalid key against the live Worker's `/answer` for `grok`. Response was
a real `502` with the exact new wording —
`"This provider isn't fully supported yet. Please try Gemini or OpenAI for now — we're
working on it."` — confirming `ebc1670` is both deployed to the live Worker
(`pocketrag-answer.abhiram-dev.workers.dev`) and still active today, not just present
in source.

**Docs updated:** TODO.md's Current Sprint section quoted the old wording verbatim —
corrected to the new copy and cross-referenced to this session.

**Left incomplete:** nothing new. Same standing candidates as Session 11 — live-verify
Anthropic/Grok/OpenRouter's success path once real test keys exist, Milestone 7c (BYOK
UI polish), Milestones 8-16.

**Next session should start with:** no queued task — ask the user.

---

### Session 13 — 2026-08-11
**Goal:** Discord webhook notifications for provider-call failures, sequenced before a
combined Milestone 7c (BYOK UI polish) + general styling/UX pass per the user's
explicit ordering. Full plan (Discord API contract research, design, tests, deploy,
live-verification steps) written via plan mode and approved before any code, per this
project's standing rule.

**API contract researched before coding:** `POST
https://discord.com/api/webhooks/{id}/{token}` — no auth header beyond the URL itself;
payload is `embeds: [...]` (title, color, `fields[]`, `timestamp`); success `204`;
Discord's own rate limits (per-webhook ~30/min, per-channel 5/5s, global 50/s) are
irrelevant given the suppression window below, so no retry/backoff logic was built.

**Built:**
- `worker/src/discord.ts` (new) — `buildDiscordPayload` (pure, embed shape, message
  truncated to 1000 chars to stay under Discord's 1024-char field cap,
  `allowed_mentions: { parse: [] }` defensively), `sendDiscordAlert` (never throws —
  wraps the POST in try/catch, swallows any failure since `logProviderError`'s
  `console.error` already ran and stays the source of truth regardless), `shouldNotify`
  (KV-backed suppression check, reusing `rateLimit.ts`'s existing `KVLike` interface
  rather than redeclaring one).
- `worker/src/index.ts` — `ctx: ExecutionContext` threaded into the top-level `fetch`
  handler and both `handleAnswer`/`handleModels`, required so the Workers runtime
  doesn't tear down the un-awaited Discord POST after the response is sent.
  `logProviderError`'s inline status-extraction regex factored into a shared
  `extractFailureDetails` helper, reused by the new `notifyDiscordOfFailure`. Called
  from both catch blocks (`/answer` and `/models`, all 5 providers via the existing
  `switch` dispatch — no provider-conditional branching, matching Session 11's uniform
  sanitize-and-log decision). Gated on `env.DISCORD_WEBHOOK_URL` being truthy, so the
  whole feature is inert (no KV read, no fetch attempted) until the secret exists —
  safe to deploy before it's set.
- `DISCORD_WEBHOOK_URL` wired as an optional Worker secret, mirroring
  `GEMINI_API_KEY`'s exact existing pattern: placeholder added to `worker/.dev.vars`
  (gitignored) and `worker/.dev.vars.example` (committed), `wrangler types` re-run to
  regenerate `Env` in `worker-configuration.d.ts` (gitignored, never hand-edited), no
  `wrangler.jsonc` change (secrets are deliberately never declared there).

**Suppression key design — revised mid-review, not shipped as first drafted:** the
initial plan proposed `discord-notify:<provider>` (one 10-minute window shared across
`/answer` and `/models`). The user caught that this wasn't actually reasoned through in
the plan and asked for an explicit justification before approving. Walked through the
tradeoff: a shared window risks a `/models` failure silently suppressing a later, more
user-impacting `/answer` failure for the same provider, since the two hit different
provider endpoints and can fail independently — nothing is lost from the actual record
either way (Workers Logs still captures every failure on both endpoints, unsuppressed;
only the Discord alert itself is throttled), but the *visibility* gap was real enough
that the user chose the finer-grained option. Shipped as
`discord-notify:<provider>:<answer|models>` — `worker/src/discord.ts`'s `shouldNotify`
takes an explicit `endpoint: 'answer' | 'models'` parameter, threaded through
`notifyDiscordOfFailure` and both call sites. Both `discord.test.ts` and
`index.test.ts` got a dedicated test proving a `/models` failure does *not* suppress a
subsequent `/answer` alert for the same provider (and vice versa).

**Tests:**
- `worker/src/discord.test.ts` (new): payload shape (fields, truncation, null
  fallbacks, `allowed_mentions`), `sendDiscordAlert` never throws (network rejection,
  non-2xx response), a key-leak test structurally proving `DiscordFailurePayload` has
  no `apiKey` field at all (the module cannot receive a raw key, let alone leak one),
  `shouldNotify` suppression/independence/TTL behavior.
- `worker/src/index.test.ts`: a `ctx` mock helper (`waitUntil` pushes into a
  per-test-reset array; `flushWaitUntil()` awaits it) threaded as a third argument into
  every `worker.fetch(...)` call site (~33, done mechanically via a small paren-
  balancing script rather than by hand — a plain find/replace couldn't handle the
  varied multi-line call shapes safely). New dedicated leak tests for `/answer` and
  `/models` mirroring Session 11's `logProviderError` discipline exactly: drive a real
  failure through the real dispatch path with a distinctive fake secret as the apiKey,
  assert the Discord POST body contains the correct sanitized fields and never the real
  secret. Plus a same-endpoint suppression test and a cross-endpoint independence test.
- Worker: 150 tests (was 148 after `ctx` threading alone, +2 for the endpoint-
  independence fix). Frontend: 53 (untouched).

**Problems encountered (both self-caught during this session, one before deploy, one
after):**
- Four of the new tests called `vi.spyOn(console, 'error').mockImplementation(...)`
  without capturing and `.mockRestore()`-ing the spy, breaking every other test in the
  file's established pattern. This wasn't cosmetic — it made an unrelated, order-
  dependent test fail (`/models` log-safety test asserted `console.error` called once,
  got 5) when the full suite ran, despite passing in isolation. Fixed by matching the
  existing pattern (capture the spy, `mockRestore()` at the end) in all four; full
  suite green afterward.
- **Live-verification test-construction bug, caught by the user reviewing the actual
  Discord screenshot, not by me:** the live check fired `/answer` against `grok` with
  model `grok-beta` — a stale id not used anywhere else in this codebase (every other
  reference, including the test suite, uses `grok-4`). Grok's API rejects unknown
  models with `400 Model not found` before/regardless of checking the bearer token, so
  that request never actually exercised a key-rejection path — the Discord alert it
  produced was real and correctly formatted, just not a test of what it was meant to
  test. Separately, I initially asked the user to check for three "message slots"
  corresponding 1:1 to the three requests fired, when the second request was expected
  to produce zero messages (correct suppression) — the resulting confusion about which
  screenshot message was which was a reporting error on my part, not a system bug, and
  took an extra round-trip to untangle. Recorded here so the next session doesn't
  repeat either mistake.

**Deployed and live-verified (`pocketrag-answer.abhiram-dev.workers.dev`):** two
deploys this session (once after the initial `ctx`-threading build, once after the
suppression-key revision), each smoke-checked immediately after to confirm the
existing sanitized-failure behavior was unchanged. User created the Discord webhook
and ran `wrangler secret put DISCORD_WEBHOOK_URL` themselves (never pasted in chat).
Four real requests fired against the live Worker in total:
1. `/answer`, `grok`, `model: grok-beta`, fake key → real `400 Model not found`
   alert delivered, correctly formatted, no key present — but not a key-rejection test
   (see caveat above).
2. `/answer`, `grok`, identical body, ~3s later → correctly suppressed, **zero**
   Discord messages (same `discord-notify:grok:answer` window) — suppression proven.
3. `/models`, `grok`, fake key (no model field — `/models` requests never send one) →
   real `400 Incorrect API key provided...` alert, `Model: n/a` (correct — `handleModels`
   always passes `model: null`), no key present. **Genuine key-rejection, cleanly
   verified**, and its independent delivery (not suppressed by request 1's `/answer`
   window) proves endpoint-independence.
4. `/answer`, `openrouter`, valid model shape (`openai/gpt-4o-mini`), fake key, fired
   to avoid waiting out `grok:answer`'s still-active suppression window → real `401
   Missing Authentication header` alert, correctly formatted, no key present.
   **Genuine key-rejection, cleanly verified.**

**Left incomplete: nothing.** `grok`'s own `/answer` endpoint was re-verified once its
suppression window naturally cleared (confirmed expired via a direct
`wrangler kv key get discord-notify:grok:answer` before re-firing, not assumed from
elapsed time): `/answer`, `grok`, `model: grok-4`, fake key → real `400
{"code":"invalid-argument","error":"Incorrect API key provided..."}` alert, correctly
formatted, no key present. All 5 providers' failure paths and the full Discord
notification system (delivery, suppression, endpoint-independence) are now fully
live-verified with no remaining gaps.

**Next session should start with:** the combined Milestone 7c + styling/UX pass (see
TODO.md) — the only queued work.

---

### Session 14 — 2026-08-11
**Goal:** Combined Milestone 7c (BYOK UI/error-state polish) + Milestone 8 (error UX
overhaul) + the deferred general styling/UX pass, in one coherent pass per the user's
explicit sequencing (queued at the end of Session 13). Plan mode used: researched the
current UI (three parallel Explore agents — BYOK/error-state code, general styling
foundation, prior backlog notes) confirmed this was a genuine blank slate (no design
tokens, no dark mode, zero responsive breakpoints, no icon library, no shared
component primitives), then used the `ui-ux-pro-max` skill's `--design-system` search
for real style/color/typography options before asking the user to decide scope.

**Decisions the user made before any code (via `AskUserQuestion`):**
- Style: **Minimalist Swiss, light + dark** (not dark-only or glassmorphism) — fits a
  privacy-focused local-first tool's "documentation site / professional tool"
  positioning better than something decorative.
- New dependency approved: **`@phosphor-icons/react`** — the only new dependency in
  this pass (project rule: ask before adding one). The app previously had zero icons
  beyond a Unicode `✕`.
- **Milestone 8 folded in** rather than left separate — polishing error-state visuals
  (7c) without fixing the underlying generic-message taxonomy (8) would've meant
  re-skinning messages that were still unhelpful.
- **No new landing/marketing screen** — restyle the existing 5 components + `App.tsx`
  shell in place; Milestone 14's "landing page" half stays open, separate future work.

**Design system, as shipped:**
- Font: **Inter**, self-hosted (not Google Fonts CDN) — `public/fonts/inter-latin-variable.woff2`
  (variable font, one file, `font-weight: 100 900` range) + `@font-face` in
  `src/index.css`, avoiding a third-party request on every load, consistent with this
  app's local-first posture. `--font-sans` token in a Tailwind v4 `@theme` block.
- Dark mode: **`prefers-color-scheme` only**, zero config (Tailwind v4's `dark:`
  variant works this way natively since there's no `tailwind.config.*`) — no manual
  toggle. `color-scheme: light dark` added to `:root` so native controls (checkboxes)
  render in the correct theme too — caught via the Playwright visual check below,
  where a checkbox looked like a stark white square against the dark background
  before this one-line fix.
- Colors: kept blue (primary), red (error), amber (warning) as-is — already
  established conventions. Added **green (success)** and a **neutral slate (info)**
  tone, both previously unused anywhere in the app.
- No CSS-custom-property token layer, no animation library, no manual dark/light
  toggle — all explicitly scoped out in the plan with the specific trigger to add them
  later if actually needed.

**Built — shared primitives (`src/components/ui/`, new):**
- `Button.tsx` — variant (primary/secondary/destructive), `loading` prop (Phosphor
  spinner, replaces every "Fetching…"/"Searching…" text-only loading state), 44px min
  touch target, visible focus ring.
- `StatusBanner.tsx` — variant (error/warning/success/info), fixed icon+color per
  variant. Replaced every ad-hoc `border-*-200 bg-*-50 p-*` box across all 4 restyled
  components (5+ near-duplicate blocks collapsed into one).

**Built — Milestone 8 error taxonomy:**
- `src/lib/errorTaxonomy.ts` (new, pure functions, fully unit-tested) — `classify()`
  for Worker API failures (rate-limit/provider-unavailable/network/unknown by HTTP
  status), `classifyPdfError()`, `classifyWebgpuFallback()`.
- **Important scope correction found during implementation, not in the original
  plan:** the plan listed `invalid-key` as its own taxonomy type alongside
  `provider-unavailable`. Turns out these are **not actually distinguishable**
  client-side — the Worker deliberately sanitizes every provider-call failure (bad
  key, provider outage, bad model, etc.) into the same generic 502 message across all
  5 providers (Sessions 11-13's uniform sanitize-and-log decision, a deliberate
  security choice, not a gap). Dropped `invalid-key` as a separate type and documented
  why directly in `errorTaxonomy.ts` rather than silently building something that
  implied a distinction the architecture doesn't actually support.
- `worker/src/rateLimit.ts` — `RateLimitResult` gains `resetAt` (ISO timestamp, next
  UTC midnight, computed once per check and returned whether allowed or denied).
  `worker/src/index.ts`'s two 429 branches now include it in the response body.
  Backward compatible (old clients ignore the new field). New tests: `rateLimit.test.ts`
  asserts the exact UTC-midnight value via fake timers; `index.test.ts` asserts the
  429 response shape. Frontend (`src/lib/apiError.ts`'s new `WorkerRequestError`
  class + `parseWorkerErrorResponse` helper, shared by `answerRequest.ts` and
  `models.ts`) threads `status`/`resetAt` from the HTTP response all the way to
  `errorTaxonomy.classify()`, which formats the reset time via
  `Intl.DateTimeFormat` in the user's local timezone — satisfies Milestone 8's literal
  "exact reset time in the user's local timezone" requirement, which the Worker's
  429 response never carried any structured data for before this session.

**Restyled (design system + Phosphor icons + responsive breakpoints + dark mode
applied throughout, per-file specifics):**
- `App.tsx` — shell tokens, `space-y-6` for consistent inter-section rhythm (removed
  now-redundant `mt-*`/`mb-*` margins from each child component).
- `DropZone.tsx` — tokens, `UploadSimple` icon, `StatusBanner` for the non-PDF reject
  message (reclassified from red/error to amber/warning — skipping some files isn't a
  failure). **Real accessibility bug found and fixed** (see below).
- `DocumentList.tsx` — `StatusBanner` for the WebGPU-fallback notice (via
  `classifyWebgpuFallback`, correctly `info` severity not `error` — it's an automatic
  working fallback, not a failure) and the delete-confirm/delete-error boxes,
  `Trash` icon (replaces `✕`), `motion-safe:animate-pulse` on the model-download text.
- `QueryPanel.tsx` (largest) — `Button`/`StatusBanner` throughout, `success` variant
  (green, newly available) for a fully-grounded answer vs. `warning` for a
  not-fully-grounded one, responsive `flex-col sm:flex-row` question input so it
  stacks on mobile instead of staying a cramped fixed row, `answerError` now carries a
  real `TaxonomyResult` (type/severity/message) instead of a plain string.
- `ByokPanel.tsx` (Milestone 7c) — `Button` with `loading`, password show/hide toggle
  (`Eye`/`EyeSlash`, a guideline the UI/UX skill flagged as missing), Experimental
  caveat and fetch-error both through `StatusBanner`, error path now uses
  `errorTaxonomy.classify()` via the new `WorkerRequestError` (catches the real
  status/resetAt instead of just a message string).

**Real bug caught by the Playwright verification pass, not by review:** the file-input
"browse" trigger in `DropZone.tsx` used `className="hidden"` (`display:none`) on the
native `<input type="file">`, which removes an element from the tab order entirely —
keyboard-only users could never reach it. Playwright's keyboard-nav check (Tab ×3)
landed on `document.body` instead of a real control, which is what surfaced it. Fixed
by switching to `sr-only` (visually hidden, stays focusable) plus a `focus-within:`
ring on the wrapping `<label>` (peer-selectors don't work here since the input is a
descendant of the label, not a preceding sibling). Re-verified: focus now correctly
lands on the input after 3 tabs.

**Verification:**
- Frontend: 61/61 tests (was 53, +8 for `errorTaxonomy.ts`). Worker: 151/151 (was
  150, +1 for `resetAt`'s UTC-midnight assertion). `tsc`/`oxlint` clean both sides.
  `npm run build` clean, bundle-size guard passes (JS bundle grew ~638KB → ~670KB from
  Phosphor + new code, comfortably within budget).
- Playwright installed temporarily (per this project's established per-session
  pattern), used to check: light mode, dark mode, mobile viewport (375px, no
  horizontal overflow), keyboard-only navigation (caught the bug above),
  `prefers-reduced-motion` respected, zero console errors on load. Screenshots
  inspected visually. Uninstalled after — confirmed zero leftover in
  `package.json`/`package-lock.json`, browser cache removed.
- Deployed: Worker first (`wrangler deploy`, backward-compatible `resetAt` addition),
  then frontend build + `wrangler pages deploy dist --project-name=pocketrag
  --branch=main`, confirmed landed as Production via `wrangler pages deployment
  list`, bundle-hash-verified against the live `pocketrag.pages.dev` URL directly
  (not just the deployment-specific URL).

**Left incomplete:** Milestone 14's landing-page half (deliberately out of scope per
the user's choice). Anthropic/Grok/OpenRouter's BYOK *success* path still needs real
test keys (unchanged standing item from prior sessions). No new gaps from this
session's own scope.

**Next session should start with:** no queued task — ask the user. Milestone 14's
landing page, the BYOK success-path verification (whenever test keys exist), or
milestones 9-16 are the standing candidates.

---

<!-- Copy the block above for each new session -->
