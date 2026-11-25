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

/*
  The fixed-size builder and the read-before-save paste form (2026-11-11). The rules live in
  lib/build-descriptor.ts and lib/vault-input.ts and are tested there; what can only regress
  HERE is the form going back around them.
*/
function block(start: string, end: string): string {
  const from = SRC.indexOf(start)
  expect(from, `${start} not found — did it get renamed?`).toBeGreaterThan(-1)
  const to = SRC.indexOf(end, from + start.length)
  return SRC.slice(from, to === -1 ? undefined : to)
}

describe('the offline builder offers only the listed vault sizes', () => {
  const form = block('function BuildVaultForm(', 'function BuilderSteps(')
  it('picks the size from VAULT_SIZES and has no threshold field of its own', () => {
    expect(form).toMatch(/VAULT_SIZES\.map\(/)
    expect(form).not.toMatch(/type="number"/)
    expect(form).not.toMatch(/setThreshold\(/)
  })
  it("builds at the size's own threshold, and only when every slot is ready", () => {
    expect(form).toMatch(/buildVaultDescriptor\(\{ m: size\.m,/)
    expect(form).toMatch(/const canBuild = readyCount === size\.n/)
    expect(form).toMatch(/disabled=\{!canBuild\}/)
  })
  it('never offers a size smaller than the slots already in use', () => {
    expect(form).toMatch(/disabled=\{tooSmall\}/)
    expect(form).toMatch(/if \(next\.n < rowsInUse\) return/)
  })
})

describe('the paste form saves only what readVaultInput accepted', () => {
  const form = block('function AddVaultForm(', 'function VaultPreview(')
  it('every save goes through a successful reading', () => {
    // The one call to addVaultBackup is inside save(), which takes a VaultInput.
    expect(form.match(/addVaultBackup\(/g)?.length).toBe(1)
    expect(form).toMatch(/function save\(input: VaultInput/)
    expect(form).toMatch(/disabled=\{!ready\}/)
  })
  it('an imported file is read the same way before it is saved', () => {
    const importer = form.slice(form.indexOf('async function importFile'))
    expect(importer.indexOf('readVaultInput(')).toBeGreaterThan(-1)
    expect(importer.indexOf('readVaultInput(')).toBeLessThan(importer.indexOf('save('))
  })
})
