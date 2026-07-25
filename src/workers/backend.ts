import type { BackendState } from './embedding.types'

export interface GpuLike {
  requestAdapter(): Promise<unknown>
}

/**
 * Distinguishes WebGPU being unavailable (no adapter) from WebGPU being available
 * but failing at pipeline init — the two report different `BackendState`s so a
 * silent numerical fallback never looks the same as a hard failure.
 */
export async function resolveBackend<T>(
  gpu: GpuLike | undefined,
  createExtractor: (device: 'webgpu' | 'wasm') => Promise<T>,
): Promise<{ extractor: T; backend: BackendState; detail: string }> {
  if (!gpu) {
    return {
      extractor: await createExtractor('wasm'),
      backend: 'wasm-unavailable',
      detail: 'navigator.gpu is not present in this browser',
    }
  }

  let adapter: unknown = null
  let adapterError: string | null = null
  try {
    adapter = await gpu.requestAdapter()
  } catch (err) {
    adapterError = err instanceof Error ? err.message : String(err)
  }

  if (!adapter) {
    return {
      extractor: await createExtractor('wasm'),
      backend: 'wasm-unavailable',
      detail: adapterError
        ? `requestAdapter() threw: ${adapterError}`
        : 'requestAdapter() returned null (no compatible GPU adapter)',
    }
  }

  try {
    return {
      extractor: await createExtractor('webgpu'),
      backend: 'webgpu',
      detail: 'WebGPU adapter acquired and pipeline initialized',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      extractor: await createExtractor('wasm'),
      backend: 'wasm-failed',
      detail: `WebGPU adapter was available but pipeline init failed: ${message} — fell back to WASM`,
    }
  }
}
