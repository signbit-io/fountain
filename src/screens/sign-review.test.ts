import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
  The Sign screen's review panel: what it shows, and what it does when it cannot show it.
  Source scrapes, as in sign-key-label.test.ts — this repo tests logic, not rendering, and the
  logic these guard (psbt-decode.ts, key.ts signPsbt) is pinned by its own tests. What can only
  regress HERE is the wiring between that logic and the screen.
*/

const SRC = readFileSync(join(process.cwd(), 'src/screens/SignScreen.tsx'), 'utf8')
const UI = readFileSync(join(process.cwd(), 'src/components/ui.tsx'), 'utf8')

/** The JSX block from `start` to the end of the element it opens. */
function block(start: string, end: string): string {
  const at = SRC.indexOf(start)
  expect(at, `${start} not found — did it get renamed?`).toBeGreaterThan(-1)
  return SRC.slice(at, SRC.indexOf(end, at + start.length) + end.length)
}

describe('🚨 a PSBT the review refuses is a PSBT this screen will not sign (2026-10-04)', () => {
  /*
    The decode's refusal used to be dropped (`return null`): the panel vanished, no error was
    shown, and the Sign button stayed live, so a single edited field turned the review off.
  */
  it('shows the refusal, with its reason, where the panel would be', () => {
    expect(SRC).toMatch(/t\('sign\.decodeRefused'\)/)
    expect(SRC).toMatch(/\{review\.reason\}/)
  })

  it('disables the Sign button while the review refuses', () => {
    const button = block('onClick={run}', '>')
    expect(button).toMatch(/disabled=\{[^}]*\brefused\b/)
  })

  it('run() refuses too, so no other path reaches signPsbt with a refused PSBT', () => {
    const run = SRC.slice(SRC.indexOf('function run()'), SRC.indexOf('async function importFile'))
    expect(run).toMatch(/mode === 'psbt' && refused/)
  })
})

describe('🚨 the recipient address is shown in full (2026-10-04)', () => {
  /*
    The panel truncated the address to one ellipsized line beside the badge and the amount:
    2 to 14 characters on a phone, the checksum never. A vanity address matching the first
    few characters then passed the one review this app exists to give.
  */
  it('never truncates the address', () => {
    const line = SRC.split('\n').find((l) => l.includes('{o.address}'))
    expect(line, 'the address line').toBeDefined()
    expect(line).not.toMatch(/\btruncate\b|text-ellipsis|whitespace-nowrap|overflow-hidden/)
    // ...and the Mono it renders through wraps anywhere, which a bech32 string needs.
    expect(UI).toMatch(/export function Mono[\s\S]*?break-all/)
  })

  it('puts the amount on its own line on a phone', () => {
    const row = block('{decoded.outputs.map((o, i) => (', '>')
    expect(row).toMatch(/flex-col/)
    expect(row).toMatch(/sm:flex-row/)
  })
})

describe('the degraded note says WHY change cannot be told apart', () => {
  it('a saved vault without a change descriptor is not reported as an unsaved vault', () => {
    expect(SRC).toMatch(/matchedVaults > 0[\s\S]{0,200}t\('sign\.decodeNoChangeDescriptor'\)/)
  })
})
