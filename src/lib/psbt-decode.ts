import * as ecc from '@bitcoinerlab/secp256k1'
import * as descriptors from '@bitcoinerlab/descriptors'
import { bitcoinNetwork, type NetworkName } from './bitcoin-network.js'
import { changeDescriptorBelongsTo } from './vaults.js'

/*
  Pre-sign PSBT decode — the human-readable "here's what you're about to authorize" summary
  shown right before the Sign button (the "File import is TEXT-ONLY" security note: the real
  PSBT threat is SEMANTIC — a well-formed PSBT paying a different address/amount than the user
  agreed to — not a malformed/executable file, which is already handled by text-only parsing).

  This is DISPLAY-ONLY: it never alters signing, never trusts any label IN the PSBT, and
  computes everything (destination, amount, fee, change) independently from the PSBT's own
  bytes + (when available) the vault's cached change descriptor — the same script-membership
  approach the SignBit platform signer uses server-side (derive the vault's own scripts,
  classify by membership), just running client-side against lib/vaults.ts's local cache
  instead of a synced descriptor.

  🚨 **AND WHAT IT REFUSES, `signPsbt` REFUSES** (2026-10-04). `key.ts` runs `decodePsbt` with
  the signing key's fingerprint before it signs anything, so a PSBT this panel cannot show is a
  PSBT the library cannot sign. The screen dropping a refusal used to turn the review off.

  Degraded mode: if this app has no cached descriptor for the vault the PSBT belongs to (or no
  descriptor was supplied at all), outputs/amounts/fee are still shown (always derivable from
  the PSBT alone) but every output is marked change:'unknown' rather than guessed — never trust
  a label, and never silently mis-classify recipient vs change when we can't be sure.
*/

const { Output, Psbt } = descriptors
// createBitcoinjsLib's .d.ts only declares toOutputScript; fromOutputScript exists at runtime.
const bjs = descriptors.createBitcoinjsLib(ecc) as unknown as {
  address: { toOutputScript: (a: string, n: unknown) => Uint8Array; fromOutputScript: (s: Uint8Array, n: unknown) => string }
  Transaction: {
    fromBuffer: (b: Uint8Array) => { getHash: () => Uint8Array; outs: { script: Uint8Array; value: bigint }[] }
  }
}

/*
  The bounded FALLBACK for an index nobody named — never the primary way a script is found.

  🚨 **IT USED TO BE A DEADLINE** (fixed 2026-10-04). Inputs were matched on receive indices
  0-99 only and change on change indices 0-99 only, so a spend funded from CHANGE (the normal
  state after a vault's first spend) matched nothing and showed every output "Unknown", where
  an attacker output looks like any other; and change at index ≥ 100 read as a Recipient. Every
  vault walks into that line, one index per spend.

  Now an input or output that NAMES its index (its `bip32Derivation`; the platform writes one
  on every input, Sparrow on its change outputs too) is checked at that index first, one
  derivation, any depth. The scan below is only for a script that names nothing.
*/
const SCAN_WINDOW = 100

export type DecodedOutput = {
  address: string
  amountSats: number
  /** 'unknown' when no change descriptor was available to classify against (degraded mode). */
  change: 'recipient' | 'change' | 'unknown'
}

export type DecodedPsbt = {
  outputs: DecodedOutput[]
  /** Sum of input values minus sum of output values. */
  feeSats: number
  /** False in degraded mode: change classification was skipped (no cached change descriptor). */
  changeClassified: boolean
  /**
   * True when the fee is a WILDLY implausible share of what is being spent — the shape a
   * value-understating PSBT takes once the lie is subtracted. See `FEE_ALARM_RATIO`.
   */
  feeLooksWrong: boolean
}

/*
  Fee-sanity threshold: a fee above this share of total input value is flagged, not blocked.

  ⚠️ WHY A RATIO AND NOT A CAP: every input's value is now PROVEN by its previous transaction
  (see `inputValue`), so this is a last sanity flag, not the defence: half the input value going
  to miners has no honest explanation, whatever produced it.

  Deliberately advisory. Flag loudly, let the user decide.
*/
const FEE_ALARM_RATIO = 0.5

export type DecodeError = { reason: string }

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex')

/*
  Scripts derived from a public descriptor, memoised across decodes. The panel re-decodes on
  every keystroke, and a descriptor at an index always derives the same script, so this is
  pure caching of public data. Bounded so a long session cannot grow it without limit.
*/
const derived = new Map<string, string | null>()
const MAX_DERIVED = 20_000

/** The script `descriptor` derives at `index` (hex), or null when it cannot derive there. */
function scriptAt(descriptor: string, index: number, net: NetworkName): string | null {
  const key = `${net}|${index}|${descriptor}`
  let h = derived.get(key)
  if (h === undefined) {
    try {
      h = hex(new Output({ descriptor, index, network: bitcoinNetwork(net) as never }).getScriptPubKey())
    } catch {
      h = null
    }
    if (derived.size >= MAX_DERIVED) derived.clear()
    derived.set(key, h)
  }
  return h
}

type Derivation = { masterFingerprint: Uint8Array; path?: unknown }

/** Does any derivation in this list name `fingerprint`? */
function namesKey(derivations: Derivation[] | undefined, fingerprint: string | undefined): boolean {
  if (!fingerprint || !derivations) return false
  const fp = fingerprint.toLowerCase()
  return derivations.some((d) => hex(d.masterFingerprint) === fp)
}

/*
  The derivation indices an input or output CLAIMS, read from its `bip32Derivation` paths.

  🚨 **A CLAIM IS TRUSTED FOR NOTHING.** It picks which index to derive; the verdict is a
  byte-for-byte comparison against what the vault's OWN descriptor derives there. A wrong or
  hostile index matches nothing and falls through to the bounded scan. Plain decimal digits
  only (a hardened `137'` is not index 137), below the hardened range, at most four distinct
  values so a padded map cannot buy unbounded derivation. Mirrors the platform signer.
*/
const MAX_CLAIMED_INDICES = 4

function claimedIndices(entry: { bip32Derivation?: Derivation[] } | undefined): number[] {
  const out: number[] = []
  for (const d of entry?.bip32Derivation ?? []) {
    if (typeof d?.path !== 'string') continue
    const last = d.path.split('/').pop()
    if (last == null || !/^\d+$/.test(last)) continue
    const i = Number(last)
    if (i >= 2 ** 31 || out.includes(i)) continue
    out.push(i)
    if (out.length >= MAX_CLAIMED_INDICES) break
  }
  return out
}

type PsbtT = InstanceType<typeof Psbt>

/**
 * The output input `i` spends, read from its previous transaction and PROVEN by that
 * transaction's hash being the outpoint's txid. Undefined when the input carries no previous
 * transaction; a reason when it carries one that does not prove out.
 */
function provenOutput(psbt: PsbtT, i: number): { script: Uint8Array; value: bigint } | DecodeError | undefined {
  const input = psbt.data.inputs[i]
  const txIn = psbt.txInputs[i]
  if (!input?.nonWitnessUtxo || !txIn) return undefined
  let prev: ReturnType<typeof bjs.Transaction.fromBuffer>
  try {
    prev = bjs.Transaction.fromBuffer(input.nonWitnessUtxo)
  } catch {
    return { reason: `Input ${i} carries an unparsable previous transaction` }
  }
  if (hex(prev.getHash()) !== hex(txIn.hash)) {
    return { reason: `Input ${i} carries a previous transaction that is not the one it spends` }
  }
  const out = prev.outs[txIn.index]
  if (!out) return { reason: `Input ${i}'s previous transaction has no output at index ${txIn.index}` }
  return { script: out.script, value: out.value }
}

/*
  🚨 **WHAT AN INPUT SPENDS, AND HOW WE KNOW** (2026-09-10, completed 2026-10-04).

  A PSBT states an input's script and value twice: `witnessUtxo` (a bare claim) and
  `nonWitnessUtxo` (the whole previous transaction, whose hash IS the outpoint's txid).
  bitcoinjs signs over the previous transaction's output whenever one is present, so that is
  the field the display must read too. Three rules, and each one closed a live attack:
   1. **Its hash must be the txid the input spends.** The signer checks this and silently
      SKIPS an input that fails, so a forged previous transaction set the panel's fee while
      producing no signature; two such sessions, each forging a different input, finalized a
      transaction whose fee neither panel showed (the 2020 segwit fee attack).
   2. **`witnessUtxo` must agree with it in value AND script.** A disagreement has no honest
      cause. The script half mattered on its own: vault matching read `witnessUtxo.script`,
      so pointing it at a second saved vault borrowed that vault's change branch.
   3. **EVERY input MUST carry it** (2026-10-10; before, only inputs naming the signing key). A
      bare `witnessUtxo` on a "foreign" input was the two-session fee attack with the
      derivation stripped instead of the previous transaction forged. Platform, Sparrow and
      Electrum PSBTs always carry it; a payjoin-style PSBT with an unproven input is refused.
*/
function inputValue(psbt: PsbtT, i: number, signingKey?: string): bigint | DecodeError {
  const input = psbt.data.inputs[i]
  const txIn = psbt.txInputs[i]
  if (!input || !txIn) return { reason: `Input ${i} is missing` }
  /*
    ⚠️ TAPROOT IS REFUSED, NOT NETWORK-CHECKED. signBIP32 signs any input whose
    `tapBip32Derivation` names this key, and the network gate in key.ts reads only
    `bip32Derivation`, so a testnet key signed a coin-0 Taproot path. Fountain's keys only ever
    sit in P2WSH multisig, so no Taproot signature is one it should make, on either network.
  */
  if (namesKey(input.tapBip32Derivation, signingKey)) {
    return { reason: `Input ${i} asks this key for a Taproot signature. Fountain only signs P2WSH multisig vault inputs.` }
  }
  const out = provenOutput(psbt, i)
  if (out && 'reason' in out) return out
  if (out) {
    const stated = input.witnessUtxo
    if (stated && stated.value !== out.value) {
      return {
        reason:
          `Input ${i} states two different values (${stated.value} vs ${out.value} sats). ` +
          `Refusing to display a spend whose own amounts disagree.`,
      }
    }
    if (stated && hex(stated.script) !== hex(out.script)) {
      return { reason: `Input ${i} states a script that is not the one its previous transaction pays. Refusing to display it.` }
    }
    return out.value
  }
  /*
    🚨 **EVERY input needs its previous transaction, not only the ones naming this key**
    (external review, 2026-10-10). A segwit v0 signature commits to the amount of the input it
    signs and to nobody else's, so a bare `witnessUtxo` on the OTHER input was trusted: strip
    one vault input's derivation, claim it holds 10,000 sats, sign the other; then swap. Each
    panel showed a 30,000-sat fee and the combined signatures paid ~1 BTC to miners. No input
    whose value we cannot prove may count toward the fee we show.
  */
  if (input.witnessUtxo || input.bip32Derivation?.length) {
    return {
      reason: `Input ${i} carries no previous transaction, so its amount and this spend's fee cannot be verified`,
    }
  }
  return { reason: `Input ${i} has no recoverable value (missing witness/prev-tx data)` }
}

/**
 * Each input's PROVEN script with the indices it names. An input without a previous transaction
 * that hashes to its outpoint is left out: what `witnessUtxo` says it spends is a claim, and
 * matching on it let a PSBT pick which saved vault's change branch the panel believed.
 */
function provenInputs(psbt: PsbtT): { script: string; claimed: number[] }[] {
  const out: { script: string; claimed: number[] }[] = []
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const p = provenOutput(psbt, i)
    if (!p || 'reason' in p) continue
    out.push({ script: hex(p.script), claimed: claimedIndices(psbt.data.inputs[i]) })
  }
  return out
}

/**
 * Does any proven input spend from this vault — on EITHER branch, at the index it names, or
 * within the fallback window?
 */
function vaultSpends(
  inputs: { script: string; claimed: number[] }[],
  branches: string[],
  net: NetworkName,
): boolean {
  for (const input of inputs) {
    for (const index of input.claimed) {
      if (branches.some((b) => scriptAt(b, index, net) === input.script)) return true
    }
  }
  const wanted = new Set(inputs.map((i) => i.script))
  for (let index = 0; index < SCAN_WINDOW; index++) {
    for (const b of branches) {
      const h = scriptAt(b, index, net)
      if (h !== null && wanted.has(h)) return true
    }
  }
  return false
}

export type VaultMatch = {
  /** The change descriptor of the first matching saved vault whose change branch is VERIFIED
   *  to be the same vault's (vaults.ts changeDescriptorBelongsTo). Absent in degraded mode. */
  changeDescriptor?: string
  /** How many DIFFERENT saved vaults (by descriptor) this PSBT's inputs come from. */
  vaults: number
}

/**
 * Which saved vault(s) this PSBT spends from — matched on each input's PROVEN script, never on
 * `witnessUtxo.script` (see `inputValue`). Never throws; an unparsable PSBT matches nothing.
 *
 * ⚠️ `vaults` counts DISTINCT descriptors: the same vault saved twice (allowed, see
 * addVaultBackup) is one vault, or the "spends from several vaults" warning cries wolf on an
 * ordinary spend. It also counts a vault saved WITHOUT a change descriptor, which is what lets
 * the panel say "no change descriptor" instead of "not saved".
 */
export function matchVaults(
  psbtBase64: string,
  net: NetworkName,
  candidates: { descriptor: string; changeDescriptor?: string }[],
): VaultMatch {
  let psbt: PsbtT
  try {
    psbt = Psbt.fromBase64(psbtBase64, { network: bitcoinNetwork(net) as never })
  } catch {
    return { vaults: 0 }
  }
  const inputs = provenInputs(psbt)
  if (inputs.length === 0) return { vaults: 0 }

  const matched = new Set<string>()
  let changeDescriptor: string | undefined
  for (const candidate of candidates) {
    // 🚨 THE PAIR IS CHECKED BEFORE THE CHANGE BRANCH IS BELIEVED. The candidates come from
    // `localStorage['signbit.vaults']` — unauthenticated JSON any local process can rewrite —
    // so a change descriptor that is not demonstrably the same vault's is never matched on or
    // classified against. See vaults.ts > changeDescriptorBelongsTo for the full attack. One
    // that cannot derive at all is treated as missing: degraded mode, not a refused spend.
    const change =
      candidate.changeDescriptor &&
      changeDescriptorBelongsTo(candidate.descriptor, candidate.changeDescriptor) &&
      scriptAt(candidate.changeDescriptor, 0, net) !== null
        ? candidate.changeDescriptor
        : undefined
    const branches = change ? [candidate.descriptor, change] : [candidate.descriptor]
    if (!vaultSpends(inputs, branches, net)) continue
    matched.add(candidate.descriptor.trim())
    if (!changeDescriptor && change) changeDescriptor = change
  }
  return changeDescriptor ? { changeDescriptor, vaults: matched.size } : { vaults: matched.size }
}

/** The change descriptor to classify against, or undefined (degraded mode). See matchVaults. */
export function findMatchingChangeDescriptor(
  psbtBase64: string,
  net: NetworkName,
  candidates: { descriptor: string; changeDescriptor?: string }[],
): string | undefined {
  return matchVaults(psbtBase64, net, candidates).changeDescriptor
}

/**
 * How many of the cached vaults contribute inputs to this PSBT.
 *
 * ⚠️ Change is classified against ONE descriptor (the first match), which is correct for the
 * normal case — a spend draws on one vault. A PSBT whose inputs span TWO vaults is a different
 * situation the single-descriptor panel cannot describe, and counting is what lets the UI say so.
 */
export function countMatchingVaults(
  psbtBase64: string,
  net: NetworkName,
  candidates: { descriptor: string; changeDescriptor?: string }[],
): number {
  return matchVaults(psbtBase64, net, candidates).vaults
}

/**
 * Decode a PSBT's real effect independent of any label it carries. `changeDescriptor` is the
 * vault's cached change-branch descriptor (from matchVaults) — pass it when known so outputs can
 * be classified; omit it to get the degraded (amounts-only) mode. `signingKey` is the master
 * fingerprint of the key about to sign: inputs that name it must be fully proven, and the review
 * refuses anything that key could not honestly be shown.
 */
export function decodePsbt(
  psbtBase64: string,
  net: NetworkName,
  changeDescriptor?: string,
  signingKey?: string,
): DecodedPsbt | DecodeError {
  // The wrong-tab case, named rather than reported as a parse failure (same as signPsbt).
  if (psbtBase64.trim().startsWith('SIGNBIT-')) {
    return { reason: 'That looks like a message, not a transaction. Open it in the Message tab to sign it.' }
  }
  let psbt: PsbtT
  try {
    psbt = Psbt.fromBase64(psbtBase64, { network: bitcoinNetwork(net) as never })
  } catch (err) {
    return { reason: `Not a valid PSBT: ${(err as Error).message}` }
  }
  if (psbt.txInputs.length === 0) return { reason: 'PSBT has no inputs' }

  let inputSats = 0
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const value = inputValue(psbt, i, signingKey)
    if (typeof value !== 'bigint') return value
    inputSats += Number(value)
  }

  /*
    Change = an output whose script this vault's CHANGE descriptor derives. Each output is tried
    at the index it names first (one derivation, any depth); an output naming nothing falls back
    to the window [0, SCAN_WINDOW) plus the window just past the deepest change index an input
    of this vault demonstrably spends from: the platform names no index on its change output,
    and its next change sits just past the change the spend consumes. Change past both reads as
    a recipient, which OVERSTATES what leaves (the safe direction).
  */
  let isChange: ((script: string, outputIndex: number) => boolean) | null = null
  if (changeDescriptor) {
    const shape = scriptAt(changeDescriptor, 0, net)
    if (shape === null) return { reason: 'Could not derive the change descriptor' }
    let deepest = -1
    for (const input of provenInputs(psbt)) {
      for (const index of input.claimed) {
        if (index > deepest && scriptAt(changeDescriptor, index, net) === input.script) deepest = index
      }
    }
    isChange = (script, outputIndex) => {
      for (const index of claimedIndices(psbt.data.outputs[outputIndex])) {
        if (scriptAt(changeDescriptor, index, net) === script) return true
      }
      // A different script TYPE can never be this vault's change, so a P2WPKH or P2TR
      // recipient costs no derivation at all.
      if (script.length !== shape.length || script.slice(0, 4) !== shape.slice(0, 4)) return false
      for (let index = 0; index < SCAN_WINDOW; index++) if (scriptAt(changeDescriptor, index, net) === script) return true
      for (let index = Math.max(SCAN_WINDOW, deepest + 1); index < deepest + 1 + SCAN_WINDOW; index++) {
        if (scriptAt(changeDescriptor, index, net) === script) return true
      }
      return false
    }
  }

  let outputSats = 0
  const outputs: DecodedOutput[] = psbt.txOutputs.map((out, i) => {
    const spk = out.script as Uint8Array
    const amountSats = Number(out.value)
    outputSats += amountSats
    let address: string
    try {
      address = bjs.address.fromOutputScript(spk, bitcoinNetwork(net) as never)
    } catch {
      address = '(unrecognized output script)'
    }
    const change: DecodedOutput['change'] = isChange ? (isChange(hex(spk), i) ? 'change' : 'recipient') : 'unknown'
    return { address, amountSats, change }
  })

  const feeSats = inputSats - outputSats

  return {
    outputs,
    feeSats,
    changeClassified: isChange !== null,
    // A negative fee is impossible in a real transaction (outputs exceeding inputs), so it is
    // always wrong — and it is what an OVERSTATED input value produces.
    feeLooksWrong: feeSats < 0 || (inputSats > 0 && feeSats > inputSats * FEE_ALARM_RATIO),
  }
}
