# CLAUDE.md — PocketRAG

## Project Overview
**What this project does:** Local-first, browser-only "chat with your documents" —
documents never leave the browser except the few retrieved snippets sent for final
answer composition.
**Stack:** React + Vite + TypeScript + Tailwind + Zustand, pdf.js, transformers.js,
IndexedDB, Cloudflare Worker + Gemini 3.5 Flash-Lite (`gemini-2.5-flash-lite` is no
longer available to new API keys — pinned to 3.5 instead, see ARCHITECTURE.md)
**Current phase:** MVP — Milestone 4 (answer composition) done; one manual step left
(registering a `workers.dev` subdomain) before the Worker has a public URL
**Primary goal this sprint:** Milestone 5 TBD — likely frontend deploy (Cloudflare Pages)

---

## Read These First (Every Session)
- `ARCHITECTURE.md` — codebase map, key decisions, folder structure
- `AGENTS.md` — what was done in previous sessions
- `TODO.md` — what needs to be done next

Global rules from `~/.claude/CLAUDE.md` apply to this project unless overridden below.

---

## Project-Specific Rules

### Stack Constraints
- TypeScript throughout, frontend and Worker — no plain JS files
- All embedding/model logic runs inside a Web Worker, never on the main thread
- Do not add new dependencies without asking first

### Forbidden
- Never send full document content to any server — only retrieved snippets, only
  from the answer-composition Worker call
- Never use CSS-in-JS — Tailwind only
- Never hardcode API keys — Worker secrets via Cloudflare env vars only
- Never block the main UI thread during PDF parsing or embedding

### Preferred Patterns
- Functional components, hooks only
- Zustand for cross-component state (documents, chunks, chat)
- Explicit loading/progress UI for anything that can take >200ms

---

## Workflow for This Project

### Starting a Session
1. Read AGENTS.md — understand what was done
2. Read TODO.md — pick the next task
3. Read ARCHITECTURE.md — orient yourself in the codebase
4. State your plan before writing any code
5. Confirm scope: touch only files needed for this task

### Ending a Session
1. Run all tests — fix failures before stopping
2. Run linter/type checker
3. Update AGENTS.md — what you did, what changed
4. Update TODO.md — cross off done, add new items discovered
5. Run `rtk gain` — report token savings

---

## Grill-Me Protocol
Before starting any new feature, ask these questions:
- What is the exact expected input and output?
- What are the edge cases?
- What files will be touched?
- What could break?
- Is there existing code that can be reused?

---

## Testing Requirements
- Vitest for chunking/retrieval/storage/Worker logic unit tests (frontend: `npm run test`
  at repo root; Worker: `npm run test` inside `worker/`)
- Worker tests mock KV and `fetch` — no live Gemini call or Wrangler runtime required
- Playwright is used for one-off real-browser verification each session (installed,
  used, then uninstalled — not a standing dependency; see AGENTS.md session logs)
