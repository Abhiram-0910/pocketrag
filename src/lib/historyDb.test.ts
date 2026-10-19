import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { describe, expect, it } from 'vitest'
import { getAllChunks, getAllDocuments, saveDocument } from './db'
import {
  HISTORY_DB_VERSION,
  STALE_PENDING_MS,
  countTurnsCiting,
  deleteAllHistory,
  deleteConversation,
  getConversations,
  getTurns,
  saveTurn,
  sweepInterruptedTurns,
} from './historyDb'
import { makeConversation, makeTurn } from './historyFixtures'

// One fake IndexedDB per test file, shared by these tests in source order (historyDb.ts's
// connection is a module-level singleton) — each test uses its own conversation ids.

describe('historyDb', () => {
  it('creates both stores in a separate pocketrag-history DB, leaving the documents DB at version 1', async () => {
    await saveDocument({ id: 'doc-a', fileName: 'a.pdf', uploadedAt: 1, chunkCount: 1, source: 'document' }, [
      { id: 'doc-a:0', documentId: 'doc-a', index: 0, text: 'chunk', tokenCount: 1, page: 1, embedding: [1], hasImage: false },
    ])

    await saveTurn(makeConversation({ id: 'c-open' }), makeTurn({ id: 't-open', conversationId: 'c-open' }))

    const history = await openDB('pocketrag-history')
    expect(history.version).toBe(HISTORY_DB_VERSION)
    expect([...history.objectStoreNames].sort()).toEqual(['conversations', 'turns'])
    history.close()
    const documents = await openDB('pocketrag')
    expect(documents.version).toBe(1)
    expect([...documents.objectStoreNames].sort()).toEqual(['chunks', 'documents'])
    documents.close()
    expect((await getAllDocuments()).map((d) => d.id)).toEqual(['doc-a'])
    expect((await getAllChunks()).map((c) => c.text)).toEqual(['chunk'])
  })

  it('round-trips a turn and its conversation', async () => {
    const turn = makeTurn({ id: 't-rt', conversationId: 'c-rt' })
    await saveTurn(makeConversation({ id: 'c-rt', activeLeafId: 't-rt' }), turn)
    expect(await getTurns('c-rt')).toEqual([turn])
    expect((await getConversations()).find((c) => c.id === 'c-rt')?.activeLeafId).toBe('t-rt')
  })

  it('never stores a grounded answer — the record has answer null and webGrounded true', async () => {
    await saveTurn(
      makeConversation({ id: 'c-g' }),
      makeTurn({ id: 't-g', conversationId: 'c-g', webGrounded: true, answer: 'Grounded text from Google Search.' }),
    )
    const [stored] = await getTurns('c-g')
    expect(stored.answer).toBeNull()
    expect(stored.webGrounded).toBe(true)
  })

  it('lists conversations most recently updated first', async () => {
    await saveTurn(makeConversation({ id: 'c-old', updatedAt: 100 }), makeTurn({ id: 't-old', conversationId: 'c-old' }))
    await saveTurn(makeConversation({ id: 'c-new', updatedAt: 9_000_000_000_000 }), makeTurn({ id: 't-new', conversationId: 'c-new' }))
    const ids = (await getConversations()).map((c) => c.id)
    expect(ids[0]).toBe('c-new')
    expect(ids.indexOf('c-old')).toBeGreaterThan(0)
  })

  it('sweeps only pending turns older than STALE_PENDING_MS to interrupted', async () => {
    const now = 10_000_000
    await saveTurn(makeConversation({ id: 'c-sw' }), makeTurn({ id: 't-fresh', conversationId: 'c-sw', status: 'pending', createdAt: now - 1000 }))
    await saveTurn(
      makeConversation({ id: 'c-sw' }),
      makeTurn({ id: 't-stale', conversationId: 'c-sw', status: 'pending', createdAt: now - STALE_PENDING_MS - 1 }),
    )
    await saveTurn(
      makeConversation({ id: 'c-sw' }),
      makeTurn({ id: 't-done', conversationId: 'c-sw', status: 'answered', createdAt: now - STALE_PENDING_MS - 1 }),
    )

    expect(await sweepInterruptedTurns(now)).toBe(1)

    const byId = new Map((await getTurns('c-sw')).map((t) => [t.id, t.status]))
    expect(byId.get('t-fresh')).toBe('pending')
    expect(byId.get('t-stale')).toBe('interrupted')
    expect(byId.get('t-done')).toBe('answered')
  })

  it('deletes one conversation and only its turns', async () => {
    await saveTurn(makeConversation({ id: 'c-del' }), makeTurn({ id: 't-del-1', conversationId: 'c-del' }))
    await saveTurn(makeConversation({ id: 'c-del' }), makeTurn({ id: 't-del-2', conversationId: 'c-del' }))
    await saveTurn(makeConversation({ id: 'c-keep' }), makeTurn({ id: 't-keep', conversationId: 'c-keep' }))

    await deleteConversation('c-del')

    expect(await getTurns('c-del')).toEqual([])
    expect((await getConversations()).some((c) => c.id === 'c-del')).toBe(false)
    expect((await getTurns('c-keep')).map((t) => t.id)).toEqual(['t-keep'])
  })

  it('countTurnsCiting counts turns with a citation of that document, across conversations', async () => {
    const cite = (documentId: string) => [{ chunkId: `${documentId}:0`, documentId, page: 1, rank: 0, score: 1 }]
    await saveTurn(makeConversation({ id: 'c-cite-1' }), makeTurn({ id: 't-cite-1', conversationId: 'c-cite-1', citations: cite('doc-x') }))
    await saveTurn(makeConversation({ id: 'c-cite-2' }), makeTurn({ id: 't-cite-2', conversationId: 'c-cite-2', citations: [...cite('doc-y'), ...cite('doc-x')] }))
    await saveTurn(makeConversation({ id: 'c-cite-2' }), makeTurn({ id: 't-cite-3', conversationId: 'c-cite-2', citations: cite('doc-y') }))
    expect(await countTurnsCiting('doc-x')).toBe(2)
    expect(await countTurnsCiting('doc-y')).toBe(2)
    expect(await countTurnsCiting('doc-none')).toBe(0)
  })

  it('deleteAllHistory clears every conversation and turn, and leaves documents alone', async () => {
    await deleteAllHistory()
    expect(await getConversations()).toEqual([])
    expect(await getTurns('c-keep')).toEqual([])
    expect((await getAllDocuments()).map((d) => d.id)).toEqual(['doc-a'])
  })
})

describe('IndexedDB upgrade atomicity (what the history DB rollback story relies on)', () => {
  it('a throw midway through a v1 -> v2 upgrade leaves the DB at v1 with its data intact', async () => {
    const v1 = await openDB('upgrade-probe', 1, { upgrade: (db) => void db.createObjectStore('keep') })
    await v1.put('keep', 'value', 'key')
    v1.close()

    await expect(
      openDB('upgrade-probe', 2, {
        upgrade(db, _old, _new, transaction) {
          // idb's wrapper rejects transaction.done with AbortError too; nothing else awaits it.
          transaction.done.catch(() => {})
          db.createObjectStore('added-before-the-throw')
          throw new Error('migration bug')
        },
      }),
    ).rejects.toThrow()

    const reopened = await openDB('upgrade-probe')
    expect(reopened.version).toBe(1)
    expect([...reopened.objectStoreNames]).toEqual(['keep'])
    expect(await reopened.get('keep', 'key')).toBe('value')
    reopened.close()
  })
})
