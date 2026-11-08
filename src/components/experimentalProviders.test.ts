import { describe, expect, it } from 'vitest'
import byokPanelSource from './ByokPanel.tsx?raw'
import { EXPERIMENTAL_PROVIDERS as WORKER_EXPERIMENTAL } from '../../worker/src/validate'

// The Worker keeps its own copy (picks the "isn't fully supported yet" copy and gates
// Discord alerts); ByokPanel's drives the "(Experimental)" label. The label may drop a
// provider before the Worker does (a Pages-only promotion: Anthropic in v1.0.1, Worker
// unchanged), never the reverse. Read from source rather than exported, since exporting a
// non-component array from ByokPanel.tsx breaks Fast Refresh.
function frontendExperimentalProviders(): string[] {
  const match = byokPanelSource.match(/const EXPERIMENTAL_PROVIDERS: Provider\[\] = \[([^\]]*)\]/)
  if (!match) throw new Error('EXPERIMENTAL_PROVIDERS declaration not found in ByokPanel.tsx')
  return [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
}

describe('EXPERIMENTAL_PROVIDERS', () => {
  it("ByokPanel.tsx's list is a subset of worker/src/validate.ts's", () => {
    const frontend = frontendExperimentalProviders()
    expect(frontend.length).toBeGreaterThan(0)
    for (const p of frontend) expect(WORKER_EXPERIMENTAL).toContain(p)
  })

  it('Anthropic is verified (Phase 6): no Experimental label', () => {
    expect(frontendExperimentalProviders()).not.toContain('anthropic')
  })
})
