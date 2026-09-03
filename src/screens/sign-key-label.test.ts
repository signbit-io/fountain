import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
  The Sign screen names the key that produced a signature ("Co-signed with X"). On a vault
  where one holder runs several keys — the 3-of-5 case this app exists for — "Co-signed"
  alone does not say WHICH, so a keyholder cannot tell what they still owe without decoding
  the PSBT again.

  🚨 THE TRAP THIS FILE GUARDS (caught in review, 2026-08-16): the obvious implementation
  reads the key PICKER at render time. The picker stays live after signing, so changing the
  dropdown afterwards silently relabels an already-produced signature with a key that had
  nothing to do with it — on the one screen whose whole job is saying which key signed.

  The label must be CAPTURED AT SIGNING TIME and stored with the output, then cleared
  whenever the output is. A source scrape, since this repo tests logic rather than rendering
  (the keystore.tsx wiring is hand-checked by the same rule — see §9).
*/

const SRC = readFileSync(join(process.cwd(), 'src/screens/SignScreen.tsx'), 'utf8')

describe('the signing key label is a property of the OUTPUT, not the picker', () => {
  it('captures the label at signing time', () => {
    // setOutput(result, activeKey.label) — recorded when the signature is produced.
    expect(SRC).toMatch(/setOutput\(result,\s*activeKey\.label\)/)
  })

  it('renders from the captured label, never from the live picker', () => {
    /*
      The actual bug: `activeKey.label` inside the result Alert follows the dropdown. Only
      `signedWithLabel` is a fact about the signature that exists.
    */
    // ⚠️ The opening tag is on its own line (the ternary spans several), so match the
    // BLOCK from the tag to its close rather than an inline substring.
    const start = SRC.indexOf('<Alert kind="ok">')
    const alert = SRC.slice(start, SRC.indexOf('</Alert>', start))
    expect(alert).toContain('signedWithLabel')
    expect(alert).not.toContain('activeKey.label')
  })

  it('clears the label with the output, on every path that clears it', () => {
    // setOutput ties them together...
    expect(SRC).toMatch(/signedWithLabel: v \? signedWithLabel : undefined/)
    // ...and the mode switch, which sets output directly, must clear it too or a previous
    // signature's key name outlives the signature itself.
    expect(SRC).toMatch(/mode: m, input: '', output: '', signedWithLabel: undefined/)
  })
})
