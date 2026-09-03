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
}

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

  let inputSats = 0
  for (let i = 0; i < inputs.length; i++) {
    const wu = inputs[i]?.witnessUtxo
    let value: bigint | undefined = wu?.value
    if (value === undefined && inputs[i]?.nonWitnessUtxo) {
      try {
        const prev = bjs.Transaction.fromBuffer(inputs[i]!.nonWitnessUtxo as Uint8Array)
        const vout = txInputs[i]?.index
        if (vout != null) value = prev.outs[vout]?.value
      } catch {
        /* fall through to the missing-value rejection below */
      }
    }
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

  return {
    outputs,
    feeSats: inputSats - outputSats,
    changeClassified: changeScripts !== null,
  }
}
