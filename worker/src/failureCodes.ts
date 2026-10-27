// The `code` field on every provider-failure 502 (see index.ts's classifyStatus), plus
// `region_restricted` on the shared tier's 403 (region.ts). The
// frontend keeps its own copy in src/lib/apiError.ts — src/lib/failureCodes.test.ts
// fails if the two drift.
export const FAILURE_CODES = ['key_rejected', 'provider_rate_limited', 'request_rejected', 'provider_unavailable', 'region_restricted'] as const
export type FailureCode = (typeof FAILURE_CODES)[number]
