import 'fake-indexeddb/auto'
import { deleteDB, openDB } from 'idb'
import { describe, expect, it } from 'vitest'
import { getConversations, onHistoryDbEvent } from './historyDb'

// Isolated file: these tests control when historyDb.ts's singleton connection first opens.
describe('historyDb connection lifecycle', () => {
  it("doesn't cache a failed open: a VersionError, then the next call succeeds", async () => {
    // A newer version already on disk, e.g. after rolling back to an older build.
    ;(await openDB('pocketrag-history', 2)).close()
    await expect(getConversations()).rejects.toThrow()

    await deleteDB('pocketrag-history')
    expect(await getConversations()).toEqual([])
  })

  it('closes its connection when another tab opens a newer version, and reports it', async () => {
    const events: string[] = []
    onHistoryDbEvent((e) => events.push(e))
    await getConversations()

    // Would wait forever if this tab kept its v1 connection open.
    const newer = await openDB('pocketrag-history', 2)
    expect(events).toEqual(['blocking'])
    newer.close()
  })
})
