import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
  The offline builder's duplicate-key refusal, as the user meets it. The rule itself is pinned
  in build-descriptor.test.ts against the library; what can only regress HERE is that the form
  checks it before building and says so in the user's language (the library's throw is English,
  for callers that never touch this form, same as the majority rule). A source scrape, as in
  sign-key-label.test.ts.
*/
const SRC = readFileSync(join(process.cwd(), 'src/screens/VaultsScreen.tsx'), 'utf8')

describe('🚨 the offline builder refuses a key listed twice (2026-10-04)', () => {
  it('checks for a duplicated key or fingerprint BEFORE building, with a localized message', () => {
    const start = SRC.indexOf('function buildAndSave()')
    expect(start, 'buildAndSave not found — did it get renamed?').toBeGreaterThan(-1)
    const body = SRC.slice(start, SRC.indexOf('function collectKeyLabels', start))
    const check = body.indexOf('duplicateKey(')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(body.indexOf('buildVaultDescriptor('))
    expect(body).toMatch(/t\('vaults\.buildErrorDuplicateKey'\)/)
    expect(body).toMatch(/t\('vaults\.buildErrorDuplicateFingerprint'\)/)
  })
})
