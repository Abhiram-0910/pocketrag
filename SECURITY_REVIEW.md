# SECURITY_REVIEW.md — PocketRAG (Milestone 15)

Audit date: 2026-08-26. Checked against this project's own accumulated trust-model
decisions (AGENTS.md, ARCHITECTURE.md), not a generic checklist — see the approved
audit plan for the six claims this review is structured around. Each finding below is
logged as **claim → method → result → verdict**. No fixes are applied inline except
where explicitly noted (one severity exception, approved mid-review — see §1, Finding
1.1).

Scope note: this review covers the areas in the approved plan (secrets, docs-vs-code
trust boundaries, rate-limiting/abuse, dependencies, CORS, client-data revalidation).
It does not cover LLM prompt-injection resistance (a RAG-inherent, model-behavior
concern distinct from the trust-boundary/secret-handling scope this review targets) or
general code quality/QA issues found along the way that carry no security implication.

---

## 1. Secret-leak sweep

**Scope:** the 5 BYOK provider keys, the shared `GEMINI_API_KEY`, `DISCORD_WEBHOOK_URL`,
and — per an explicit addition to the approved plan — the Milestone 12 grounding path
(`webGrounding`/`webSources`/`searchEntryPointHtml`), traced end-to-end as the newest
code touching the request pipeline rather than assumed safe by proximity to
already-reviewed code.

### Finding 1.1 — `searchEntryPointHtml` rendered via unsanitized `dangerouslySetInnerHTML` (FIXED)

- **Claim:** the code comment at `QueryPanel.tsx`'s grounding-widget render site
  asserted `searchEntryPointHtml` is "trusted content from our own configured Gemini
  API response, not user-supplied," and rendered it via `dangerouslySetInnerHTML`
  with no sanitization step anywhere in the pipeline.
- **Method:** static trace of the full data path — `providers/gemini.ts`'s
  `extractGrounding()` reads `groundingMetadata.searchEntryPoint.renderedContent`
  straight out of Gemini's raw API response → returned unmodified through
  `callGemini()` → `index.ts`'s `handleAnswer` puts it directly into the JSON response
  → `QueryPanel.tsx` renders it raw at two sites (current-answer and past-turns
  history) via `dangerouslySetInnerHTML={{ __html: searchEntryPointHtml }}`. Confirmed
  no `dompurify`/`sanitize-html` existed in either `package.json` before this fix.
  Followed up with a time-boxed check of Google's own documentation
  (`ai.google.dev/gemini-api/docs/grounding`, `ai.google.dev/gemini-api/terms`,
  `ai.google.dev/gemini-api/docs/generate-content/google-search`) specifically for
  any statement that this widget's HTML is safe to render unsanitized, or any
  sanitization guidance.
- **Result:** Google's documentation and ToS require the widget be **displayed**
  (and forbid framing/caching/syndicating it) but say **nothing** about its safety
  for direct DOM injection — the security question is genuinely unaddressed by
  Google's own docs, not resolved either way. The existing code comment's "trusted...
  not user-supplied" framing was an unverified assumption. Given this app's specific
  threat model — an XSS in this origin has direct access to the IndexedDB store
  holding the user's full document text, i.e. the one thing this project exists to
  keep local — rendering any externally-sourced HTML unsanitized here is a real gap,
  independent of how trustworthy Google's widget is presumed to be.
- **Correction (2026-10-19, from the primary text):** "forbid framing/caching/syndicating"
  was accurate but incomplete. Re-read directly at `ai.google.dev/gemini-api/terms`
  ("Effective March 23, 2026"), section *Grounding with Google Search → Use Restrictions*:
  - **Chat-history exception:** "You may copy and store, for up to two (2) years, the
    text of the Grounded Result(s) … (2) in chat history of an end user of your
    application only for the purpose of allowing that end user to view their chat
    history." It names only *the text of the Grounded Result*.
  - **Search Suggestions and Links are not in that exception.** The general rule is "will
    not … copy, store … Grounded Results or Search Suggestions, except that…", and the
    only exception naming Search Suggestions is "solely … for the minimum time necessary
    to comply with applicable law". "Links" (URLs plus their titles/labels) are a
    separately defined term and aren't named in the chat-history exception either.
  - **Display:** "will only display the Grounded Results with the associated Search
    Suggestion(s) to the end user who submitted the prompt."
  - **No modification:** "Unless permitted by Google in writing, you: (1) will not
    modify, or intersperse any other content with, the Grounded Results or Search
    Suggestions" — DOMPurify dropping the widget's leading `<style>` is a modification
    (open item in TODO.md).
  - **End-user copies:** "You may allow end user(s) to copy and store individual Grounded
    Results that were displayed to them … as long as you do not allow Grounded Results
    to be … used to create a database."
  - **Resubmission:** storing "temporarily for the purpose of resubmitting the text of
    the Grounded Result in a subsequent prompt that you submit to Google via a function
    call to obtain a refined or improved Grounded Result" — a function-call refinement,
    not general conversation context.

  **What this project does (Phase 1, `historyDb.ts` / `chatStore.ts`), stricter than the
  exception:** a grounded answer's text is never persisted (`answer: null`,
  `webGrounded: true`; kept in memory for the session only); `searchEntryPointHtml` and
  `webSources` are never persisted; grounded answers are never sent upstream as
  `history`. **Unverified from the text:** whether showing a stored grounded answer
  without its Search Suggestions in a history view satisfies the display rule (moot here,
  since the text isn't stored); whether keeping the widget in in-memory component state
  for the session counts as "cache" (not defined); the "Client Application Guidelines"
  the terms reference (not read). `ai.google.dev/gemini-api/docs/grounding/search-suggestions`
  now redirects to `/docs/google-search`, which only says "Full usage requirements are
  detailed in the Terms of Service". Note: `QueryPanel.tsx`, not yet moved onto
  `chatStore`, still sends grounded answers as in-session `history` — Phase 2 item.
- **Verdict: GAP FOUND — FIXED INLINE as a severity exception** (approved mid-review
  rather than deferred to the batch-fix pass, since production was live with this gap
  and the fix was well-understood and low-risk).
  - **Fix:** added `dompurify` (new dependency, pre-approved for this exception) and
    a `sanitizeGroundingHtml()` helper (`src/lib/sanitizeHtml.ts`) wrapping
    `DOMPurify.sanitize()` with its default config — verified directly against
    DOMPurify's source that the default allowlist includes `<style>` tags/attributes
    (needed for the widget's light/dark CSS) while stripping `<script>`,
    event-handler attributes, and `javascript:` URIs. Applied at both render sites in
    `QueryPanel.tsx` (current-answer and past-turns history).
  - **Defense-in-depth:** added `MAX_SEARCH_ENTRY_POINT_HTML_LENGTH` (50,000 chars,
    a defensive circuit-breaker rather than an empirically measured bound — no
    sample response was available to measure against, unlike `MAX_IMAGE_BASE64_LENGTH`)
    in `providers/gemini.ts`'s `extractGrounding()`, truncating before the value
    ever reaches the client. This lives Worker-side in `gemini.ts`, not in
    `validate.ts` — `validate.ts` only shapes client-to-Worker input, and this field
    flows the other direction (Worker-to-client, sourced from Gemini's response).
  - **Tests:** `src/lib/sanitizeHtml.test.ts` (4 new tests, jsdom environment) proves
    a `<script>` tag, an `onerror` handler, and a `javascript:` URI are all stripped,
    and that benign structural/style content (the shape the real widget uses) passes
    through unchanged. `worker/src/providers/gemini.test.ts` gained one test proving
    an oversized `renderedContent` is truncated to exactly 50,000 chars.
  - **Fidelity verification:** attempted a real live BYOK-gemini grounded call against
    local `wrangler dev` with a real Gemini key to visually confirm the actual widget
    still renders correctly post-sanitization — blocked by the same pre-existing
    `429 RESOURCE_EXHAUSTED` free-tier quota limitation this project already
    documented and accepted in Milestone 12 (AGENTS.md Session 25); not a regression
    from this fix, and not something this fix could resolve. As a substitute, ran
    `DOMPurify.sanitize()` (via `jsdom`) against a realistic Search-Suggestions-widget
    HTML shape (a `<style>` block with a `prefers-color-scheme` media query, a
    `<div class="carousel">`, an `<a>` chip) and confirmed byte-for-byte identical
    output — the sanitizer does not mangle legitimate widget content of the expected
    shape. **This is not the same as confirming fidelity against Gemini's actual
    live-generated widget markup**, which remains unverified for the same reason
    Milestone 12's own grounding feature has never been live-verified — logged
    honestly here rather than overclaimed, matching this project's standing
    documentation practice for this exact feature.
  - **Verification run:** frontend 133/133 tests (was 129, +4), Worker 236/236 tests
    (was 235, +1), `tsc`/`oxlint` clean both sides, production build clean (bundle-size
    guard passes — `dompurify` added ~non-trivial but unremarkable weight, well within
    guard limits).
  - **Commit:** `9ace2ff` — "Sanitize Gemini grounding HTML and upgrade pdfjs-dist
    (Milestone 15 security review)".

### Remaining §1 checks (all provider keys, shared key, Discord)

- **Claim:** every provider key lives only in a request-scoped variable, is passed
  only via an auth header (never a URL), and is never logged or echoed to the client
  or Discord; `logProviderError`/`sendDiscordAlert` only ever carry the sanitized
  `{provider, model, status, message}` shape, never a raw request body or `apiKey`
  field.
- **Method:** read all 5 provider files in full
  (`providers/{gemini,openai,anthropic,grok,openrouter}.ts`) — confirmed each puts
  its key only in `x-goog-api-key` / `Authorization: Bearer` / `x-api-key` headers,
  never a URL, and the key parameter never gets assigned to anything outside the
  function's local scope. Read `index.ts`'s `logProviderError`, `notifyDiscordOfFailure`,
  `logOcrFailure`, `notifyDiscordOfOcrFailure`, and `discord.ts`'s `buildDiscordPayload`
  in full — confirmed `apiKey`/raw request `body` are never parameters to any of
  these functions (the OCR-specific loggers go further: no `message`/`err` parameter
  at all, by design, since OCR requests carry real note content). Cross-referenced
  against `index.test.ts`'s existing `realSecretKey`-based regression tests (lines
  402, 437, 684, 714 and others), which already encode this exact guarantee as
  automated tests — not just a one-time manual check.
  Live adversarial test: sent a distinctive fake key
  (`sk-DISTINCTIVE-FAKE-KEY-abhitest-1234567890`) against local `wrangler dev` for
  all 5 providers on both `/answer` and `/models` (10 requests total) and confirmed
  the fake key string never appeared in any response body.
- **Result:** all 10 adversarial requests passed — 502s (or one 200 from OpenRouter,
  see informational note below) with no key leakage in any response body. Static read
  confirms the same structurally, not just per this one test run. Additional live
  corroboration: `DISCORD_WEBHOOK_URL` was configured in local `.dev.vars`, so the
  same adversarial batch fired real Discord notifications — the user independently
  watched the actual Discord channel receive all 9 expected alerts (one per failed
  call: 5 providers × `/answer`, plus 4 of 5 on `/models` since OpenRouter's returned
  `200`), each showing only the sanitized `{provider, model, status, message}` shape.
  One alert (OpenAI) contained a masked partial-key fragment (`sk-DISTI***7890`) in
  its `message` field — confirmed to be OpenAI's own masked echo of the invalid key in
  their error response body (matching the fake key's first/last characters), not a
  PocketRAG-side leak: `extractFailureDetails` and `logProviderError`/`sendDiscordAlert`
  pass the provider's raw error body through as-is, and OpenAI itself truncates the key
  to a non-reversible fragment before including it — no code change indicated.
- **Verdict: PASS.**

**Informational, not a PocketRAG finding:** the OpenRouter `/models` fake-key request
returned `200` with a full real model catalog (31KB of model data), not a `401` like
the other 4 providers. This is OpenRouter's own API design — their `/v1/models`
endpoint is publicly listable without a valid key — not a gap in this project's code.
`checkRateLimit`'s `byok` bucket still gates the request either way, so this isn't an
unrestricted endpoint from PocketRAG's side; it just means an invalid BYOK key won't
be caught until the first real `/answer` call for OpenRouter specifically.

---

## 2. Docs-vs-code trust boundary reconciliation

| Claim (from ARCHITECTURE.md/AGENTS.md) | Method | Result | Verdict |
|---|---|---|---|
| Documents tab has zero network calls anywhere in its pipeline | Read `src/lib/pdf.ts`, `chunker.ts`, `embedding.worker.ts` in full | No `fetch`/network call in any of the three — confirmed structurally, not just by absence of a grep hit (traced each file's full control flow) | PASS |
| `image` restricted to shared-tier, enforced at the type level, not just a runtime `if` | Read `validate.ts`'s `ValidationResult` union in full | Confirmed: the `'shared'` branch has an `image` field, the `'own'` branch has no such field at all — a BYOK code path cannot read `validation.image` even by typo, since it doesn't exist on that branch's type. Runtime check (`validatedImage && resolvedKeySource !== 'shared'` → reject) also present, not just the type. Live-adversarially confirmed: a raw JSON request with `keySource: 'own'` + `image` attached → `400`, never reached a provider call | PASS |
| `enableWebSearch` restricted to BYOK+gemini only, same type-level rigor | Read `validate.ts`'s `ValidationResult` union | Confirmed: the `'shared'` branch has no `enableWebSearch` field at all (deliberately, per its doc comment mirroring `image`'s pattern). Two independent runtime checks exist (`resolvedEnableWebSearch && resolvedKeySource === 'shared'` → reject; `resolvedEnableWebSearch && provider !== 'gemini'` → reject). Live-adversarially confirmed both: shared-tier + `enableWebSearch: true` → `400`; BYOK+openai + `enableWebSearch: true` → `400` | PASS |
| Chunk count capped at 5, 2000 chars/chunk, enforced server-side, not just documented | Read `validate.ts`'s `validateAnswerRequest` | `chunks.slice(0, MAX_CHUNKS)` (line 224) and `chunk.text.slice(0, MAX_CHUNK_TEXT_LENGTH)` (line 233) both run before the chunks are ever used in `buildPrompt()`. Live-adversarially confirmed by sending 20 chunks with distinct `documentId`s and reading back the response's `docLabels` — exactly 5 came through, proving the cap is enforced on the actual data flow, not just present in validation logic that could theoretically be bypassed downstream | PASS |
| `MAX_OCR_BASE64_LENGTH` (21MB) left unchanged for Phase B, PDF requests checked against the same cap as images | Read `validate.ts`'s `validateOcrRequest` and `OCR_ALLOWED_MIME_TYPES` | `base64.length > MAX_OCR_BASE64_LENGTH` check applies uniformly regardless of `mimeType` — no PDF-specific carve-out or separate (larger/smaller) cap exists | PASS |
| Worker rate-limits by `CF-Connecting-IP`, not a spoofable header | Read `index.ts`'s `fetch` handler | `const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'` — this header is set by Cloudflare's edge and cannot be client-spoofed for traffic actually routed through Cloudflare (a client-supplied `CF-Connecting-IP` is overwritten at the edge). No fallback to `X-Forwarded-For` or any other client-controllable header | PASS |
| `docLabels` frozen per conversation, capped, rejected on malformed/duplicate | Read `validate.ts`'s `isValidDocLabel`/`hasDuplicateDocLabels`, `labels.ts`'s `assignDocLabels` | Capped at `MAX_DOC_LABELS` (20) via `slice`, each entry shape-checked, duplicate `documentId`/`label` both explicitly rejected (fail-closed, not "guess which to keep"). Live-adversarially confirmed both duplicate cases → `400` | PASS |

**Verdict: PASS on all 7 claims checked.** No docs-vs-code gap found this session
(unlike the 100MB PDF-limit precedent this review was specifically watching for) — the
type-level enforcement claims in particular held up under both static trace and live
adversarial bypass attempts.

**Minor observation, not logged as a finding (no security implication):** `assignDocLabels`
can output more than `MAX_DOC_LABELS` (20) entries in a single response if a
conversation's `existing` map is already near the cap and new chunks introduce several
more distinct documents in one turn — the *next* request's incoming `docLabels` then
gets silently re-capped to 20 by `validate.ts`, meaning the oldest overflow label(s)
from that response could be dropped/renumbered in a very long, many-document
conversation. This is a functional edge case (potential citation mislabeling in an
unusual scenario), not a trust-boundary or secret-handling issue, so it's out of this
review's scope — noting it here for whoever picks up general QA next, not as a
security finding.

---

## 3. Rate-limiting & abuse surface

- **Claim:** all reachable endpoints sit behind a rate-limit check before any
  provider call, using three buckets (`shared` 50/day, `byok` 500/day, `ocr` 20/day),
  and none is reachable without tripping its bucket.
- **Method:** read `index.ts`'s three handlers (`handleAnswer`, `handleModels`,
  `handleOcr`) and the top-level `fetch` dispatcher in full — confirmed the only three
  POST routes (`/answer`, `/models`, `/ocr`) each call `checkRateLimit` before any
  provider dispatch, and the `OPTIONS` preflight handler does nothing but return CORS
  headers (no provider work reachable there). Read `rateLimit.ts` in full — confirmed
  the three limit values and their documented rationale (`shared` protects this
  project's own Gemini quota; `byok`/`ocr` guard against the Worker being used as an
  anonymizing relay, sized looser since the abuser burns their own key/quota).
- **Result:** all three endpoints confirmed to call `checkRateLimit` on every request
  before any provider work; the non-atomic KV get-then-put (`ponytail:`-marked
  in `rateLimit.ts`) is an accepted, documented soft-cap tradeoff, not a silent gap —
  re-confirmed this is still accurate (no Durable Object was introduced elsewhere that
  would make this stale).
- **Live burst test:** sent 22 real requests to `/ocr` against local `wrangler dev`
  (the `ocr` bucket, limit 20 — the smallest of the three, so the fastest one to
  actually trip live) with a validation-passing but garbage image payload. Local KV
  already carried 6 counted requests from earlier in the same UTC day (Session 26's
  own live OCR verification, persisted on disk across `wrangler dev` restarts — itself
  useful corroboration that the KV counter is genuinely persistent, not just an
  in-process counter that resets on restart), so the trip landed at request 15 rather
  than 21 — consistent with, not contradicting, the 20/day limit.
- **Result:** requests 1-14 each returned `502` (Gemini genuinely called and failing
  to parse the garbage image, confirmed by exactly 14 matching `ocr_call_failed` log
  lines) at 470-494ms latency each. Every request from 15 onward returned `429` with a
  `resetAt` timestamp, at **2-3ms latency** — a ~150-200x difference that directly
  proves those requests short-circuited before any network call to Gemini, not after
  one. Zero `ocr_call_failed` log lines exist for any of the 429'd requests, confirming
  no provider call was attempted once the bucket tripped.
- **Verdict: PASS** — both the static code-path guarantee (§3 above) and a live trip
  confirm the same thing: the rate limit check provably gates the provider call, not
  just the billing/response after the fact.

---

## 4. Dependency / supply-chain check

Ran `npm audit` in both the frontend root and `worker/` (separate npm projects,
separate lockfiles, checked independently as planned) and triaged every finding
against actual reachability, per the plan's three-way outcome (not-reachable /
accepted-risk / fixed).

### Frontend

| Package | Severity | Reachable at runtime? | Notes | Verdict |
|---|---|---|---|---|
| `pdfjs-dist@6.1.200` → `6.2.108` | High — "Arbitrary JavaScript execution upon opening a malicious PDF" | **Yes** — direct runtime dependency, ships to the browser, parses every user-uploaded PDF | The one finding with real relevance to this app's actual attack surface: a user opens an arbitrary PDF (their own, but also potentially a PDF from an untrusted source if they're testing/exploring) | **GAP FOUND — FIXED** (severity exception, approved). See below for the upgrade, test, and live-verification detail. |
| `@huggingface/transformers@4.2.0` (pulls in `onnxruntime-node`, `sharp`, `adm-zip`) | High (via transitive Node-only bindings) | **No** — confirmed via `grep` that this package is imported only from `src/workers/embedding.worker.ts`, which runs exclusively in-browser (WebGPU/WASM path per ARCHITECTURE.md); the vulnerable Node-native bindings (`onnxruntime-node`, `sharp`) are optional dependencies resolved at `npm install` time but never bundled into the Vite browser build | Not-reachable in production. No fix currently published upstream for these transitive packages either way | **Accepted — not reachable.** |
| `nanoid` (via `vite` → `postcss`), `postcss` | High / Moderate | **No** — build-tooling only, never shipped to the browser bundle or the deployed Worker | Fixes available for both; cheap to pick up via a routine `npm audit fix` on `vite`'s chain but not urgent since unreachable by an attacker of the live app | **Accepted — not reachable, low-priority cleanup available.** |

### Worker

| Package | Severity | Reachable at runtime? | Notes | Verdict |
|---|---|---|---|---|
| `wrangler`, `miniflare`, `undici` | Moderate / High | **No** — all three are local CLI/dev-tooling (`wrangler dev`, local test runner), never part of the deployed Worker bundle that runs on Cloudflare's edge | The deployed Worker's actual runtime is Cloudflare's own `workerd`, not `undici`/`miniflare` — those only run on the developer's machine | **Accepted — not reachable in production.** |

### `pdfjs-dist` fix detail

- **Upgrade:** `pdfjs-dist` `6.1.200` → `6.2.108` (`npm install pdfjs-dist@6.2.108`) —
  confirmed via `npm audit` that this was the only change needed to drop the finding
  from the report (audit count went from 7 → 6 vulnerabilities, `pdfjs-dist` no longer
  listed; the remaining 6 are the pre-existing not-reachable findings above, unchanged).
  A minor version bump within major version 6, so no API surface change was expected
  for this project's usage (`GlobalWorkerOptions.workerSrc` + `getDocument()`, both
  stable pdf.js APIs) — verified rather than assumed, see live verification below.
- **Test suite:** frontend 133/133 (unchanged count — no test needed updating),
  `tsc`/`oxlint` clean, production build clean (bundle-size guard passes).
- **Live verification:** generated a synthetic two-page test PDF (via `jspdf`, already
  a project dependency) — page 1 real extractable paragraph text (distinct,
  semantically separable sentences for a real embedding/retrieval test), page 2 a
  diagram (boxes, arrows, labels: "Browser" → "Cloudflare Worker" → "Gemini API") to
  exercise the diagram-detection/image-rendering path. Drove a real browser session
  (Playwright, installed temporarily for this one-off verification and uninstalled
  after, per this project's standing practice) against the local dev server + local
  `wrangler dev`:
  - Upload accepted, text extracted correctly from both pages (verified verbatim
    against the source content, including page 2's diagram labels)
  - Chunked into 2 chunks (one per page, matching the documented per-page chunking
    architecture), embedded with zero console errors
  - Page 2 correctly flagged "📊 may contain a diagram" in the Sources list, confirming
    `isDiagramLikely` still works against `pdfjs-dist`'s post-upgrade text extraction
  - Asked a real question ("What does the document say the mitochondrion produces?")
    against the shared tier — got back a real, correctly grounded, correctly cited
    Gemini answer: *"Based on the provided document, the mitochondrion produces ATP
    through oxidative phosphorylation (Doc 1, page 1)."*, with the "Grounded in your
    documents" banner and `Doc 1 = security-review-test.pdf` legend rendering correctly
  - Zero console errors across the entire session
- **Verdict: FIXED, live-verified end to end** (upload → extraction → chunking →
  embedding → real query → real grounded answer, plus the diagram-detection path).

**Overall §4 verdict:** one real, actionable gap found (`pdfjs-dist`) — **fixed and
live-verified**. Everything else triaged as not-reachable with a traced reason,
matching the plan's "pass" bar (every finding explicitly triaged, not silently
ignored).

---

## 5. CORS & origin validation

- **Claim:** `resolveCorsOrigin()` only allows an exact match against `DEV_ORIGINS`
  or the configured `PAGES_ORIGIN`; every response path uses it (no hardcoded `*`,
  no raw-origin echo); a `null` result means no CORS headers at all, never a
  permissive fallback.
- **Method:** read `cors.ts` in full (18 lines — the whole file). Traced every `json()`
  call site in `index.ts` (all success and error paths across all three handlers, plus
  the `404` fallback and the `OPTIONS` handler) — confirmed every single one derives
  `origin` from `resolveCorsOrigin(request.headers.get('Origin'), env.PAGES_ORIGIN)`,
  computed once at the top of `fetch()` and threaded through as a parameter, never
  recomputed or bypassed in an individual handler.
- **Result (live adversarial test):** sent a request with `Origin: https://evil.example.com`
  against `/answer` — response came back with **no** `Access-Control-Allow-Origin`
  header (confirmed by inspecting the full response header set), while a matching
  `Origin: http://localhost:5173` (a `DEV_ORIGINS` entry) correctly received one in
  the earlier adversarial batch.
- **Verdict: PASS.**

---

## 6. Client-supplied data reaching a provider without server-side revalidation

- **Claim:** every client-originating field on `AnswerRequestBody`/`ModelsRequestBody`/
  `OcrRequestBody` has a server-side enforcement point independent of whatever the
  frontend's own UI would ever produce.
- **Method:** traced each field from `validate.ts`'s validation function through to
  its point of use, then live-adversarially sent raw JSON (bypassing the frontend
  entirely) violating each one:

| Field | Server-side guarantee | Live adversarial result |
|---|---|---|
| `chunks` (cap 5 / 2000 chars) | Truncated via `.slice()` before `buildPrompt()` | 20-chunk request → capped to 5 (confirmed via response `docLabels`), not rejected |
| `history` (cap `MAX_HISTORY_TURNS`=3, independent of `SENT_HISTORY_TURNS` the frontend sends) | Truncated via `.slice()`, re-capped regardless of client behavior | 10-turn request → accepted (not rejected, correctly truncated per the "app's own content, not attacker payload" reasoning) |
| `docLabels` (cap 20, shape-checked, duplicates rejected) | Rejected outright (fail-closed) on any malformed/duplicate entry | Duplicate `documentId` → `400`; duplicate `label` → `400` |
| `provider` (must be one of 5 known values) | Checked against `SUPPORTED_PROVIDERS.includes()` before any dispatch | `provider: 'evil-provider'` → `400`, never reached the `switch` dispatch |
| `image` (shared-tier only) | Rejected outright if present on a BYOK request | BYOK + `image` → `400` |
| `enableWebSearch` (BYOK+gemini only) | Rejected outright on shared tier or non-gemini BYOK | Both variants → `400` |
| `model` (BYOK, pattern-checked per provider — Step A, `85a925d`) | `GEMINI_MODEL_PATTERN` (`^[A-Za-z0-9._-]{1,128}$`) for Gemini, which puts the model in the URL path (`models/<model>:generateContent`) — no `/`, `:`, `?`, `#`, `%`. `MODEL_PATTERN` (`^[A-Za-z0-9._:/~-]{1,128}$`) for the other four, which put it in a JSON body where `/`, `:`, and OpenRouter's `~` alias prefix are real id characters. `..` is rejected for **every** provider before either pattern runs. Still not an allowlist of model ids: the user's own key on the user's own account decides what exists, so an unknown-but-well-formed id just fails at the provider (`request_rejected`). `worker/src/fixtures/openrouterModelIds.ts` (471-id snapshot of OpenRouter's public catalog, 2026-10-18, test-only) proves `MODEL_PATTERN` doesn't reject a real id | Live probes against `b612f443` (2026-10-18): path traversal (`..`) and non-ASCII model ids → `400` at validation, never reached a provider; a well-formed id passed validation and failed at the provider → `502` |
| `apiKey` (BYOK, `API_KEY_PATTERN`) | `^[\x21-\x7E]{8,200}$` — printable ASCII, no spaces, 8-200 chars. The key goes into an HTTP header; a newline or non-latin1 char makes `fetch()` throw a `TypeError` whose message can carry the header value (the key) into our own logs, so it's rejected before any fetch. The validation error never echoes the value. Only ever reaches the specific provider's own hardcoded `API_BASE` (never client-influenceable) via that provider's dedicated wrapper function | Provider allowlist (above) prevents `apiKey` from ever being routed to an unintended endpoint — the pairing of (validated `provider` → fixed `API_BASE` per provider file) means a client can't use its own key against a URL of its choosing. Newline/non-ASCII keys → `400` live (2026-10-18) |
| `mimeType` (OCR, exact allowlist) | Checked against `OCR_ALLOWED_MIME_TYPES`, exact match not a wildcard | Disallowed mimeType with extraneous `keySource`/`apiKey` fields present → `400`, confirming those extra fields are simply never read (not silently accepted then ignored downstream — genuinely absent from the type) |

- **Verdict: PASS on all fields checked.** Every client-originating field that could
  plausibly matter for a trust-boundary violation has an independent server-side
  enforcement point, verified both by reading the code and by a live adversarial
  request that bypassed the frontend entirely. No gap found in this section this
  session (this was the section flagged as highest-value in the approved plan,
  precisely because it's where "the frontend wouldn't send this" vs. "the server
  doesn't trust that it won't" gaps tend to hide).

### Step A update (2026-10-18, `85a925d`, deployed `b612f443`)

**Model lists.** OpenAI's `/models` filtering (`worker/src/providers/openai.ts`) is a
**denylist**, not an allowlist: `NON_CHAT_MODEL_PATTERN` drops embedding, moderation,
audio/TTS/transcribe/realtime, image/DALL-E/Sora, legacy completion
(`davinci`/`babbage`/`instruct`) ids and the Responses-API-only `o1-pro`/`o3-pro`/
`gpt-5-pro`/`gpt-5-codex` families. Anything new OpenAI ships passes through until
it's added. `codex-mini-latest` and `*-deep-research` are **unverified** — their docs
don't say whether Chat Completions works — and are deliberately not listed.
OpenRouter's `/models` is a public catalog that returns 200 for any key (see §1), so
`listOpenRouterModels` first calls `GET /key`, which returns 401 for a fake key
(confirmed live 2026-10-18); a bad key now fails at model fetch instead of
showing a full model list and failing on the first `/answer`.

**Error handling.** A provider's error body never reaches the client and is never
stored whole:

1. **Scrubbed at source** (`worker/src/providers/errors.ts`'s `providerError()`, the
   only way provider files throw): the body is parsed for its message and code, then
   dropped. The message is (a) exact-key scrubbed (`replaceAll(apiKey, '[redacted]')`)
   *before* truncation so a cut can't stop the key matching, then (b) capped at 200
   chars, then (c) run through the prompt-echo guard: if any 20-char window of the
   truncated text appears in the prompt, the whole message becomes
   `[withheld: echoed request content]`. The guard samples at stride 5, so an echo
   shorter than 24 chars, or one cut at the 200-char edge, can slip through. That's
   acceptable for log hygiene; the client never sees this text anyway. The provider
   code is capped at 64 chars, must match `^[\w.:-]+$`, and is dropped if it
   contains the key.
2. **`redactKeys` backstop at both sinks.** `logProviderError` (Workers Logs) and
   `notifyDiscordOfFailure` (Discord embed) run the scrubbed message through a
   pattern redactor (`sk-`/`xai-` prefixed keys including `sk-ant-`/`sk-or-`,
   `AIza…`, `Bearer …`) that catches key-shaped strings that aren't the exact key
   sent, e.g. OpenAI's masked `sk-abcd***wxyz` echo. Neither sink is passed `err`
   or `apiKey`, only the classified failure.
3. **Client sees only fixed copy.** The response body is
   `{error, code, source?}`: `error` comes from a fixed copy table keyed by
   failure code (see ARCHITECTURE.md), never provider text. HTTP status stays 502.

Live check against `b612f443`: fake keys on all 5 providers × `/answer` + `/models`
(10 requests) all returned 502 `key_rejected` with the fixed copy, with no trace of
the fake key or a planted prompt marker in any response.

---

## 7. Content-Security-Policy and security headers (Step C, 2026-10-19)

Commits `047a197` (DOMPurify 3.4.17, transformers.js pinned to exactly 4.2.0),
`2146f71` (report-only CSP + headers, ORT path pin, CSP e2e), `41931e3` (enforce).
Rolled out report-only on a Pages preview, then enforced on the preview
(`733f90e8`), then enforced in production (`8c992a01`; rollback target `f7043c66`).
The policy and the measurement behind each directive are in ARCHITECTURE.md (Step C).

**Claim:** the enforced CSP blocks exfiltration to unlisted hosts, injected inline
script, remote images and framing, without breaking any app flow.

**Method:** `e2e/step-c-csp.cjs` (12 flows, Worker calls mocked, reports read off the
`report-uri` request) on the preview and in production, plus attack controls run from
the page context (Chromium).

| Control | Preview (enforced, `733f90e8`) | Production (`8c992a01`) |
|---|---|---|
| (a) `fetch('https://example.com')` | rejected (`TypeError: Failed to fetch`); report `connect-src` blocked `https://example.com/` | same |
| (b) `fetch` to the Worker origin | 200 (mocked) | live: BYOK OpenAI with a fake key → real Worker 502 `key_rejected`, "Check your key" banner, focus to the key input |
| (c) inline `<script>` setting `window.__pwned` | not executed (`undefined`); report `script-src-elem` `inline` | same |
| (d) `<img src="https://example.com/x.png">` | not loaded; report `img-src`; request failed `csp` | not run |
| (e) framed from a second origin | refused; report `frame-ancestors`; frame ends on `chrome-error://chromewebdata/` | not run |
| e2e, Chromium (WASM) | 12/12 flows, 0 unexpected violations | 12/12, 0 unexpected |
| e2e, Chromium (WebGPU via SwiftShader) | 12/12, 0 unexpected | not run |
| e2e, Firefox 153 | 12/12, 0 unexpected | 12/12, 0 unexpected |

The only allowlisted report is Chromium's `style-src-elem` for the Gemini
search-suggestions widget's leading `<style>`, raised while DOMPurify parses it;
DOMPurify drops that `<style>` anyway, so nothing renders differently.

**Not protected / not verified:**
- **ONNX Runtime bytes on jsDelivr are not integrity-checked at runtime.** SRI was
  implemented and dropped: with a corrupted hash, onnxruntime-web re-fetched the
  `.wasm` through `XMLHttpRequest` and re-imported the `.mjs` with `import()`, and
  neither can carry a hash — embedding still completed in 3 of 4 corrupted-hash cases
  (only a corrupted `.mjs` under the enforced CSP failed, because `script-src` blocks
  the cross-origin import). A compromised file at the pinned jsDelivr path would run
  in the embedding worker with this origin's privileges (including IndexedDB); the
  enforced `connect-src` limits where it could send data to our Worker, Hugging Face,
  and that same jsDelivr path.
- **Safari/WebKit: unverified.** Playwright's WebKit needs system libraries not
  installed here. Safari also loads a different ORT pair (`ort-wasm-simd-threaded.{mjs,wasm}`).
- **Firefox worker-side violations are unobservable.** Firefox does enforce the
  policy inside the worker (a deliberately strict policy broke embedding there), but
  its worker reports never surface to Playwright, so Firefox's "0 violations" covers
  the page only.
- **No production violation collection.** `report-uri /__csp-report` points at a path
  nothing serves; real users' violations are not recorded.

**Verdict: ENFORCED, PASS** for the controls above, with the gaps listed.

DOMPurify 3.4.17 also landed here: the two advisories against 3.4.14
(GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2) affect only `IN_PLACE` mode, which this app
doesn't use (`sanitize(string)`); bumped anyway.

---

## 8. Egress ledger visibility and chat history at rest (Phase 1, 2026-10-19)

**Claim:** every request the app itself makes is recorded by `src/lib/egress.ts`, and
anything it can't record is bounded by the enforced CSP.

**Method:** routed `/answer`, `/models`, `/ocr` through `egressFetch()` and set
transformers.js's `env.fetch` to `downloadFetch()` in the embedding worker (traced in
`node_modules/@huggingface/transformers/src`: `utils/hub.js` `getFile()` and
`backends/utils/cacheWasm.js` both call `env.fetch`). `egress.test.ts` calls each real
request builder with only `fetch` stubbed and asserts the exact recorded categories.
`egress.bypass.test.ts` scans `src/` for raw network calls; it was shown failing on a
temporarily added `fetch(` in `src/lib/retrieval.ts`, then passing after the revert.
`e2e/step-c-csp.cjs` (local `wrangler pages dev`, Chromium WASM): 12/12 flows, 0
unexpected violations, ORT `.wasm`/`.mjs` still loaded from the pinned jsDelivr path
through the wrapped `env.fetch`.

**What the ledger cannot see**, and what bounds it:

| Not recorded | Why | Bound |
|---|---|---|
| ORT fallback re-fetch (`XMLHttpRequest`) and re-import (`import()`) after a failed cached load (§7) | onnxruntime-web's own code, not `env.fetch` | `connect-src` allows only the pinned jsDelivr path; `script-src` blocks the cross-origin `import()` |
| Intermediate redirect hops | `fetch` follows them; only the first and final URL are visible | every hop must be in `connect-src` (`*.hf.co`) |
| CORS preflight (`OPTIONS`) before each Worker POST | browser-initiated: `Content-Type: application/json` makes every POST non-simple, and `worker/src/cors.ts` sends no `Access-Control-Max-Age`, so Chromium re-checks after ~5 s. No body; it reveals the origin, the method and the header names | same Worker origin in `connect-src`; carries no user data |
| Same-origin browser loads (app shell, bundles, fonts, pdf.js worker) | browser-initiated | `'self'` only; no user data |
| Navigations (clicked web-source links, `window.open`) | not network calls the app makes | **not bounded by CSP** (`navigate-to` was dropped from the spec) |
| WebRTC | not used by the app | **not bounded by CSP** |
| `CrossOriginStorageCache.js`'s raw `fetch` in transformers.js | not via `env.fetch` | `connect-src`; believed off by default — **unverified** |

The ledger is the app's own account of what it sent; the CSP is the hard bound. A
Phase 2 e2e will reconcile them (every cross-origin request Playwright observes must
match a ledger record).

**Chat history at rest:** `pocketrag-history` stores questions and (non-grounded) answers
**in plaintext** in IndexedDB, like the document text and embeddings already in
`pocketrag`. Anyone with access to the browser profile can read it, and so can any script
running in this origin. The XSS mitigation is the enforced CSP (§7: no inline script, no
`'unsafe-eval'`, `connect-src` limiting where stolen data could go) plus rendering every
answer as a React text node — a restored answer containing `<img onerror>` renders as
escaped text (`chatStore.test.ts`). Nothing is encrypted at rest; a key held by the same
origin wouldn't stop a script running in it.

**Phase 2a update (2026-10-19, Worker `483afdc9`, Pages not redeployed).** Per-turn
egress plumbing (`chatStore.appendEgress`, `egressFetch`'s `onRecord`), payload counts,
and a 200-record cap on the session log — which, enforced in `recordEgress`, never takes
an `/answer` record. Until the UI passes `onEgress` (Phase 2b), the shipped `QueryPanel`'s
answer requests are therefore recorded nowhere; nothing displayed them before either. The
Worker now echoes `{provider, model}` on a 200 `/answer`. That echo, like the "forwarded
to" host, is **the Worker's own report** of what it did — the browser can't observe the
hop to the provider — and the client drops a malformed one (`parseServedBy`). Live check
against `483afdc9`: one shared-tier `/answer` → `200`, `"provider":"gemini","model":"gemini-3.5-flash-lite"`.

**Phase 2b update (2026-10-19, Pages preview `41d6f8c8` only; production Pages NOT
redeployed — still `8c992a01`).** The Receipts UI renders each turn's persisted egress and
the session log. `e2e/step-c-csp.cjs` now reconciles every cross-origin request the browser
made against the Receipt / This-session rows read off the DOM (`data-host`,
`data-final-host`); local `wrangler pages dev`, 15 flows:

| | Chromium (WASM) | Firefox |
|---|---|---|
| Observed requests (redirect chains counted once) | 25 (4 `huggingface.co` → `*.hf.co` chains) | 25 (4 chains) |
| Ledger rows in the DOM | 25, of which 14 recorded inside the embedding worker | 25, 14 from the worker |
| Matched / unmatched / ledger rows not observed | 25 / 0 / 0 | 25 / 0 / 0 |
| CORS preflights observed | 0 | 0 |
| Unexpected CSP violations | 0 | 0 |

That closes the earlier gap: **the worker → main-thread egress path is now verified in a
real browser** (the worker's download records reach the This-session DOM and match the
network requests). Playwright's Firefox does surface the dedicated worker's requests too.

**Not verified:** CORS preflights — with the Worker route-mocked, Playwright surfaced no
`OPTIONS` requests on either browser, so the preflight pairing check ran but had nothing
to pair; real preflights against the live Worker are not observed by any test. Firefox's
worker-side CSP *reports* remain unobservable (§7). Safari/WebKit: unverified. The `quota`
and `blocked` storage banners were only screenshotted with simulated triggers (Chromium's
quota override had no effect here; `blocked` can't occur at history v1); their store
handling is unit-tested.

**Verdict: PASS, with the listed gaps.**

---

## Summary

| # | Area | Verdict | Action |
|---|---|---|---|
| 1.1 | `searchEntryPointHtml` unsanitized `dangerouslySetInnerHTML` | **GAP FOUND — FIXED** | DOMPurify + length cap + tests, live corroborated via Discord alert inspection; pending commit |
| 1 (rest) | Provider/shared/Discord key handling | PASS | none |
| 2 | Docs-vs-code trust boundary claims (7 checked) | PASS | none (one non-security functional observation noted, not a finding) |
| 3 | Rate-limiting & abuse surface | PASS | live burst test run (§3) — trip confirmed at ~150-200x latency difference, no provider call once tripped |
| 4 | Dependency/supply-chain | **GAP FOUND — FIXED** (`pdfjs-dist` 6.1.200 → 6.2.108) | upgraded, full test suite green, live-verified end to end with a real PDF including diagram detection; 6 other findings triaged not-reachable |
| 5 | CORS & origin validation | PASS | none |
| 6 | Client-supplied data reaching a provider without revalidation | PASS | none |
| 7 | Content-Security-Policy & security headers (Step C) | **ENFORCED — PASS, with listed gaps** | production `8c992a01`; ORT bytes not integrity-checked, Safari unverified, Firefox worker reports unobservable, no production violation collection |
| 8 | Egress ledger visibility, chat history at rest (Phase 1, 2a, 2b) | **PASS, with listed gaps** | Worker echo live (`483afdc9`); history + Receipts UI on a Pages preview only (production not redeployed); every observed request reconciled to a ledger row on Chromium and Firefox; CORS preflights not recorded and not observed under mocks; navigations/WebRTC outside CSP; history plaintext at rest; Safari unverified |

**Status: audit complete, both gaps found this session are fixed, verified, and
committed (`9ace2ff`).** Nothing outstanding from the approved plan. Re-confirmed
current as of the Milestone 16 retest (Sessions 28-31): both fixes remain live in
production, no new dependency/CORS/trust-boundary drift found in later sessions.
