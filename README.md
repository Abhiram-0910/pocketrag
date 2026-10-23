# PocketRAG

Local-first, browser-only "chat with your documents." Content you upload to the
**Documents tab** is parsed, embedded, and searched entirely in your browser — the
source file itself never leaves it. To answer, it sends your question, up to 3
retrieved passages, up to 3 earlier questions and answers, random document IDs (never
file names), and a page image when a question is about a chart or diagram, on the free
tier, through PocketRAG's Cloudflare Worker to the AI provider: Google Gemini on the
free shared tier, or your own provider with your own key. Each answer's Receipts list
exactly what was sent.

Free shared tier: Google uses what's sent and the answers to provide, improve and
develop its products and machine-learning technologies, and human reviewers may read
them ([Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms), "Unpaid
Services"). Use your own paid key to avoid that.

The one deliberate exception: the separate **Notes tab**, for handwritten or scanned
content, sends the whole file to Google's Gemini API for OCR — gated behind an
explicit per-file consent prompt every time, no "remember my choice" shortcut. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full two-tab privacy model.

**Live:**
- App: https://pocketrag.pages.dev
- API: https://pocketrag-answer.abhiram-dev.workers.dev

## What it does

1. Drop in a PDF, or a photo/PDF of handwritten or scanned notes.
2. Ask a question, in plain English.
3. Get a grounded answer, with citations back to the source document and page.

PDF parsing, chunking, embedding, and retrieval on the Documents tab all run
client-side (WebGPU with a WASM fallback) — the answer request (your question, a few
retrieved passages, recent conversation turns) is the only request on that path that
carries your content. The first visit also downloads the embedding and reranking
models from Hugging Face and the ONNX runtime from jsDelivr; those carry nothing from
your documents but see your IP address. Two disclosed exceptions to "nothing leaves the browser": Notes-tab OCR
(above) and an opt-in toggle that sends a page image for diagram-aware questions,
default off — see Features below for both.

## Stack

- **Frontend:** React + Vite + TypeScript + Tailwind CSS v4 + Zustand
- **In-browser ML:** `@huggingface/transformers` (embeddings), `pdf.js` (PDF parsing),
  a client-side BM25 + cosine hybrid retriever with cross-encoder reranking
- **Storage:** IndexedDB (documents, chunks, embeddings, and chat history in plain
  text; web-grounded answers are never stored — never source bytes for OCR'd notes, see
  [ARCHITECTURE.md](./ARCHITECTURE.md))
- **Answer composition:** Cloudflare Worker (TypeScript) — shared-tier Gemini by
  default, or bring your own API key
- **Deployment:** Cloudflare Pages (frontend) + Cloudflare Workers (API), both live,
  continuously deployed — no separate build/install artifact to hand off

## Features

**Fully proven** (live-verified end-to-end against production, repeatedly, across the
Milestone 16 retest):
- Shared-tier Gemini answers, with citation-level groundedness checking
- Bring-your-own-key for **Gemini** and **OpenAI** — live model-list fetch, real
  grounded answers
- Hybrid retrieval (BM25 + embeddings via Reciprocal Rank Fusion) with cross-encoder
  reranking
- Multi-document library: bulk upload, per-document and cross-document retrieval,
  restore-on-reload, delete
- Multi-turn conversations with frozen `Doc N` citation labels and retrieval-query
  blending for follow-up questions
- Handwritten/scanned notes (photos and PDFs) via OCR, with per-file upload consent
- Diagram-aware Q&A — opt-in page-image sending for questions about figures/charts
- Export a conversation as a PDF
- Receipts: every answer lists each request that carried your data — where it went,
  what it carried (question, passage and turn counts, never the text itself), its size
  and outcome, retries included — saved with the answer; a "This session" list covers
  model downloads, OCR uploads and model-list checks (see [Receipts](#receipts) below)
- Chat history: conversations saved in this browser and reopened on reload; delete one,
  all history, or everything (documents + history). Web-grounded answers are never
  stored
- Plain-language error handling (rate limits, invalid keys, network failures) and
  Discord alerting on provider failures
- Light/dark mode (OS preference), responsive down to mobile

**Experimental** — shipped, but the success path isn't independently verifiable yet,
so treat these as best-effort, not proven:
- Bring-your-own-key for **Anthropic, Grok, and OpenRouter** — fully implemented
  (same trust model as Gemini/OpenAI: key never persisted, request-scoped only), and
  their *failure* paths are live-verified (a bad key correctly produces a sanitized
  error, no key leak). Their *success* path — a real working answer — has no test key
  available yet to confirm.
- Web search grounding (Gemini's native "Grounding with Google Search," BYOK-Gemini
  only) — everything except the actual successful search call is live-verified
  (gating, UI, negative paths). The success call has consistently hit a free-tier
  Google Cloud quota limit (`429 RESOURCE_EXHAUSTED`) across every attempt so far;
  believed to require a billing-linked project to unlock.

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — codebase map, data flow, and the reasoning
  behind every non-obvious decision
- [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) — the Milestone 15 security audit
- [TODO.md](./TODO.md) — project history and what's left
