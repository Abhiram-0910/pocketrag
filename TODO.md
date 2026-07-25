# TODO.md — PocketRAG

Claude updates this at the end of every session.
Read this at the start of every session to know what to work on next.

---

## 🔴 Current Sprint
Milestone 4 complete: Worker deployed and live at
`https://pocketrag-answer.abhiram-dev.workers.dev`, `.env.production` points at it,
UI has an honest wait-time expectation-setter. See 🟡 Up Next for Milestone 5.

---

## 🟡 Up Next
- [ ] Deploy the frontend (Cloudflare Pages) — then set `PAGES_ORIGIN` in
      `worker/wrangler.jsonc` to the real Pages URL and redeploy the Worker
- [ ] Decide on the timeout+retry question from the Session 4 latency investigation
      (see AGENTS.md) — recommended: client-side ~60s timeout with a manual retry
      button, not a pre-warm request. Not yet implemented, needs your go-ahead.

---

## 🟢 Backlog
- [ ] Citations UI polish, landing page, styling pass
- [ ] Code-split `embedding.worker.ts` / onnxruntime-web WASM (currently a 23MB
      asset bundled eagerly) — only matters once this ships past local dev
- [ ] Restore-most-recent-document-on-load UI (explicitly deferred in Milestone 3 —
      re-dropping the file is required for now; schema already supports it via
      `documentId`, no migration needed when this gets built)
- [ ] Multi-document UI (list/switch between stored documents) — same reasoning as above
- [ ] Stronger groundedness check (Milestone 4 grill-me answer): current check only
      catches citation-level inconsistency (citing a page not in the input, or citing
      nothing without admitting the gap). Doesn't catch a real page being cited with
      misattributed content — would need a second verification LLM call or human
      review. Not built; flagged as a known limitation, not silently absent.

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
      QueryPanel, scoped to just the Gemini-wait phase (not the fast
      embed/retrieve phase) — Session 5, 2026-07-25

---

## 🐛 Known Bugs
(none currently tracked — see AGENTS.md Session 5 for the latency investigation's
open questions, which aren't quite "bugs" since the issue didn't reproduce)

---

## 💡 Ideas / Notes
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
- This dev sandbox cannot reach the live `*.workers.dev` subdomain directly (DNS
  resolves, both IPv4/IPv6 connections fail immediately) even though the base
  `workers.dev` domain and `generativelanguage.googleapis.com` are reachable —
  looks like an egress allowlist gap for this specific subdomain, not a real-world
  issue. Future sessions: test the deployed Worker through `wrangler dev` locally
  (real Gemini calls, same code) instead of curling the live URL directly.
