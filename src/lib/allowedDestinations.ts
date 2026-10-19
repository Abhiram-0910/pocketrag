import { ORT_CDN_BASE } from '../workers/ortPin'

// Every destination public/_headers' connect-src lets this page (and its workers) send data
// to, with a plain label for the Receipts view. A compiled copy, not read from the header at
// runtime (that would need 'self' in connect-src); allowedDestinations.test.ts fails if the
// two drift apart.
export const ALLOWED_DESTINATIONS: readonly { source: string; label: string }[] = [
  { source: 'https://pocketrag-answer.abhiram-dev.workers.dev', label: "PocketRAG's server (answers, model lists, text extraction)" },
  { source: 'https://huggingface.co', label: 'AI model downloads (Hugging Face)' },
  { source: 'https://*.huggingface.co', label: 'AI model downloads (Hugging Face)' },
  { source: 'https://*.hf.co', label: "AI model downloads (Hugging Face's CDN)" },
  { source: ORT_CDN_BASE, label: 'AI runtime download (ONNX Runtime, this exact version only)' },
]
