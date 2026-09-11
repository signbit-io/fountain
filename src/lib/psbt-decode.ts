import * as ecc from '@bitcoinerlab/secp256k1'
import * as descriptors from '@bitcoinerlab/descriptors'
import { bitcoinNetwork, type NetworkName } from './bitcoin-network.js'

/*
  Pre-sign PSBT decode — the human-readable "here's what you're about to authorize" summary
  shown right before the Sign button (the "File import is TEXT-ONLY" security note: the real
  PSBT threat is SEMANTIC — a well-formed PSBT paying a different address/amount than the user
  agreed to — not a malformed/executable file, which is already handled by text-only parsing).

  This is DISPLAY-ONLY: it never alters signing, never trusts any label IN the PSBT, and
  computes everything (destination, amount, fee, change) independently from the PSBT's own
  bytes + (when available) the vault's cached change descriptor — the same script-membership
  approach the SignBit platform signer uses server-side (build the change branch's script
  set, classify by membership), just running client-side against lib/vaults.ts's local cache
  instead of a synced descriptor.

  Degraded mode: if this app has no cached descriptor for the vault the PSBT belongs to (or no
  descriptor was supplied at all), outputs/amounts/fee are still shown (always derivable from
  the PSBT alone) but every output is marked change:'unknown' rather than guessed — never trust
  a label, and never silently mis-classify recipient vs change when we can't be sure.
*/

const { Output, Psbt } = descriptors
// createBitcoinjsLib's .d.ts only declares toOutputScript; fromOutputScript exists at runtime
// (same cast the signer's lib/spend-sign.ts uses for its own `blib`).
const bjs = descriptors.createBitcoinjsLib(ecc) as unknown as {
  address: { toOutputScript: (a: string, n: unknown) => Uint8Array; fromOutputScript: (s: Uint8Array, n: unknown) => string }
  Transaction: { fromBuffer: (b: Uint8Array) => { outs: { value: bigint }[] } }
}

// Same scan window as the signer's lib/verify.ts — vault usage is sequential from 0; this
// comfortably covers realistic depth while keeping derivation (EC math per index) bounded.
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

  ⚠️ WHY A RATIO AND NOT A CAP: this is the residual defence for the case the cross-check above
  cannot reach — a segwit-only PSBT carrying `witnessUtxo` alone, where the stated value has
  nothing to contradict it. An attacker who understates an input makes the DIFFERENCE vanish
  into the fee, so the tell is not the fee's absolute size (a legitimate fee is any size in a
  busy market) but its size RELATIVE to the spend. Half the input value going to miners has no
  honest explanation; a real fee is orders of magnitude below this.

  Deliberately advisory. This runs on the display side, which must never silently decide a
  user's transaction is invalid — the user may be doing something unusual on purpose, and
  refusing to render leaves them unable to see what they hold. Flag loudly, let them decide.
*/
const FEE_ALARM_RATIO = 0.5

export type DecodeError = { reason: string }

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex')

/** The set of scriptPubKey hexes a descriptor derives over [0, SCAN_WINDOW). */
function scriptSet(descriptor: string, net: NetworkName): Set<string> {
  const network = bitcoinNetwork(net)
  const set = new Set<string>()
  for (let i = 0; i < SCAN_WINDOW; i++) {
    set.add(hex(new Output({ descriptor, index: i, network: network as never }).getScriptPubKey()))
  }
  return set
}

/**
 * A PSBT carries no vault id, so to know WHICH cached vault (lib/vaults.ts) it belongs to —
 * and thus which change descriptor to classify against — this checks each candidate's receive
 * branch for a script matching one of the PSBT's own inputs (the same "does this input belong
 * to this vault" test the platform signer runs server-side). Returns the FIRST
 * matching candidate's change descriptor, or undefined if none match (→ decodePsbt's degraded
 * mode). Never throws — an unparsable PSBT or a candidate with a malformed descriptor is
 * treated as a non-match rather than surfaced here (decodePsbt itself reports PSBT errors).
 */
export function findMatchingChangeDescriptor(
  psbtBase64: string,
  net: NetworkName,
  candidates: { descriptor: string; changeDescriptor?: string }[],
): string | undefined {
  let psbt: InstanceType<typeof Psbt>
  try {
    psbt = Psbt.fromBase64(psbtBase64, { network: bitcoinNetwork(net) as never })
  } catch {
    return undefined
  }
  const inputScripts = new Set(
    psbt.data.inputs
      .map((inp) => inp.witnessUtxo?.script)
      .filter((s): s is Uint8Array => s !== undefined)
      .map(hex),
  )
  if (inputScripts.size === 0) return undefined

  for (const candidate of candidates) {
    if (!candidate.changeDescriptor) continue
    try {
      const receiveScripts = scriptSet(candidate.descriptor, net)
      if ([...inputScripts].some((s) => receiveScripts.has(s))) return candidate.changeDescriptor
    } catch {
      continue // malformed cached descriptor — skip, don't let it block other candidates
    }
  }
  return undefined
}

/**
 * How many of the cached vaults contribute inputs to this PSBT.
 *
 * ⚠️ Change is classified against ONE descriptor (the first match above), which is correct for
 * the normal case — a spend draws on one vault. A PSBT whose inputs span TWO vaults is a
 * different situation the single-descriptor panel cannot describe: outputs get classified
 * against the first vault only, so the second vault's genuine change reads as `recipient`
 * (harmless, it overstates what leaves), but more importantly the panel gives no hint that a
 * SECOND vault is being spent from at all. The user reads "here is what this does" and is not
 * told which wallets it does it FROM. Counting the matches is what lets the UI say so.
 */
export function countMatchingVaults(
  psbtBase64: string,
  net: NetworkName,
  candidates: { descriptor: string; changeDescriptor?: string }[],
): number {
  let psbt: InstanceType<typeof Psbt>
  try {
    psbt = Psbt.fromBase64(psbtBase64, { network: bitcoinNetwork(net) as never })
  } catch {
    return 0
  }
  const inputScripts = new Set(
    psbt.data.inputs
      .map((inp) => inp.witnessUtxo?.script)
      .filter((s): s is Uint8Array => s !== undefined)
      .map(hex),
  )
  if (inputScripts.size === 0) return 0

  let matches = 0
  for (const candidate of candidates) {
    try {
      const receiveScripts = scriptSet(candidate.descriptor, net)
      if ([...inputScripts].some((s) => receiveScripts.has(s))) matches++
    } catch {
      continue
    }
  }
  return matches
}

/**
 * Decode a PSBT's real effect independent of any label it carries. `changeDescriptor` is the
 * vault's cached change-branch descriptor (lib/vaults.ts `VaultBackup.changeDescriptor`) — pass
 * it when known so outputs can be classified; omit it to get the degraded (amounts-only) mode.
 */
export function decodePsbt(
  psbtBase64: string,
  net: NetworkName,
  changeDescriptor?: string,
): DecodedPsbt | DecodeError {
  let psbt: InstanceType<typeof Psbt>
  try {
    psbt = Psbt.fromBase64(psbtBase64, { network: bitcoinNetwork(net) as never })
  } catch (err) {
    return { reason: `Not a valid PSBT: ${(err as Error).message}` }
  }

  const txInputs = psbt.txInputs
  const inputs = psbt.data.inputs
  if (txInputs.length === 0) return { reason: 'PSBT has no inputs' }

  /*
    ⚠️ INPUT VALUES DECIDE THE FEE, AND THE FEE IS THE EASIEST THING TO LIE ABOUT.

    An input's value can be stated twice — in `witnessUtxo.value`, and implicitly by
    `nonWitnessUtxo` (the full previous transaction, whose output at this input's vout is the
    real amount). Nothing in the PSBT format makes the two agree, and the fee shown to the user
    is `inputs − outputs`, so understating an input understates the fee by exactly as much. The
    output amounts a user reads are unaffected — which is precisely what makes it dangerous:
    every figure on screen looks normal except the one that absorbs the difference.

    🚨 `nonWitnessUtxo` WINS, because that is the field the SIGNER treats as authoritative.
    bitcoinjs-lib checks `nonWitnessUtxo` first when building the sighash AND verifies that its
    txid matches the input's prevout hash — so it cannot be forged for an input that really
    exists. `witnessUtxo` carries no such binding: it is a bare {script, value} an attacker
    writes freely. Reading `witnessUtxo` first (as this did) meant the DISPLAY trusted the
    forgeable field while the SIGNATURE committed to the verified one — the exact
    display-vs-signature divergence this file exists to prevent. A PSBT stating 100_000 in
    `witnessUtxo` over a real 100_000_000 UTXO rendered a 10_000-sat fee for a spend that
    actually burned ~1 BTC to miners, and it signed cleanly.

    When BOTH are present they must AGREE. A mismatch is not a display preference to resolve
    quietly — it has no honest cause, so it is refused outright rather than rendered.
  */
  let inputSats = 0
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    const vout = txInputs[i]?.index

    // The authoritative value: the previous transaction's own output, when supplied.
    let provenValue: bigint | undefined
    if (input?.nonWitnessUtxo) {
      try {
        const prev = bjs.Transaction.fromBuffer(input.nonWitnessUtxo as Uint8Array)
        if (vout != null) provenValue = prev.outs[vout]?.value
      } catch {
        return { reason: `Input ${i} carries an unparsable previous transaction` }
      }
      if (provenValue === undefined) {
        return { reason: `Input ${i}'s previous transaction has no output at index ${vout}` }
      }
    }

    const statedValue: bigint | undefined = input?.witnessUtxo?.value

    if (provenValue !== undefined && statedValue !== undefined && provenValue !== statedValue) {
      return {
        reason:
          `Input ${i} states two different values (${statedValue} vs ${provenValue} sats). ` +
          `Refusing to display a spend whose own amounts disagree.`,
      }
    }

    const value = provenValue ?? statedValue
    if (value === undefined) return { reason: `Input ${i} has no recoverable value (missing witness/prev-tx data)` }
    inputSats += Number(value)
  }

  let changeScripts: Set<string> | null = null
  if (changeDescriptor) {
    try {
      changeScripts = scriptSet(changeDescriptor, net)
    } catch (err) {
      return { reason: `Could not derive the change descriptor: ${(err as Error).message}` }
    }
  }

  const outs = psbt.txOutputs
  let outputSats = 0
  const outputs: DecodedOutput[] = outs.map((out) => {
    const spk = out.script as Uint8Array
    const amountSats = Number(out.value)
    outputSats += amountSats
    let address: string
    try {
      address = bjs.address.fromOutputScript(spk, bitcoinNetwork(net) as never)
    } catch {
      address = '(unrecognized output script)'
    }
    const change: DecodedOutput['change'] = changeScripts
      ? changeScripts.has(hex(spk))
        ? 'change'
        : 'recipient'
      : 'unknown'
    return { address, amountSats, change }
  })

  const feeSats = inputSats - outputSats

  return {
    outputs,
    feeSats,
    changeClassified: changeScripts !== null,
    // A negative fee is impossible in a real transaction (outputs exceeding inputs), so it is
    // always wrong — and it is what an OVERSTATED input value produces.
    feeLooksWrong: feeSats < 0 || (inputSats > 0 && feeSats > inputSats * FEE_ALARM_RATIO),
  }
}
