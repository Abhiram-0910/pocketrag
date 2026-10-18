import { describe, expect, it } from 'vitest'
import byokPanelSource from './ByokPanel.tsx?raw'
import { EXPERIMENTAL_PROVIDERS as WORKER_EXPERIMENTAL } from '../../worker/src/validate'

// The Worker keeps its own copy (picks the "isn't fully supported yet" copy and gates
// Discord alerts); ByokPanel's drives the "(Experimental)" label. Promoting a provider
// means editing both — this fails if only one changes. Read from source rather than
// exported, since exporting a non-component array from ByokPanel.tsx breaks Fast Refresh.
function frontendExperimentalProviders(): string[] {
  const match = byokPanelSource.match(/const EXPERIMENTAL_PROVIDERS: Provider\[\] = \[([^\]]*)\]/)
  if (!match) throw new Error('EXPERIMENTAL_PROVIDERS declaration not found in ByokPanel.tsx')
  return [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
}

describe('EXPERIMENTAL_PROVIDERS', () => {
  it('matches between ByokPanel.tsx and worker/src/validate.ts', () => {
    const frontend = frontendExperimentalProviders()
    expect(frontend.length).toBeGreaterThan(0)
    expect(frontend.sort()).toEqual([...WORKER_EXPERIMENTAL].sort())
  })
})
