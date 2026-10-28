import { createHash } from 'node:crypto'
import * as ecc from '@bitcoinerlab/secp256k1'
import { BIP32Factory, type BIP32Interface } from 'bip32'
import * as descriptors from '@bitcoinerlab/descriptors'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import {
  bitcoinNetwork,
  multisigAccountPath,
  assertPsbtCoinType,
  type NetworkName,
} from './bitcoin-network.js'
import { decodePsbt } from './psbt-decode.js'

export type { NetworkName } from './bitcoin-network.js'

/*
  The heart of the companion signer — the USER's key, generated to SignBit's exact
  descriptor spec so the keys it makes drop straight into a platform vault.

  Compatibility contract with the SignBit platform (verified against its descriptor +
  policy logic — pinned by compat.test.ts):
   - Derivation: BIP-48  m/48'/<coin>'/0'/2'  (coin=1 testnet, 0 mainnet), native SegWit P2WSH.
     ⚠️ `net` is therefore NOT cosmetic — the same seed gives a different account key per
     network. Callers must pass the KEY'S OWN stamped network (KeyEntry.network), never the
     app's current toggle; deriving an enrolled key against the wrong one silently yields a
     different xpub than the vault was built with.
   - Export = PUBLIC only: account tpub + 8-hex MASTER fingerprint (never private material).
   - Descriptor key expr: [masterfp/48'/1'/0'/2']tpub/<0|1>/*  (receive 0, change 1).
   - Policy approval: ECDSA over sha256(sha256(utf8(payload))) from the account's 0/0 child.
   - PSBT signing: standard BIP-174, using the descriptors package's bundled bitcoinjs
     (createBitcoinjsLib), NEVER top-level bitcoinjs-lib@6.

  Uses the pure-JS @bitcoinerlab/secp256k1 ECC backend — no native/WASM build (runs on
  every platform incl. Android/CI). node:crypto's createHash is available in the Tauri
  webview via Vite's polyfill / node builtins; the double-SHA256 matches policyMsgHash.
*/

const bip32 = BIP32Factory(ecc)

export type AccountKey = {
  /** Extended PUBLIC key (tpub on testnet) at the BIP-48 P2WSH account level. */
  tpub: string
  /** 8-hex master fingerprint (matches the descriptor's [fp/48'/1'/0'/2'] origin). */
  masterFingerprint: string
  /** Origin path WITHOUT the leading m/, e.g. "48'/1'/0'/2'". */
  derivationPath: string
}

/** Generate a fresh 24-word (256-bit) BIP-39 mnemonic. */
export function generateKey(): string {
  return generateMnemonic(wordlist, 256)
}

/** True if `mnemonic` is a valid BIP-39 English phrase. */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalize(mnemonic), wordlist)
}

function normalize(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The BIP-39 word counts a mnemonic is allowed to have. */
const VALID_WORD_COUNTS = [12, 15, 18, 21, 24]

export type MnemonicWordCheck = { word: string; ok: boolean }

export type MnemonicAnalysis = {
  words: MnemonicWordCheck[]
  count: number
  countValid: boolean
  checksumValid: boolean
  /** True only once every per-word check, the count, and the checksum all pass. */
  ok: boolean
}

/**
 * Incremental validation for a pasted/typed seed phrase, so the UI can render per-word and
 * per-stage feedback (word count, unknown words, checksum) without re-deriving this logic.
 * Pure/read-only — does not throw, unlike isValidMnemonic's underlying validateMnemonic path.
 */
export function analyzeMnemonic(input: string): MnemonicAnalysis {
  const normalized = normalize(input)
  const words = normalized === '' ? [] : normalized.split(' ')
  const checks: MnemonicWordCheck[] = words.map((word) => ({ word, ok: wordlist.includes(word) }))
  const countValid = VALID_WORD_COUNTS.includes(words.length)
  const checksumValid = countValid && checks.every((w) => w.ok) && isValidMnemonic(normalized)
  return {
    words: checks,
    count: words.length,
    countValid,
    checksumValid,
    ok: checksumValid,
  }
}

/**
 * Find an existing entry whose mnemonic matches `mnemonic` (both compared normalized), so an
 * import can be rejected as a duplicate before it's added. `entries` mnemonics are assumed
 * already normalized at rest (the only write path is addEntry, which stores them as-is).
 */
export function findDuplicateMnemonic<T extends { mnemonic: string }>(
  entries: T[],
  mnemonic: string,
): T | undefined {
  const normalized = normalize(mnemonic)
  return entries.find((e) => normalize(e.mnemonic) === normalized)
}

/** BIP-39 mnemonic → BIP32 master node on the given network (no passphrase). */
function masterNode(mnemonic: string, net: NetworkName): BIP32Interface {
  const m = normalize(mnemonic)
  if (!validateMnemonic(m, wordlist)) throw new Error('Invalid BIP-39 mnemonic')
  const seed = mnemonicToSeedSync(m) // standard BIP-39: PBKDF2-HMAC-SHA512, 2048, salt "mnemonic"
  return bip32.fromSeed(Buffer.from(seed), bitcoinNetwork(net))
}

/** The BIP-48 account node (m/48'/<coin>'/0'/2') — private, stays in-process. */
function accountNode(mnemonic: string, net: NetworkName): BIP32Interface {
  return masterNode(mnemonic, net).derivePath(`m/${multisigAccountPath(net)}`)
}

/**
 * PUBLIC export to enroll this key in a vault — the account tpub + master fingerprint +
 * path. This is the ONLY thing that leaves the signer for key setup; no private material.
 */
export function accountKey(mnemonic: string, net: NetworkName): AccountKey {
  const master = masterNode(mnemonic, net)
  const account = master.derivePath(`m/${multisigAccountPath(net)}`)
  return {
    tpub: account.neutered().toBase58(),
    masterFingerprint: Buffer.from(master.fingerprint).toString('hex'),
    derivationPath: multisigAccountPath(net),
  }
}

/**
 * The network a stored key derives at — its own stamp, falling back to testnet.
 *
 * ⚠️ Use this ANYWHERE a stored key is derived, exported, or signed with; never the app's
 * current network setting. An unstamped entry predates mainnet support, so it was necessarily
 * created on testnet — that fallback is a fact about history, not a guess. keystore.tsx
 * backfills the stamp on unlock so the fallback stops being load-bearing after one session.
 */
export function networkOf(entry: { network?: NetworkName }): NetworkName {
  return entry.network ?? 'testnet'
}

/** Double-SHA256 of the UTF-8 payload — identical to the platform's policyMsgHash. */
export function policyMsgHash(payload: string): Buffer {
  const h1 = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest()
  return createHash('sha256').update(h1).digest()
}

/**
 * Sign a policy-change approval. Derives the account's 0/0 child (the receive-branch
 * index-0 key the platform's verifyPolicyApproval checks) and ECDSA-signs policyMsgHash(payload).
 * Returns a base64 signature to paste into the platform's policy page.
 */
export function signApproval(mnemonic: string, net: NetworkName, payload: string): string {
  // No network gate needed here (unlike signPsbt): the child key is derived from OUR OWN
  // accountNode(mnemonic, net) path, so `net` fully determines what signs. Nothing
  // caller-supplied can redirect the derivation.
  //
  /*
    Signs ANY text message — a canonical string -> double-SHA256 -> sign. The KNOWN_MESSAGES
    table below is for RECOGNITION (telling the user what they are about to sign), never for
    permission.

    ⚠️ THIS USED TO BE AN ALLOWLIST AND THAT WAS WRONG. It hardcoded two markers, so the
    platform adding a third (SIGNBIT-VAULT-IMPORT, for descriptor import) meant this app
    refused a payload the platform had just handed the user, with "doesn't look like a
    SignBit approval block" — telling them their correct payload was malformed. Every future
    message type would have broken the same way, and a signer that must ship a new release
    before it can sign a new message is a coordination problem, not a security control.

    ⚠️ Refusing to sign was never a security property anyway. The signature is over a hash
    of the exact bytes shown on screen; what protects the user is SEEING what they sign, not
    this app's opinion about which strings are legitimate. An unknown message is signed and
    labelled as unrecognised, so the user decides — the same trust model as the PSBT tab,
    where we decode and display rather than judge.

    The one guard kept is the WRONG-TAB case, which is a usability fix rather than a gate.
  */
  const approval = payload.trim()
  if (!approval) throw new Error('Paste the message first, then sign it.')
  if (approval.startsWith('cHNidP')) {
    throw new Error('That looks like a transaction, not a message. Switch to the PSBT tab to sign it.')
  }
  /*
    ⚠️ SIGN THE BYTES THAT WERE CHECKED — `approval`, not `payload`.

    The guards above run on the TRIMMED text, and so does `classifyMessage`, which is what
    labels the message on screen ("this is a policy change"). Hashing the raw `payload`
    instead meant the signature could cover different bytes than the ones that were inspected
    and named: pad a recognised message with whitespace and it still displays as a policy
    change while committing to a string the platform never canonicalised. Today the only
    caller trims first so the two agree by luck; that is a property of the call site, not of
    this function, and the next caller would not inherit it. Same rule as the PSBT tab —
    what is verified and what is signed must be the same bytes.
  */
  const child = accountNode(mnemonic, net).derivePath('0/0')
  return Buffer.from(child.sign(policyMsgHash(approval))).toString('base64')
}

/**
 * The SignBit messages this build recognises by name, for DISPLAY only.
 *
 * ⚠️ Recognition, never permission — `signApproval` signs anything. Adding an entry here
 * improves what the user is told; omitting one only means a message shows as unrecognised,
 * never that it is refused. That asymmetry is the point: the platform can introduce a new
 * message type without this app needing a release.
 *
 * ⚠️ Matched ANCHORED (`startsWith` on trimmed text), never `includes`: every platform
 * builder puts its marker at index 0, so a substring match would be looser than the format
 * it checks and could mislabel a message that merely contains those bytes.
 */
const KNOWN_MESSAGES: { marker: string; kind: KnownMessageKind }[] = [
  { marker: 'SIGNBIT-POLICY-CHANGE', kind: 'policyChange' },
  { marker: 'SIGNBIT-KEY-HEALTHCHECK', kind: 'healthCheck' },
  { marker: 'SIGNBIT-VAULT-IMPORT', kind: 'vaultImport' },
  { marker: 'SIGNBIT-OWNER-TRANSFER', kind: 'ownerTransfer' },
  /*
    🚨 **THE HIGHEST-STAKE MESSAGE THIS APP CAN BE SHOWN.** An inheritance claim
    approval is the one canonical message whose effect is that COINS MOVE — the platform
    releases its signature and the vault is swept to an address named INSIDE the payload
    (`to:`). Every other message here changes a policy, confirms a key is alive, or
    re-describes a vault; none of them spend.
    ⚠️ It was already signable before this entry existed (`unknownSignbit` falls through to
    signing, by design), so this adds RECOGNITION: the user is told what it is and the screen
    can show the destination they are committing to. Without it the most consequential
    message in the product was the one labelled "we do not recognise this".
  */
  { marker: 'SIGNBIT-INHERITANCE-CLAIM', kind: 'inheritanceClaim' },
]

export type KnownMessageKind =
  | 'policyChange'
  | 'healthCheck'
  | 'vaultImport'
  | 'ownerTransfer'
  /** 🚨 The only canonical message whose effect is that coins move. */
  | 'inheritanceClaim'
  /** Starts with SIGNBIT- but this build does not know it — newer platform, older app. */
  | 'unknownSignbit'
  /** Not a SignBit message at all. Still signable; the user is told plainly. */
  | 'unknown'

/**
 * The fields of a recognised SignBit message, for DISPLAY.
 *
 * 🚨 **PARSED FROM THE BYTES THAT WILL BE SIGNED, and that is the whole point** — the
 * `psbt-decode` lesson (2026-09-10) applied to messages. A canonical payload states the
 * destination inside itself (`to:bc1q…`), so the screen must read it from the SAME trimmed
 * string `signApproval` hashes. Re-deriving or re-fetching it from anywhere else would let
 * the display and the signature disagree, which is precisely the divergence that let an
 * understated PSBT input render a normal fee.
 *
 * ⚠️ **Display only, never a gate.** An unparseable or partial payload returns what it could
 * read and is still signable: the user is shown the raw text regardless, and this app must
 * not refuse a message shape the platform introduced after this build shipped.
 *
 * ⚠️ **Takes the FIRST occurrence of each field.** A payload carrying `to:` twice is
 * malformed, and taking the last would let a trailing line override what a reader saw at the
 * top of the message.
 */
export function messageFields(payload: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of payload.trim().split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const k = line.slice(0, at).trim()
    if (k && !(k in out)) out[k] = line.slice(at + 1).trim()
  }
  return out
}

/** Classify a message for display. Pure, and never gates signing. */
export function classifyMessage(payload: string): KnownMessageKind {
  const trimmed = payload.trim()
  const hit = KNOWN_MESSAGES.find((m) => trimmed.startsWith(m.marker))
  if (hit) return hit.kind
  return trimmed.startsWith('SIGNBIT-') ? 'unknownSignbit' : 'unknown'
}

// descriptors' own Psbt + signers (paired with the same ecc) — the ONE bitcoinjs world.
// NEVER import top-level bitcoinjs-lib@6 for signing (number-vs-bigint clash).
const { Psbt, signers } = descriptors

/**
 * Co-sign a PSBT with this key. Uses the descriptors package's `signers.signBIP32`, which
 * signs every input this master node is a party to (matching by the PSBT's per-input BIP32
 * derivations) and leaves the rest untouched — standard BIP-174. The platform and any other
 * keyholder merge partial sigs the same way until the m-of-n threshold is met.
 *
 * Identical mechanism to the platform's PSBT seed-signing, so a PSBT
 * this signs is byte-for-byte acceptable to the platform's finalize/broadcast path.
 */
export function signPsbt(mnemonic: string, net: NetworkName, psbtBase64: string): string {
  const master = masterNode(mnemonic, net)
  /*
    Parse guarded, and the WRONG-TAB case named explicitly. A SignBit approval payload
    (`SIGNBIT-POLICY-CHANGE` / `SIGNBIT-KEY-HEALTHCHECK`) pasted here is the mistake
    people actually make — the two fields sit one tab apart and both take pasted text.
    Unguarded, `Psbt.fromBase64` hands the raw base64-decoder failure straight to the
    UI ("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly
    encoded"), which names a browser API the user never invoked and gives them nothing
    to act on. Say which tab they want instead.
  */
  const trimmed = psbtBase64.trim()
  if (trimmed.startsWith('SIGNBIT-')) {
    throw new Error('That looks like an approval message, not a transaction. Switch to the Approval tab to sign it.')
  }
  let psbt: InstanceType<typeof Psbt>
  try {
    psbt = Psbt.fromBase64(trimmed, { network: bitcoinNetwork(net) as never })
  } catch (err) {
    throw new Error(`Not a valid PSBT: ${(err as Error).message}`)
  }

  /*
    ⚠️ THE network check — do not remove, and do not assume `net` above already did it.

    signBIP32 (below) matches inputs by the PSBT's OWN bip32Derivation paths, not by
    multisigAccountPath(net), so `net` does NOT decide which paths get signed. Verified:
    a master node built with the testnet network object signs a real mainnet-path PSBT
    with no error. Without this, a key the user believes is testnet-only signs a mainnet
    spend on an attacker-supplied PSBT. See lib/bitcoin-network.ts's header.
  */
  const fingerprint = Buffer.from(master.fingerprint).toString('hex')
  const derivations = psbt.data.inputs.flatMap((input) =>
    (input.bip32Derivation ?? []).map((d) => ({
      masterFingerprint: Buffer.from(d.masterFingerprint).toString('hex'),
      path: d.path,
    })),
  )
  assertPsbtCoinType(net, derivations, fingerprint)

  /*
    🚨 **THE LIBRARY REFUSES WHAT THE REVIEW REFUSES** (2026-10-04). The Sign screen shows
    `decodePsbt`'s summary before this runs, but a refusal there used to make the panel vanish
    while this function signed anyway, so one edited field (a value disagreeing with its
    previous transaction, a foreign input with no value) was a signature over a transaction the
    user was never shown. Same function, same bytes, same signing key, so the two agree by
    construction; the change descriptor is omitted because classification only labels outputs.
  */
  const review = decodePsbt(trimmed, net, undefined, fingerprint)
  if ('reason' in review) throw new Error(`Refusing to sign: ${review.reason}`)

  try {
    signers.signBIP32({ psbt, masterNode: master as never })
  } catch (err) {
    if ((err as Error).message?.includes('No inputs were signed')) {
      throw new Error('This key does not sign any part of this transaction. Check that you picked the key you enrolled in this vault.')
    }
    throw err
  }

  /*
    🚨 **"SIGNED" MUST MEAN EVERY INPUT THAT NAMES THIS KEY.** signBIP32 signs what it can and
    silently skips the rest (a sighash it will not use, a previous transaction that does not
    hash to the outpoint, a pubkey that does not match), throwing only when NOTHING was signed.
    A partly signed PSBT reported as signed is how a skipped input stops being noticed, so each
    of this key's derivations must now carry a signature that VERIFIES, or nothing is returned.
  */
  const verifies = (pubkey: Uint8Array, msghash: Uint8Array, signature: Uint8Array) => ecc.verify(msghash, pubkey, signature)
  psbt.data.inputs.forEach((input, i) => {
    for (const d of input.bip32Derivation ?? []) {
      if (Buffer.from(d.masterFingerprint).toString('hex') !== fingerprint) continue
      let ok = false
      try {
        ok = psbt.validateSignaturesOfInput(i, verifies, d.pubkey)
      } catch {
        ok = false
      }
      if (!ok) {
        throw new Error(
          `This key could not sign input ${i}, although the transaction names it there, so the signature would be incomplete. Nothing was signed.`,
        )
      }
    }
  })
  return psbt.toBase64()
}
