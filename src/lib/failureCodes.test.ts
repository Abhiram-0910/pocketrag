import { describe, expect, it } from 'vitest'
import { FAILURE_CODES } from './apiError'
import { FAILURE_CODES as WORKER_FAILURE_CODES } from '../../worker/src/failureCodes'

// The client acts only on codes it knows (apiError.ts drops anything else), so a code
// added on the Worker side without a client copy would silently lose its action.
describe('FAILURE_CODES', () => {
  it('matches between src/lib/apiError.ts and worker/src/failureCodes.ts', () => {
    expect([...FAILURE_CODES].sort()).toEqual([...WORKER_FAILURE_CODES].sort())
  })
})
