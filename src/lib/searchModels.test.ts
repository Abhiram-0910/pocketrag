import { describe, expect, it } from 'vitest'
import { EMBEDDING_MODEL, EMBEDDING_MODEL_KEY, RERANK_MODEL, shouldRerank } from './searchModels'

describe('search models', () => {
  it('pins both models to a full Hugging Face commit, not a branch', () => {
    for (const model of [EMBEDDING_MODEL, RERANK_MODEL]) expect(model.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(EMBEDDING_MODEL_KEY).toBe(`${EMBEDDING_MODEL.id}@${EMBEDDING_MODEL.revision}`)
  })

  it('reranks English questions only (the reranker is English-only)', () => {
    expect(shouldRerank('What do mitochondria produce?')).toBe(true)
    expect(shouldRerank('Solve 3x² - 10x + 8 = 0')).toBe(true)
    expect(shouldRerank('¿Cómo se forman las nubes?')).toBe(false)
    expect(shouldRerank('Calcula el monto final si inviertes 5.000 € al 4 % anual')).toBe(false)
    expect(shouldRerank('बादल कैसे बनते हैं?')).toBe(false)
    // Any non-Latin letter means not English, even with English words around it.
    expect(shouldRerank('What does मानसून mean?')).toBe(false)
    expect(shouldRerank('12000 × 1.08')).toBe(false)
  })
})
