// Test-only fixtures for Step D's retry-hint parsing. Provenance matters here: only the
// labels below say what was seen live and what wasn't.

/**
 * RECONSTRUCTED, not captured byte-for-byte. Shape and fields as recorded in AGENTS.md
 * (Session 25): two live free-tier 429s with byte-identical bodies, status
 * RESOURCE_EXHAUSTED, no google.rpc.RetryInfo and no QuotaFailure detail — only a
 * google.rpc.Help link. The message text here is illustrative.
 */
export const GEMINI_429_RECONSTRUCTED = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.Help',
        links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }],
      },
    ],
  },
}

/**
 * DOCUMENTED shape, never observed from Gemini in this project: google.rpc.RetryInfo
 * (AIP-193), whose retryDelay is a protobuf Duration in JSON form ("37s").
 */
export const GEMINI_429_WITH_RETRY_INFO = {
  error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
  },
}

/** DOCUMENTED (OpenAI error codes): out of credit — waiting doesn't help, so no timer. */
export const OPENAI_INSUFFICIENT_QUOTA = {
  error: {
    message: 'You exceeded your current quota, please check your plan and billing details.',
    type: 'insufficient_quota',
    param: null,
    code: 'insufficient_quota',
  },
}

/** DOCUMENTED (Anthropic errors): a 429 rate_limit_error; the retry-after header is separate. */
export const ANTHROPIC_RATE_LIMIT = {
  type: 'error',
  error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit.' },
}

/** DOCUMENTED (OpenRouter errors): 402 out of credits — a rate-limit code, but no timer. */
export const OPENROUTER_402 = { error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' } }
