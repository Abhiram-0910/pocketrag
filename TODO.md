# TODO.md — PocketRAG

Claude updates this at the end of every session.
Read this at the start of every session to know what to work on next.

---

## 🔴 Current Sprint
Milestone 5 complete: full app live in production.
- Frontend: https://pocketrag.pages.dev (Cloudflare Pages)
- API: https://pocketrag-answer.abhiram-dev.workers.dev (Cloudflare Worker)
Verified end-to-end against the real deployed site (not local dev): drop a PDF, ask a
real question, get a real Gemini-composed answer with correct page citation, zero
console errors.

Full roadmap (Milestones 6-16) written up in 🟡/🟢 below per user request, so it
survives a context reset. Currently awaiting confirmation to start Milestone 6.

---

## 🟡 Up Next
### Milestone 6 — Multi-document + bulk upload (current target)
- [ ] Document list/picker UI — the multi-doc UX explicitly deferred back in
      Milestone 3, now in scope
- [ ] Bulk drag-and-drop: multiple PDFs at once, per-file progress, one failing file
      does not block the others
- [ ] Error-row action in the document list: retry and/or remove for a failed file.
      Deferred from Commit 2 (list UI) — acceptable while single-file, but bulk upload
      makes partial failure the normal case, so this needs a real decision by Commit 4,
      not a silent gap.
- [ ] Retrieval scope toggle: "this document" vs "all documents" for a query
- [ ] Restore-on-reload — natural now that a real document list exists; schema
      already supports it via `documentId` (Milestone 3 decision), no migration needed
- [ ] Call `navigator.storage.persist()` when the first document is saved — protects
      against browser storage eviction (Safari's 7-day-inactivity proactive eviction
      is the real risk at personal scale, not raw storage size — see AGENTS.md
      Session 6 grill-me answer for the numbers)
- [ ] Tests for multi-document ranking: retrieval scoped to one document must not
      leak chunks from another

---

## 🟢 Backlog — Milestones 7-16, in order

### 7. BYOK (bring your own key)
- Providers: Gemini, OpenAI, Anthropic, Grok, OpenRouter
- Never persist keys anywhere — no KV, no DB, no logs. In-memory for one request only.
- Model lists fetched live from each provider's own list-models endpoint, not hardcoded

### 8. Error UX overhaul
- Plain-language error taxonomy: rate limit (with exact reset time in the user's
  local timezone), invalid key, model unavailable, network error, unreadable PDF,
  WebGPU unsupported, etc.

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
- Hybrid keyword+embedding search
- Reranking
- Multi-turn conversation context

### 12. Hybrid web search toggle
- Modes: notes-only / web-only / hybrid
- Brave Search API

### 13. Export answer/chat as PDF

### 14. Landing page + full UI/UX pass

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

---

## 🐛 Known Bugs
(none currently tracked)

---

## 💡 Ideas / Notes
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
