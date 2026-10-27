import { useEffect, useState } from 'react'
import { startRetryCountdown, type CountdownState, type RetryTiming } from '../lib/retryTiming'

/** React wrapper around startRetryCountdown (the logic and its tests live there). */
export function useRetryCountdown(timing: RetryTiming | null): CountdownState | null {
  const [state, setState] = useState<CountdownState | null>(null)
  const retryAt = timing?.retryAt ?? null
  const tick = timing?.tick ?? false
  useEffect(() => {
    if (retryAt === null) {
      setState(null)
      return
    }
    return startRetryCountdown(retryAt, tick, setState)
  }, [retryAt, tick])
  return retryAt === null ? null : state
}
