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

**Milestone 11 — Better retrieval, Phase A + B of 3 built and live (Sessions 15-16).**
Staged plan: Phase A (hybrid keyword+embedding search, Session 15) and Phase B
(client-side reranking, Session 16) done; Phase C (multi-turn conversation context)
remains, a separate future step — see AGENTS.md Sessions 15-16 for the full staging
rationale and the decisions locked in for C (frozen per-conversation Doc N labels,
client-side context blending for follow-ups, not LLM query rewriting).

Phase A: `src/lib/bm25.ts` + `hybridRankChunks` in `retrieval.ts` (Reciprocal Rank
Fusion, k=60), now the unconditional default for every query. Phase B: `src/lib/reranker.ts`
+ a second model in `embedding.worker.ts` (`Xenova/ms-marco-MiniLM-L-2-v2`, the
smaller of two real MS MARCO cross-encoder sizes checked — chosen specifically to
avoid roughly doubling the app's first-use download) — hybrid search now retrieves a
15-chunk pool, reranks it, keeps the top-3, with a graceful fallback to hybrid-only
results if reranking itself fails. Real progress UI added for the reranker's one-time
model download (`"Downloading reranking model — N%…"`, matching `DocumentList`'s
existing convention), not left as a silent gap.

Both phases live-verified with a real multi-chunk PDF — Phase A: a chunk with a
unique exact-match term correctly outranked two topically-similar-but-wrong chunks.
Phase B: displayed scores visibly switched from RRF values to real cross-encoder
logits, confirming live execution; same correct chunk still surfaced; ~3.9s full
round-trip including a cold model download. **Known follow-up, not yet fixed:** the
Sources list's displayed "score" uses two different, confusing scales depending on
whether reranking ran (bounded RRF value vs. unbounded raw logit) — noted for a
future UI polish pass, not a correctness issue. Frontend: 81/81 tests. Both phases
deployed frontend-only (neither touches Worker code).

**Milestone 11 Phase C — split into C1 (Session 17) and C2 (Session 18), both done.
Milestone 11 is now fully complete (Phases A, B, C1, C2 all live).** C1: frozen `Doc N`
labels across a conversation — the client now echoes back the `docLabels` map from its
last answer, and `assignDocLabels()` (`worker/src/labels.ts`) only appends labels for
newly-seen documents, never reassigning an existing one. New `docLabels` field on
`AnswerRequestBody`, capped at `MAX_DOC_LABELS` (20) and rejected on malformed/duplicate
entries. `checkGrounding()` needed no logic change — see AGENTS.md Session 17 for why.
Live-verified: direct-curl proof that an earlier document's label survives a turn where
it isn't retrieved, and a real 3-turn browser run with zero console errors.
ARCHITECTURE.md's "NOT stable across queries" note is superseded — see the updated
citation-labels bullet there.

**C2 (Session 18): client-side retrieval-query blending, prompt history, and the
conversation UI.** Two deliberately separate mechanisms per the locked Session 17
design: (1) `src/lib/conversation.ts`'s `buildRetrievalQuery()` folds only the
immediately preceding question (`RETRIEVAL_HISTORY_TURNS = 1`) into the query text used
for embedding + BM25 (`hybridRankChunks`) — never sent to the Worker as-is, and the
cross-encoder reranker still scores against the literal question. (2) A new capped
`history` field (`MAX_HISTORY_TURNS = 3`, `worker/src/validate.ts`) crosses the wire and
is interpolated into `buildPrompt()`'s "Conversation so far" section with an explicit
"don't cite from this" instruction — `checkGrounding()` needed no logic change (a
citation echoed from history that isn't in *this* turn's passages still correctly trips
`hasUnknownCitation`, documented in `grounding.ts`). `QueryPanel.tsx` stores a capped
(`MAX_STORED_TURNS = 10`) conversation-turn array, renders past turns in a collapsible
"Conversation" block (same box styling as the live answer, native `<details>` pattern
reused from "Sources"), and a new "Clear conversation" button resets turns + the frozen
`docLabels` map + the current answer, restarting `Doc N` numbering — without touching
document selection/scope. Worker: 177/177 tests (+13). Frontend: 87/87 (+5, including
new `src/lib/conversation.ts` + `conversation.test.ts`). Live-verified with a real
4-turn conversation across two hand-written PDFs (6 chunks total, so `TOP_K=3`
retrieval genuinely filters): a vague pronoun follow-up ("What page is that on?") still
surfaced the correct chunk in Sources via blending alone, the Doc N legend stayed
consistent across turns, and "Clear conversation" verifiably restarted numbering at
`Doc 1`. Deployed and bundle-hash-verified live on both `pocketrag-answer.abhiram-dev.workers.dev`
and `pocketrag.pages.dev` (`index-DS5Pe43A.js` / `index-C5Ba68Le.css` match exactly
between the local build and the live site). Two minor non-blocking follow-ups noted,
not fixed — see 🐛 Known Bugs below. See AGENTS.md Session 18 for full detail.

**Milestone 13 — Export conversation as PDF ✅ COMPLETE (Session 19).**
`buildConversationPdf()` (`src/lib/pdfExport.ts`) renders every turn in the current
conversation, in order, plus the current turn's retrieved chunks as a Sources section
(deliberately scoped to the current turn only — past turns' chunks were never retained
in `QueryPanel` state per Session 18's `ConversationTurn` shape). jsPDF chosen over
pdf-lib for its built-in `splitTextToSize()` text-flow — pdf-lib has no equivalent and
would have needed a hand-rolled line-wrapper first. jsPDF does not paginate on its own;
`ensureSpace()` is real manual page-break logic (checks remaining vertical space before
every wrapped line, calls `addPage()` and resets the cursor), directly exercised by a
test that forces a break and asserts content actually continues on the next page.
Live-verified with a real 8-turn, 2-document conversation (`wrangler dev` + Vite dev,
real Gemini): across two separate runs (2 pages and 3 pages, since real answer length
varies), all turns present in order, no truncated/overlapping text at any break, correct
`Doc N` legend on every turn, correct ungrounded-warning rendering, Sources appearing
exactly once for the current turn only. See AGENTS.md Session 19 for the full story,
including the new standing environment note on verifying PDFs in this project (below).

**Milestone 10 — Diagram-aware Q&A, Phase A of 3 ✅ COMPLETE (Session 20).**
Local-only diagram-likely detection, deliberately staged as the first of three phases
given this feature's trust-model weight (the first feature where a raster image, not
just a text snippet, could ever leave the browser — see the full staged plan at
`/home/abhi/.claude/plans/gentle-honking-lemon.md` for the provider-support research
and the three architectural forks resolved with the user before any code was written).
Phase A ships two independent, honestly-imperfect signals ORed together: a structural
one (`src/lib/pdf.ts`'s `pageHasImage()`, a real `pdfjsLib.getOperatorList()` check for
image-paint operators — misses vector-drawn diagrams, false-positives on decorative
images) and a lexical one (`src/lib/diagramHeuristic.ts`'s `isDiagramLikely()`,
word-boundary figure/fig./diagram/chart/graph/table/illustration match — misses
uncaptioned diagrams, false-positives on incidental mentions). Surfaces as a "📊 may
contain a diagram" hint in `QueryPanel.tsx`'s Sources list. No image is sent anywhere
in this phase, no Worker code touched. The structural signal was live-verified against
real generated PDFs (image-only, keyword-only, neither) in an actual browser, not just
unit-tested in isolation — confirms `getOperatorList()` really does return the expected
operators for a real embedded image, not just that the pure boolean-combination logic
is correct. See AGENTS.md Session 20 for the full story, including the DB_VERSION
clarification (no bump needed — IndexedDB has no field-level schema to migrate).
**Milestone 10 Phase B (on-demand page rendering, opt-in toggle, shared-Gemini-only
image sending) shipped and deployed in Session 21** — see TODO.md's Milestone 10
entry below and AGENTS.md Session 21. Phase C (BYOK extension) stays parked pending
a real per-provider vision-capability-detection mechanism.

**Milestone 9 Phase A (Handwritten/Scanned Notes, images only) shipped and deployed
in Session 22** — a structurally separate Notes tab, per-file OCR consent (no
"remember my choice" shortcut), Gemini-reuse transcription (no new provider/trust
surface), combined retrieval pool with a 📝/📄 provenance badge. Live-verified end
to end, including against a real, genuinely messy handwritten page — see AGENTS.md
Session 22 for the full story and the honestly-reported transcription imperfections.
Phase B (PDF support) stays parked pending explicit go-ahead. See TODO.md's
Milestone 9 entry below.

**Milestone 12 is now fully complete, in an honestly-scoped final state —
Session 25.** Brave Search (Session 23's first half) was reverted in full,
superseded by Gemini's own native "Grounding with Google Search" tool. Real live
verification was attempted four times across two sessions and never succeeded —
consistently `429 RESOURCE_EXHAUSTED` across three separate free keys/accounts,
while non-grounded calls on the same keys worked instantly — pointing to
free-tier Google Search grounding requiring a billing-linked Google Cloud
project to unlock any real quota. Rather than ship on an unverifiable
assumption, the feature was rescoped to **BYOK requests with provider "gemini"
only** (shared-tier eligibility removed entirely), shipped explicitly marked
"(Experimental)" in the UI and in this history, same honesty standard as
Milestone 10 Phase C. Committed, pushed, and deployed (both Worker and
frontend), live-verified post-deploy. See TODO.md's Milestone 12 entry below
for the full story, and AGENTS.md Session 25.

**Milestone 14 (landing page + full UI/UX pass) is fully complete — Session 24.**
The general UI/UX pass was already done in Session 14; the landing page (the one item
Session 14 deliberately deferred) shipped in Session 24. See AGENTS.md Session 24.

**Milestone 9 Phase B (PDF/multi-page support for the Notes tab) planned and
approved in Session 24, ready to implement on explicit go-ahead** — no longer
blocked on anything from Milestone 12, which is now closed. Real research done,
not guessed: Gemini's actual PDF limit is 50MB/1,000 pages (confirmed live —
corrects Session 22's own recorded "100MB" claim), and the recommended design
(send the whole PDF as one `inlineData` part, same as Phase A already does for
one image) needs zero chunking/embedding pipeline changes. See AGENTS.md
Session 24 and TODO.md's Milestone 9 entry above.

Full roadmap (Milestones 7-16) in 🟢 below. Standing candidates: Milestone 9
Phase B (planned and approved, see above), Milestone 10 Phase C (BYOK
extension, parked), BYOK success-path verification for Anthropic/Grok/
OpenRouter (live-verify a real grounded answer once test keys are available —
flip out of `EXPERIMENTAL_PROVIDERS`, no other code change needed), and
milestones 15-16.

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
- [x] **Phase A — Images only, shared-Gemini OCR — Session 22.** Separate Notes tab
      (`App.tsx` tab state), structurally distinct from Documents so its local-only
      guarantee holds by construction, not just by current behavior. Strict per-file
      consent (`NotesDropZone.tsx`, built from `Button`/`StatusBanner` only, no new
      modal primitive) — no "remember my choice" shortcut, since a whole file leaving
      the browser is a bigger exception than Milestone 10's per-query toggle. OCR
      reuses Gemini's vision capability (`worker/src/providers/gemini.ts`'s
      `transcribeImage`) rather than a dedicated OCR provider — no new trust surface,
      no new API key. `OcrRequestBody` (`validate.ts`) has no `keySource`/`apiKey`
      field at all, so the endpoint is structurally shared-tier-only. Dedicated `ocr`
      rate-limit bucket (20/day) and a failure-logging path
      (`logOcrFailure`/`notifyDiscordOfOcrFailure`) that has no `message` parameter to
      forward at all — /ocr sends real note content, not a snippet, so nothing here
      can log or Discord raw provider error text the way `/answer` safely does today.
      Transcribed text flows into the same chunker/embedder pipeline as typed PDFs
      unchanged; `DocumentRecord`/`DocEntry` gain a `source` field, retrieval pools
      both sources together with a 📝/📄 badge in Sources. Live-verified end to end,
      including against a genuinely messy real handwritten page — see AGENTS.md
      Session 22 for the full story and the honestly-reported transcription
      imperfections (this is Gemini's general vision OCR, not a specialized
      handwriting-recognition benchmark — good-but-imperfect is the expected outcome).
- [ ] **Phase B (parked)** — PDF support (multi-page scans), including re-verifying
      the 15MB/20-page caps against a real large scan. Not started; needs explicit
      go-ahead.
- Documents tab stays 100% local, unchanged — see ARCHITECTURE.md's two-tab privacy
  model note

### 10. Diagram-aware Q&A
- [x] **Phase A — Local-only diagram-likely detection — Session 20.** Structural
      signal (`pdf.ts`'s `pageHasImage()`, real `pdfjsLib.getOperatorList()` check
      against `OPS.paintImageXObject`/`paintImageXObjectRepeat`/`paintInlineImageXObject`)
      OR lexical signal (`diagramHeuristic.ts`'s `isDiagramLikely()`, word-boundary
      figure/fig./diagram/chart/graph/table/illustration match) → "📊 may contain a
      diagram" hint in `QueryPanel.tsx`'s Sources list. No image ever sent, no Worker
      change. Live-verified against real generated PDFs, not just the pure function.
      Frontend only, deployed. See AGENTS.md Session 20.
- [x] **Phase B — On-demand page rendering + opt-in toggle + shared-Gemini-only
      multimodal answer path — Session 21.** `sessionFiles.ts` (in-memory File map,
      never persisted) + `pageRender.ts` (on-demand JPEG render, 1024px/q0.8) +
      `diagramImageSetting.ts` (toggle, default OFF, localStorage). Worker:
      `validate.ts`'s `ImageAttachment`/`isValidImage()` (shared-tier only, BYOK
      rejected outright), `prompt.ts`'s `hasImage`-branched instructions,
      `providers/gemini.ts`'s additive `inlineData` part. Live-verified: real Gemini
      request with an attached image before the `hasImage` prompt flag existed showed
      the model ignoring it; fixed and confirmed. See AGENTS.md Session 21.
- [ ] **Phase C (deferred)** — BYOK extension (Anthropic first, then OpenAI once its
      request shape is live-verified). Grok/OpenRouter excluded indefinitely — no
      per-model vision-capability signal exists for either today.
- Fits the existing trust model: only relevant content leaves the browser

### 11. Better retrieval ✅ COMPLETE — Session 18
- [x] **Phase A — Hybrid keyword+embedding search — Session 15.** `src/lib/bm25.ts` +
      `hybridRankChunks` in `retrieval.ts`, Reciprocal Rank Fusion (k=60). Live-verified.
- [x] **Phase B — Reranking — Session 16.** Client-side cross-encoder
      (`Xenova/ms-marco-MiniLM-L-2-v2`), `src/lib/reranker.ts` + a second model in
      `embedding.worker.ts`. Live-verified. Known follow-up: Sources list score
      display uses two inconsistent scales (RRF vs. raw logit) — future UI polish.
- [x] **Phase C1 — Frozen Doc N labels across a conversation — Session 17.**
      `assignDocLabels()` takes an `existing` param; client echoes back `docLabels`.
- [x] **Phase C2 — Client-side retrieval-query blending, prompt history, conversation
      UI — Session 18.** `src/lib/conversation.ts`'s `buildRetrievalQuery()`
      (`RETRIEVAL_HISTORY_TURNS = 1`), a new `history` field on the Worker
      (`MAX_HISTORY_TURNS = 3`), `buildPrompt()`'s "Conversation so far" section, and
      `QueryPanel.tsx`'s Conversation UI + "Clear conversation" control. Live-verified
      and deployed.

### 12. Hybrid web search toggle ✅ COMPLETE (final honest scope) — Session 25
- Single toggle ("Allow Gemini to search the web"), not three named modes — the
  model decides per-query whether search is useful, so "web-only" and "hybrid"
  collapsed into the same mechanism once passages and grounding could coexist in
  one call.
- **Brave Search API — built, reviewed, shipped Worker-only, then fully reverted in
  the same session.** The user doesn't have card access for Brave's paid API.
  Cleanly reverted (commit `01cd5e7`) — `providers/brave.ts`, the `/websearch`
  endpoint, the `WebResult`/Web N grounding mechanism, the `websearch` rate-limit
  bucket and Discord endpoint, and `BRAVE_API_KEY` are all gone, not left as dead
  code. See AGENTS.md Session 23.
- **Superseded by Gemini's own native "Grounding with Google Search" tool** — no new
  provider, no new key, reuses the existing `GEMINI_API_KEY`. `tools:
  [{"google_search": {}}]` (snake_case in the raw REST body, confirmed against
  `ai.google.dev/gemini-api/docs/generate-content/google-search`) added alongside
  the existing prompt; response gains `candidates[0].groundingMetadata` with
  `groundingChunks[].web.{uri,title}` (real structured sources — replaces the
  reverted Brave design's fabricated Web-N label scheme entirely) and
  `searchEntryPoint.renderedContent` (Google's Grounding ToS-mandated widget,
  rendered alongside any grounded result shown to an end user).
- **Item 1 (live verification) attempted four times across two sessions, never
  resolved to a clean success — `429 RESOURCE_EXHAUSTED` every time a grounded
  call was actually attempted**, across three separate free keys/accounts (a temp
  key, the production key, and a third the user checked outside this session's
  scope), while non-grounded calls on the same keys succeeded instantly. A
  diagnostic call against a different, deprecated model (`gemini-2.5-flash-lite`)
  returned a clean, different `404` — confirming the key itself is valid and
  reachable, ruling out a fully-locked account, but not resolving the grounding
  quota question either way. Waited past the documented Pacific-midnight RPD
  reset window — still `429` afterward. Raw error bodies inspected directly:
  neither attempt carried a `retryDelay` or a `QuotaFailure` detail with a quota
  metric name, so the API's own error text never actually told us RPM vs. RPD.
  **Conclusion: free-tier Google Search grounding appears to require a
  billing-linked Google Cloud project to unlock any real quota** — consistent
  with multiple reports on Google's own developer forums. See AGENTS.md Session
  25 for the full blow-by-blow.
- **Final scope, decided in light of that evidence: BYOK requests with provider
  `"gemini"` only — shared-tier eligibility removed entirely, not narrowed.**
  `worker/src/validate.ts`'s shared branch no longer carries `enableWebSearch` at
  all; a shared-tier request with it set to `true` is rejected outright with a
  400, same "don't guess, reject" pattern as every other type-enforced
  restriction in this file. `worker/src/rateLimit.ts`'s `GROUNDING_DAILY_LIMIT`
  bucket removed entirely — no longer applicable once the shared tier can never
  trigger it (removing it actually restored `rateLimit.ts` to being
  byte-identical to its pre-Milestone-12 state). `src/components/QueryPanel.tsx`'s
  `isGeminiEffective` narrowed to BYOK-gemini only; the toggle carries an inline
  "(Experimental)" label and an unverified-account caveat, matching
  `ByokPanel.tsx`'s `EXPERIMENTAL_PROVIDERS` visual treatment exactly — same
  honesty standard as Milestone 10 Phase C and the three Experimental BYOK
  providers, never live-verified against a real billing-enabled grounding call.
  235/235 worker tests, 129/129 frontend tests, `tsc`/`oxlint` clean both sides,
  production build clean. Full literal content of every changed file shown for
  review before shipping.
- **Committed (`3543d01`), pushed, and deployed — both Worker and frontend.**
  Worker live-verified post-deploy: non-grounded `/answer` unaffected
  (backward compatible), shared-tier `enableWebSearch: true` correctly rejected
  with `400` in production. Frontend deployed and bundle-hash verified against
  the live production site, including confirming the live bundle literally
  contains the new "(Experimental)" toggle copy. Revisit shared-tier eligibility
  if a billing-enabled key becomes available to complete real live verification.

### 13. Export answer/chat as PDF ✅ COMPLETE — Session 19
- [x] `src/lib/pdfExport.ts` (jsPDF, manual page-break via `ensureSpace()`) + "Export
      as PDF" button in `QueryPanel.tsx`. Full conversation exported in order; Sources
      section scoped to the current turn only. Live-verified, deployed.

### 14. Landing page + full UI/UX pass ✅ COMPLETE — Session 24
- [x] **Full UI/UX pass — Session 14.** Design system (Minimalist Swiss, light+dark,
      Inter, Phosphor icons), responsive breakpoints, dark mode, shared primitives
      applied across `App.tsx` + all 4 components. See AGENTS.md Session 14.
- [x] **Landing page — Session 24.** `src/components/LandingPage.tsx` (new, composed
      entirely from existing `Button`/Phosphor-icon/Tailwind-token primitives, no new
      dependency), shown once per browser via `src/lib/landingVisitSetting.ts`'s
      localStorage flag (mirrors `diagramImageSetting.ts`/`webSearchSetting.ts`'s
      exact pattern). `App.tsx`'s `view: 'landing' | 'app'` state computed
      synchronously from the flag at mount — a returning visitor skips landing
      deterministically. Copy (headline, how-it-works, differentiators, CTA)
      proposed and approved before implementation — the BYOK line was revised before
      approval to distinguish Gemini/OpenAI (fully supported) from
      Anthropic/Grok/OpenRouter (experimental), matching `ByokPanel.tsx`'s own
      `EXPERIMENTAL_PROVIDERS` distinction rather than presenting all five as
      equally proven. Live-verified via Playwright (installed, used, uninstalled —
      not a standing dependency; this codebase has no component-render test
      infrastructure). Frontend-only, no Worker change. Deployed and bundle-hash
      verified against the live production site. See AGENTS.md Session 24.

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
- [ ] "Clear conversation" (`QueryPanel.tsx`) resets conversation turns, the frozen
      `docLabels` map, and the current answer/results, but does NOT reset the separate
      `error` state (set when chunk retrieval itself fails, not an answer-generation
      failure) — a stale retrieval-error banner could remain visible after clearing.
      Minor, non-blocking; noted Session 18, not fixed.
- [ ] The past-turns list in the "Conversation" collapsible (`QueryPanel.tsx`) uses the
      array index as the React `key` rather than a stable id. Currently safe in
      practice (the list is append-only, only ever bulk-cleared via "Clear
      conversation," never reordered or partially removed), but is a latent
      anti-pattern if that usage ever changes. Noted Session 18, not fixed.
- [ ] `oxlint`'s `react-hooks(exhaustive-deps)` warns that `handleExportPdf`'s
      `useCallback` (`QueryPanel.tsx`) depends on `titleFor`, which is redefined every
      render rather than memoized. Pre-existing unmemoized helper, also used directly
      elsewhere in the same file. Warning only (exit 0), doesn't fail lint/build, no
      behavioral bug — the callback still works, just isn't referentially stable.
      Noted Session 19, not fixed.

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
- **Playwright's bundled Chromium ships without a PDF viewer** (Session 19 finding) —
  navigating to a local PDF, whether via `<embed type="application/pdf">`, an
  `<iframe src="file://...">`, or direct top-frame `page.goto('file://...pdf')` (even
  with `acceptDownloads:false` on the context), never renders it: the `<embed>` shows
  "Couldn't load plugin," the `<iframe>` comes up blank, and direct navigation throws
  `"Download is starting"` outright. This is deliberate on Playwright's part, not a
  bug — keeps download-triggering tests deterministic. **Workaround for visually
  verifying any generated PDF in this project:** reuse `pdf.js` (already a dependency)
  inside a real page context by importing it through Vite dev server's
  `/@fs/<absolute-path>` route (serves any on-disk file under a real `http://` origin
  the page can `import()` from), render each page to a `<canvas>`, screenshot the
  canvas. No new dependency needed. Don't re-attempt `<embed>`/`<iframe>`/direct
  navigation expecting a different result — same discipline as the `wrangler tail`
  note below.
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
