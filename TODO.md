# TODO.md — PocketRAG

Claude updates this at the end of every session.
Read this at the start of every session to know what to work on next.

---

## 🔴 Current Sprint
Milestone 6 (multi-document, bulk upload, cross-document retrieval, restore-on-reload),
the deferred "delete a persisted document" scope, **Milestone 7a (BYOK, Gemini-only)**,
and now the first slice of **Milestone 7b (BYOK, OpenAI added as a second provider)**
are all complete and deployed.
- Frontend: https://pocketrag.pages.dev (Cloudflare Pages)
- API: https://pocketrag-answer.abhiram-dev.workers.dev (Cloudflare Worker)
OpenAI BYOK verified end-to-end against the **live production site** (Session 9, source
`152121b`): a real visitor can toggle "Use your own API key," pick OpenAI from the
provider selector, enter a real key, fetch the live model list, pick a model, and get a
real grounded answer — all on `pocketrag.pages.dev` itself, not local dev. Worker
deployed first (backward compatible — `SUPPORTED_PROVIDERS` gaining `'openai'` doesn't
affect existing `'gemini'` requests), then Pages. Bundle-hash-verified against the live
site. The `wrangler tail` key-leak check was completed via a workaround (run by the user
directly, outside the session's Bash tool — see AGENTS.md Session 9's Known Environment
Limitation note) after `wrangler tail` was confirmed unable to connect from this
session's execution environment.

**Milestone 7b — all 5 BYOK providers now exist and are live on `pocketrag.pages.dev`
(Session 11, source `305ef4a`).** Gemini and OpenAI remain fully proven (real
grounded-answer E2E verified live, per Sessions 8-9). Anthropic, Grok, and OpenRouter
are shipped as **Experimental**: selectable in `ByokPanel.tsx`'s provider picker (no
longer disabled/hidden — that was Session 10's now-superseded `VERIFIED_PROVIDERS`
gate) with a visible "(Experimental)" label and caveat text, since none of the three
has a working test key to prove a real *successful* answer/model-fetch call. What
**is** live-verified for all three, as of this session: the **failure path**. A
deliberately-invalid key was sent against the live Worker for each of the three,
producing a real `502` with the sanitized `"This provider isn't fully supported yet.
Please try Gemini or OpenAI for now — we're working on it."` message (never the raw
provider error) — and `wrangler tail`, run by the user per the established workaround,
confirmed the corresponding structured log entry (`logProviderError` in `index.ts`)
landed cleanly in Workers Logs for all three, with no trace of the fake key. This same
log-and-sanitize path was extended uniformly to Gemini/OpenAI too, not just the 3
Experimental providers. See AGENTS.md Session 11 for the honest scope-of-proof caveat
on what this specific check does and doesn't prove about key-leak resistance, and
Session 12 for the message-wording reword (`ebc1670`) and its live re-verification.

**Discord webhook notifications for provider-call failures — built and live
(Session 13).** Every failure across all 5 BYOK providers on both `/answer` and
`/models` now posts a sanitized embed (provider, model, status, message — the same
already-key-free string `logProviderError` uses) to a Discord channel via
`worker/src/discord.ts`, fire-and-forget via `ctx.waitUntil` (never blocks/delays the
response, never throws). Suppressed to one alert per `(provider, endpoint)` per
10-minute window (`discord-notify:<provider>:<answer|models>` in the existing
`RATE_LIMIT_KV`) — `/answer` and `/models` are tracked independently since they can
fail on their own. `DISCORD_WEBHOOK_URL` is an optional Worker secret (mirrors
`GEMINI_API_KEY`'s setup); the feature is fully inert until it's set.

Live-verified with real requests against the deployed Worker: suppression confirmed
(a same-provider, same-endpoint repeat within the window produced zero Discord
messages), endpoint-independence confirmed (`grok`'s `/answer` and `/models`
suppression windows fired independently), and genuine invalid-key rejections were
cleanly captured and delivered with no key leak for `openrouter`/`/answer` (`401
Missing Authentication header`), `grok`/`/models` (`400 Incorrect API key provided`),
and — re-verified once its suppression window naturally cleared — `grok`/`/answer`
itself with the correct model id (`grok-4`, not the stale `grok-beta` the first check
mistakenly used): `400 Incorrect API key provided`. **No open gaps remain**: all 5
providers' failure paths and the full Discord notification system are fully
live-verified. See AGENTS.md Session 13 for the full story.

**Milestone 7c + Milestone 8 + general styling/UX pass — built and live (Session 14).**
Combined per explicit user sequencing (queued at the end of Session 13). Minimalist
Swiss design system, light + dark (OS-preference only, no manual toggle), Inter font
(self-hosted, not Google Fonts CDN), `@phosphor-icons/react` (the one new dependency
this session). New shared primitives (`src/components/ui/Button.tsx`,
`StatusBanner.tsx`) and a real error taxonomy (`src/lib/errorTaxonomy.ts`) replace
every ad-hoc colored box and generic error string across `DropZone.tsx`,
`DocumentList.tsx`, `ByokPanel.tsx`, and `QueryPanel.tsx`. Rate-limit responses now
carry an exact `resetAt` timestamp (`worker/src/rateLimit.ts`/`index.ts`), formatted
in the user's local timezone — satisfies Milestone 8's literal requirement, which
nothing in the API carried structured data for before this session. A real keyboard-
accessibility bug (file-upload trigger unreachable via Tab, `display:none` vs.
`sr-only`) was caught by a Playwright pass and fixed. Frontend: 61/61 tests. Worker:
151/151. Deployed and bundle-hash-verified live. See AGENTS.md Session 14 for the
full design-system rationale, the `invalid-key` taxonomy scope correction found during
implementation, and per-file restyle details.

**Milestone 11 — Better retrieval, Phase A of 3 built and live (Session 15).** Staged
plan: Phase A (hybrid keyword+embedding search) done this session; Phase B (client-side
reranking) and Phase C (multi-turn conversation context) remain, each a separate
future step — see AGENTS.md Session 15 for the full staging rationale and the
decisions already locked in for B/C (client-side cross-encoder reranking, not
Worker/LLM; frozen per-conversation Doc N labels; client-side context blending for
follow-ups, not LLM query rewriting). Phase A: `src/lib/bm25.ts` (new BM25 scorer) +
`hybridRankChunks` in `src/lib/retrieval.ts` (Reciprocal Rank Fusion, k=60, combining
BM25 and cosine rank) is now the unconditional default for every query, no toggle.
Live-verified with a real multi-chunk PDF — a chunk containing a unique exact-match
term correctly outranked two topically-similar-but-wrong chunks. Frontend: 75/75
tests. Deployed (frontend only — Phase A touches no Worker code).

Full roadmap (Milestones 7-16) in 🟢 below. **Next queued: Milestone 11 Phase B**
(client-side reranking) — do not attempt Phase B and Phase C together. Remaining BYOK
work: live-verify Anthropic/Grok/OpenRouter's *success* path (a real grounded answer,
not just the failure path) whenever real test keys become available — flip each from
Experimental to fully proven at that point, no code change needed beyond removing it
from `EXPERIMENTAL_PROVIDERS`. Milestone 14's landing-page half (deliberately out of
scope, Session 14) and milestones 9-10/12-13/15-16 remain open otherwise.

---

## 🟡 Up Next
### Milestone 6 — Multi-document + bulk upload ✅ COMPLETE
- [x] Document list/picker UI — the multi-doc UX explicitly deferred back in
      Milestone 3 — Commit 2 (`DocumentList.tsx`, selection state in the store)
- [x] Bulk drag-and-drop: multiple PDFs at once, per-file rows, one failing file
      does not block the others (sequential embed queue; `processFile` resolves —
      never rejects — on ready or error) — Commit 4
- [x] Error-row action in the document list — Commit 4. Decision: **Remove (✕) only**.
      A failed file was never persisted (saveDocument runs only on full success), so an
      error row is a pure in-memory notice; removing it just clears that notice. Retry =
      re-drop the file (still on disk, runs the normal path) — simpler than retaining
      File objects for a retry pipeline. Deleting a *persisted* document is separate scope
      (see Backlog below).
- [x] Retrieval scope toggle: "this document" vs "all documents" for a query — Commit 4
      (`getAllChunks()` pools across docs; cosine scores compare across documents because
      every embedding is unit-normalized by the same model — see ARCHITECTURE.md)
- [x] Restore-on-reload — persisted docs come back as `ready` on load; `restoreDocuments`
      merges by id (StrictMode-safe, can't clobber a doc dropped the same instant) —
      Commit 4
- [x] Call `navigator.storage.persist()` on first save — best-effort, guarded,
      fire-and-forget (`requestPersistOnce` in `db.ts`) — Commit 4
- [x] Tests for multi-document ranking: document-scoped retrieval must not leak another
      doc's chunk, `getAllChunks` pooling, `assignDocLabels` mapping, `restoreDocuments`
      merge — Commit 5 (`db.test.ts`, `db.getall.test.ts`, `labels.test.ts`, `documentStore.test.ts`)

---

## 🟢 Backlog — Milestones 7-16, in order

### 7. BYOK (bring your own key)
- [x] **7a — Gemini only, full trust model end-to-end** — Session 8. Key never
      persisted (request-scoped variable server-side, local component state
      client-side); live model-list fetch (`POST /models`); real answer calls with a
      user-supplied key; `x-goog-api-key` header auth (not a URL query param) for both
      shared and BYOK paths; independent rate-limit buckets so BYOK never touches the
      shared-tier quota. Deployed and verified live on `pocketrag.pages.dev`.
- [x] **7b — OpenAI added as a second provider** — Session 9. Chat Completions API
      (`POST /v1/chat/completions`) chosen over the newer Responses API — stateless
      shape matches `providers/gemini.ts`'s pattern; `Authorization: Bearer` header
      auth; model list returned unfiltered (no capability field like Gemini's
      `supportedGenerationMethods` to filter chat-capable models — documented
      tradeoff, a wrong pick just 502s on the next question). Provider dispatch in
      `index.ts`, `SUPPORTED_PROVIDERS` allowlist extended, provider selector added
      to `ByokPanel.tsx`. Deployed and verified live on `pocketrag.pages.dev`.
- [~] 7b — Anthropic (Claude), Grok, OpenRouter: **all 5 providers code-complete and
      deployed, but Anthropic/Grok/OpenRouter's *success* path (a real answer/model-fetch
      call) remains unverified** — Sessions 10-11. Each has its own `worker/src/providers/
      *.ts` + mocked-response unit tests (10 each, same two-key-leak-test discipline as
      Gemini/OpenAI); `SUPPORTED_PROVIDERS` covers all 5. Grok's models list is at
      `/language-models` under a `models` key (not `/models`/`data` like every other
      provider); OpenRouter's chat call sends optional `HTTP-Referer`/`X-Title` headers.
      Session 10's `VERIFIED_PROVIDERS` disabled-gate (Anthropic hidden from the UI) was
      **superseded this session** by `EXPERIMENTAL_PROVIDERS` — all 5 are now selectable
      in `ByokPanel.tsx`, with the 3 unverified ones labeled "(Experimental)" plus a
      caveat, rather than blocked outright. Backing this: a new uniform
      log-and-sanitize path (`logProviderError` in `index.ts`) applied to **all 5**
      providers' failure handling, not just the experimental 3 — a provider-call failure
      logs a structured, key-free entry server-side (Workers Logs, no new infra) and
      returns a calm generic message to the client instead of raw provider error text.
      **Live-verified for the failure path only** (Session 11): a deliberately-invalid
      key against the live Worker for Anthropic/Grok/OpenRouter each produced a real 502
      + sanitized message, and `wrangler tail` (user-run) confirmed all three structured
      log entries landed clean, no key leak. The *success* path — an actual working
      answer through any of the 3 — is still unverified; that's what remains before they
      can be called fully proven like Gemini/OpenAI.
- [x] **7c — UI polish/error states — Session 14.** `Button`/`StatusBanner` primitives
      applied throughout `ByokPanel.tsx`: loading spinner, password show/hide toggle,
      Experimental caveat and fetch-error both through `StatusBanner`, real
      `errorTaxonomy.classify()` wiring instead of a raw message string.
- Never persist keys anywhere — no KV, no DB, no logs. In-memory for one request only.
- Model lists fetched live from each provider's own list-models endpoint, not hardcoded

### 8. Error UX overhaul ✅ COMPLETE — Session 14
- [x] Plain-language error taxonomy (`src/lib/errorTaxonomy.ts`) — rate limit (exact
      reset time in the user's local timezone, via a new `resetAt` field on the
      Worker's 429 response), provider-unavailable (covers "invalid key" too — see
      AGENTS.md Session 14 for why these aren't actually distinguishable client-side),
      network error, unreadable PDF, WebGPU unsupported (correctly `info` severity,
      not `error` — it's a working automatic fallback).

### 9. Handwritten/Scanned Notes
- Separate tab from Documents
- Explicit "this file will be uploaded for cloud OCR" consent before anything happens
- Documents tab stays 100% local, unchanged — see ARCHITECTURE.md's two-tab privacy
  model note

### 10. Diagram-aware Q&A
- Extract embedded page images at ingestion
- Send the one relevant page image to the multimodal answer call when a matched
  chunk likely has a diagram
- Fits the existing trust model: only relevant content leaves the browser

### 11. Better retrieval
- [x] **Phase A — Hybrid keyword+embedding search — Session 15.** `src/lib/bm25.ts` +
      `hybridRankChunks` in `retrieval.ts`, Reciprocal Rank Fusion (k=60). Live-verified.
- [ ] Phase B — Reranking (client-side cross-encoder, decision locked in Session 15)
- [ ] Phase C — Multi-turn conversation context (frozen Doc N labels, client-side
      context blending — decisions locked in Session 15)

### 12. Hybrid web search toggle
- Modes: notes-only / web-only / hybrid
- Brave Search API

### 13. Export answer/chat as PDF

### 14. Landing page + full UI/UX pass
- [x] **Full UI/UX pass — Session 14.** Design system (Minimalist Swiss, light+dark,
      Inter, Phosphor icons), responsive breakpoints, dark mode, shared primitives
      applied across `App.tsx` + all 4 components. See AGENTS.md Session 14.
- [ ] Landing page — deliberately kept out of Session 14's scope (restyle-only, no new
      screens/routes/marketing copy, per explicit user choice). Still open.

### 15. Security review
- `/claude-security` → scan codebase, fix findings

### 16. Final E2E retest, GitHub remote + push, delivery

---

## 🟢 Backlog — carried over, unscheduled
- [ ] Force a smaller onnxruntime-web WASM variant (13MB/14MB vs current 22.5MB) —
      investigated in Session 5, deliberately deferred: the smaller variants may lack
      the async interop our dual WebGPU/WASM pipeline needs, and onnxruntime-web's
      published `ort.webgpu.mjs` hardcodes the asyncify variant rather than exposing
      a safe runtime/build switch. Real fix, not a shortcut — needs cross-browser
      testing before touching it. The build-time size guard (see Completed) is the
      interim mitigation, not a substitute for this.
- [ ] Stronger groundedness check (Milestone 4 grill-me answer): current check only
      catches citation-level inconsistency (citing a page not in the input, or citing
      nothing without admitting the gap). Doesn't catch a real page being cited with
      misattributed content — would need a second verification LLM call or human
      review. Not built; flagged as a known limitation, not silently absent.
- [ ] Custom domain for Pages (optional) — dashboard-only step, entirely on the user
      if ever wanted. Not needed; `pages.dev` subdomain works fine for a demo.

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
- [x] git init, .gitignore, first commit (Milestone 1+2) — Session 3, 2026-07-25
- [x] Per-page text extraction (pdf.js) so every chunk has an unambiguous page number
      — Session 3, 2026-07-25
- [x] IndexedDB storage layer (`idb`): Document + Chunk stores, `documentId` index,
      tested with `fake-indexeddb` — Session 3, 2026-07-25
- [x] Chunks + embeddings persisted to IndexedDB after each document embed —
      Session 3, 2026-07-25
- [x] Query UI: embed query text through the same Worker/model, cosine-rank against
      stored chunk embeddings pulled from IndexedDB, show top-3 with page + real
      score — Session 3, 2026-07-25
- [x] Cloudflare Worker (`worker/`): POST /answer, input validation/capping, grounded-QA
      prompt, citation-based groundedness check, KV rate limiting (50/day/IP), CORS —
      Session 4, 2026-07-25
- [x] Real Gemini call verified end-to-end (`wrangler dev` + Vite dev + real browser):
      correct answer, correct page citation, no grounding warning — Session 4, 2026-07-25
- [x] QueryPanel shows composed answer as primary result, raw ranked chunks as
      collapsible "Sources," visible (non-silent) failure note if the Worker call
      fails — Session 4, 2026-07-25
- [x] Worker deployed (code is live) — Session 4, 2026-07-25
- [x] `workers.dev` subdomain registered by user; live at
      `pocketrag-answer.abhiram-dev.workers.dev`; `.env.production` set — Session 5, 2026-07-25
- [x] Latency investigation: direct-to-Gemini and through-Worker calls both
      consistently under 1.5s (cold start, warm repeats, minimal and full-size
      prompts all tested) — the earlier 277s/30-280s observation did not reproduce.
      See AGENTS.md Session 5 for full numbers and caveats — Session 5, 2026-07-25
- [x] Honest "this can take up to a few minutes" expectation-setter added to
      QueryPanel, scoped to just the Gemini-wait phase — Session 5, 2026-07-25
- [x] Client-side ~60s timeout + manual "Try again" retry on the answer-composition
      request. Retry reuses the in-memory ranked chunks (no re-embed). A second
      timeout on retry falls back to the standard hard-failure note. Pure timeout
      logic (`attemptAnswer()`) unit-tested with a mocked hanging fetch + fake
      timers — Session 5, 2026-07-25
- [x] Verified Cloudflare Pages' 25 MiB per-file limit against actual docs (not
      assumed), measured the real onnxruntime-web WASM asset at 22.47 MiB (10.1%
      headroom, not "safely under"), investigated forcing a smaller variant (deferred,
      see Backlog — real risk, not a shortcut), and added `scripts/check-bundle-size.mjs`
      as a build-time guard (fails loudly at 24 MiB, before Cloudflare's hard 25 MiB
      cap) — Session 5, 2026-07-25
- [x] Deployed frontend to Cloudflare Pages: `pocketrag.pages.dev` (production,
      branch `main`) — Session 5, 2026-07-25
- [x] Updated `PAGES_ORIGIN` in `worker/wrangler.jsonc` to the real Pages URL,
      redeployed the Worker — Session 5, 2026-07-25
- [x] Verified full end-to-end against the **live production deployment** (not local
      dev): real browser hitting `pocketrag.pages.dev`, real PDF upload, real
      question, real Gemini answer with correct citation, correct CORS header for the
      real origin, zero console errors — Session 5, 2026-07-25
- [x] Milestone 6 — multi-document library (list/picker + selection), bulk
      drag-and-drop with per-file rows and independent failure, retrieval scope toggle
      (this document / all documents) with cross-document ranking, Worker-owned per-request
      `Doc N` citation labels, restore-on-reload from IndexedDB, and
      `navigator.storage.persist()` on first save. Multi-document tests added
      (`db.test.ts`, `db.getall.test.ts`, `labels.test.ts`, `documentStore.test.ts`); verified live in a real
      browser (batch drop → reload → cross-document query) — Session 6, 2026-08-01
- [x] Delete a persisted document: `deleteDocument()` (`db.ts`, atomic readwrite over
      `documents` + `chunks` via the `documentId` index), inline two-step "Delete
      permanently?" confirm on ready `DocumentList` rows (not `window.confirm()`),
      selection cleared if the deleted doc was active (existing `removeDocument`
      behavior, now covered by a direct test). `canRunQuery()` extracted to
      `queryScope.ts` as a pure, unit-tested helper. Verified live in a real browser:
      drop 2 docs, delete one via the confirm step, reload — only the survivor comes
      back — Session 7, 2026-08-08
- [x] Milestone 7a — BYOK, Gemini-only: key entry, live model-list fetch, real answer
      calls with a user-supplied key, key never persisted anywhere (request-scoped
      server-side, local component state client-side), header-based provider auth,
      independent shared/BYOK rate-limit buckets. Verified end-to-end on the live
      production site (not local dev) — Session 8, 2026-08-09
- [x] Milestone 7b (first provider) — BYOK, OpenAI added alongside Gemini: Chat
      Completions API chosen over the newer Responses API (stateless shape matches
      the existing `providers/` pattern), `Authorization: Bearer` header auth,
      unfiltered model list (documented tradeoff — no capability field to filter
      chat-capable models), provider dispatch in `index.ts`, provider selector in
      `ByokPanel.tsx`. Verified end-to-end on the live production site, including a
      `wrangler tail` key-leak check completed via a workaround (see Ideas/Notes) —
      Session 9, 2026-08-10

---

## 🐛 Known Bugs
(none currently tracked)

---

## 💡 Ideas / Notes
- **`EXPERIMENTAL_PROVIDERS` (Session 11) supersedes Session 10's `VERIFIED_PROVIDERS`
  disabled-gate as the standard pattern for shipping a BYOK provider whose Worker code
  is done but has no real key to live-verify against.** The disabled/"coming soon" gate
  (used for Anthropic in Session 10) was deliberately replaced, not just renamed: a
  key-less provider is now shipped **selectable** — real users with real keys can try
  it — labeled "(Experimental)" with a visible caveat instead of blocked outright. This
  only works because of the uniform log-and-sanitize path added the same session
  (`logProviderError` in `index.ts`, applied to all 5 providers): any failure is caught,
  logged server-side with full diagnostic detail (key-free, structured, lands in Workers
  Logs automatically), and the client only ever sees a calm generic message — so an
  Experimental provider's failure mode is safe to expose to real traffic even before its
  success path is proven. `worker/src/providers/<name>.ts` + full mocked-response unit
  tests (including the two key-leak tests) still ship and deploy on the Worker side
  immediately regardless of which gate is used. Move a provider from
  `EXPERIMENTAL_PROVIDERS` to fully proven once its *success* path — not just the
  failure path — is live-verified (a real grounded answer, not just a real invalid-key
  502). Apply this pattern to any future provider built without a test key.
- **Evaluated PixelRAG (StarTrail-org, Apache-2.0) — declined on architecture fit, not
  quality.** Screenshot-based RAG: embeds rendered page *images* with a Qwen3-VL-Embedding-2B
  model instead of parsed text, preserving tables/charts/layout. Real and well-built, but
  requires a Python serving backend + CUDA/MPS-class compute for embedding — incompatible
  with PocketRAG's browser-only, in-Worker embedding architecture and the "documents never
  leave the browser" guarantee. The underlying problem it solves (visual structure lost in
  text parsing) is already addressed compatibly by Milestone 10's page-image extraction,
  which sends only the relevant page image per matched chunk through the existing trust model.
- **IndexedDB storage ceiling (Milestone 6 grill-me, researched against current MDN
  docs):** not a size problem at personal scale. ~5KB/chunk (384-float embedding +
  text), ~500KB for a dense 20-page document, ~100MB for 200 documents. Chrome/Edge:
  60% of disk per origin. Firefox best-effort: `min(10% disk, 10 GiB)` per site group.
  Safari (current Storage Standard): ~60% of disk, matching Chrome — the old
  "1GB then prompt" behavior is superseded. All three orders of magnitude larger than
  realistic personal use. **The real risk is Safari's proactive eviction**: origins
  with no user click/tap in 7 days get their script-created data deleted outright,
  regardless of disk space — a real way to silently lose a whole document library for
  a tool people might not open daily. Mitigation: call `navigator.storage.persist()`
  on first save (exempts the origin from eviction on all three browsers). Source:
  https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- `resolveBackend()` (src/workers/backend.ts) is the one piece of Milestone 2 logic
  that couldn't be verified against real hardware in this sandbox (no GPU) — the
  `webgpu` and `wasm-failed` states are covered by exhaustive unit tests with a
  mocked GPU/pipeline instead of a live browser run. Re-verify against real WebGPU
  hardware when available.
- Milestone 3 deliberately does not restore documents from IndexedDB on page load —
  re-dropping the file is required. Confirmed with the user (2026-07-24 session) to
  avoid guessing at multi-document UX before it's actually decided. Schema already
  supports it (`documentId` foreign key) so this is a UI-only addition later, not a
  migration.
- `gemini-2.5-flash-lite` (named in the original CLAUDE.md/ARCHITECTURE.md) returns a
  404 "no longer available to new users" for this project's API key. Pinned to
  `gemini-3.5-flash-lite` instead — deliberately, not via the floating
  `gemini-flash-lite-latest` alias. CLAUDE.md/ARCHITECTURE.md updated to match.
- **`wrangler tail` cannot connect from this session's Bash execution environment**
  (Session 9 finding, confirmed via five separate methods including a 60-second
  wait) — it hangs indefinitely on its initial connecting spinner. Not a general
  network block: plain HTTPS via `curl` to both `api.cloudflare.com` and the
  deployed Worker's own `*.workers.dev` URL work instantly, and `wrangler dev` /
  `deploy` / `pages deploy` all work normally. The restriction is specific to
  whatever connection `wrangler tail`'s log-streaming relay needs (likely
  WebSocket-based) — distinct from the Session 4/5 DNS-propagation issue below,
  which was transient and self-resolved. **Workaround:** run `wrangler tail`
  directly in a terminal the user controls, outside the session's Bash tool, while
  Claude fires the live request via `curl` at the user's signal; the user reads
  their own terminal's output and reports back. Don't re-attempt `wrangler tail`
  from within the session expecting a different result.
- CORRECTION to a Session 4/5 note: the earlier "this sandbox cannot reach
  `*.workers.dev`" finding was **DNS propagation delay for a brand-new subdomain**,
  not a persistent egress restriction — confirmed in Session 5 by re-testing after
  time had passed (both `pocketrag-answer.abhiram-dev.workers.dev` and
  `pocketrag.pages.dev` are directly reachable from this sandbox now). Future
  sessions: a freshly-registered subdomain may take a few minutes to resolve/route;
  don't conclude "sandbox network restriction" from one early failed attempt — retry
  after a delay before assuming it's unreachable.
- `wrangler pages deploy` tried to delegate to a newer unified "Workers with static
  assets" deployment model on first run, failed (no `wrangler.jsonc` for that model),
  and explicitly suggested `--force` to use the classic direct Pages path instead —
  used it, worked. Also: the Pages project didn't exist yet and needed
  `wrangler pages project create` first; and the first deploy landed as a Preview
  (branch `master`, not the configured production branch `main`) — fixed by
  redeploying with `--branch=main` explicitly. Both are one-time project-setup
  quirks, not expected on future deploys to the same project.
