import { describe, expect, it, vi } from 'vitest'
import { resolveBackend } from './backend'

describe('resolveBackend', () => {
  it('reports wasm-unavailable when navigator.gpu is not present', async () => {
    const createExtractor = vi.fn().mockResolvedValue('wasm-extractor')
    const result = await resolveBackend(undefined, createExtractor)

    expect(result.backend).toBe('wasm-unavailable')
    expect(result.detail).toMatch(/not present/)
    expect(result.extractor).toBe('wasm-extractor')
    expect(createExtractor).toHaveBeenCalledWith('wasm')
    expect(createExtractor).toHaveBeenCalledTimes(1)
  })

  it('reports wasm-unavailable when requestAdapter() resolves null', async () => {
    const gpu = { requestAdapter: vi.fn().mockResolvedValue(null) }
    const createExtractor = vi.fn().mockResolvedValue('wasm-extractor')
    const result = await resolveBackend(gpu, createExtractor)

    expect(result.backend).toBe('wasm-unavailable')
    expect(result.detail).toMatch(/returned null/)
    expect(createExtractor).toHaveBeenCalledWith('wasm')
  })

  it('reports wasm-unavailable when requestAdapter() throws', async () => {
    const gpu = { requestAdapter: vi.fn().mockRejectedValue(new Error('driver crash')) }
    const createExtractor = vi.fn().mockResolvedValue('wasm-extractor')
    const result = await resolveBackend(gpu, createExtractor)

    expect(result.backend).toBe('wasm-unavailable')
    expect(result.detail).toMatch(/threw: driver crash/)
    expect(createExtractor).toHaveBeenCalledWith('wasm')
  })

  it('reports webgpu when an adapter is acquired and pipeline init succeeds', async () => {
    const gpu = { requestAdapter: vi.fn().mockResolvedValue({}) }
    const createExtractor = vi.fn().mockResolvedValue('webgpu-extractor')
    const result = await resolveBackend(gpu, createExtractor)

    expect(result.backend).toBe('webgpu')
    expect(result.extractor).toBe('webgpu-extractor')
    expect(createExtractor).toHaveBeenCalledWith('webgpu')
    expect(createExtractor).toHaveBeenCalledTimes(1)
  })

  it('reports wasm-failed when an adapter is acquired but pipeline init throws, and falls back', async () => {
    const gpu = { requestAdapter: vi.fn().mockResolvedValue({}) }
    const createExtractor = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsupported op on this adapter'))
      .mockResolvedValueOnce('wasm-extractor')
    const result = await resolveBackend(gpu, createExtractor)

    expect(result.backend).toBe('wasm-failed')
    expect(result.detail).toMatch(/unsupported op on this adapter/)
    expect(result.detail).toMatch(/fell back to WASM/)
    expect(result.extractor).toBe('wasm-extractor')
    expect(createExtractor).toHaveBeenNthCalledWith(1, 'webgpu')
    expect(createExtractor).toHaveBeenNthCalledWith(2, 'wasm')
    expect(createExtractor).toHaveBeenCalledTimes(2)
  })
})
