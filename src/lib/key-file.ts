import {
  BuildDescriptorError,
  normalizeFingerprint,
  normalizeXpub,
  PRIVATE_PREFIXES,
} from './build-descriptor.js'
import { coinTypeOfPath, multisigAccountPath, type NetworkName } from './bitcoin-network.js'

/*
  Reading a `signbit-key-<label>-<fp>.json` envelope back INTO the app — the other half of the
  per-key export written by the Keys screen (`enrollmentJson`). Until this existed the format
  was WRITE-ONLY: the app produced a file nothing could consume, so every field in it still had
  to be transcribed by hand at the far end.

  The consumer that earns it is the OFFLINE VAULT BUILDER. Its key rows are
  {xpub, fingerprint, label} typed by hand — exactly the three fields this envelope already
  carries — in the "coparties in a room reading their extended public keys out to each other"
  scenario the builder exists for. Transcribing an xpub by hand is the highest-error step in
  the whole offline flow, and a single wrong character yields a vault nobody can sign for.

  🚨 PUBLIC KEYS ONLY. A file carrying a seed phrase or a private key is a REFUSAL, never a
  convenience: the 24-word import stays the ONLY way key material enters this app, deliberately,
  because that is the path built to be scary. Someone handed a file with a seed in it has
  already had an accident, and quietly absorbing it would hide that from them.

  ⚠️ VALIDATE — DO NOT TRUST THE ENVELOPE'S OWN LABELS. `enrollmentJson` derives its `network`
  field from the PATH's coin type precisely so a file cannot self-describe wrongly; this reader
  re-derives it the SAME way and ignores the field entirely. Same reasoning as KNOWN_MESSAGES
  being recognition rather than permission: what a file says about itself is a claim, and the
  fact is recomputable.

  ⚠️ Hostile input: this parses TEXT that arrived on a USB stick. It is read-then-parse, never
  executed (readTextFile in lib/download.ts is the reader, with its 1 MB cap), it does no I/O of
  its own, and it is pure — so every refusal below is testable without a filesystem.
*/

/** A key read out of an envelope — the three builder fields plus the network we RE-DERIVED. */
export type ImportedKeyFile = {
  /** The file's label, trimmed. Cosmetic — it names a row, it does not identify the key. */
  label: string
  /** Extended PUBLIC key, validated against `network`. */
  xpub: string
  /** 8-hex master fingerprint, lowercased. */
  fingerprint: string
  /** Origin path without the leading `m/`, e.g. "48'/1'/0'/2'". */
  path: string
  /**
   * The network this key actually derives at, read off the PATH's coin type — never off the
   * file's own `network` field. A caller building at a different network must refuse it; that
   * check lives at the CALL SITE rather than here, because this module does not know what the
   * caller is building.
   */
  network: NetworkName
}

/*
  Every way a file can be refused. The UI renders these through i18n, so the reason a user
  reads is localized — the error STRINGS here are for callers with no locale (tests, and any
  future non-UI consumer).

  ⚠️ `private_material` is deliberately its own code rather than folded into `bad_xpub`: the
  two need different copy. A malformed xpub is a typo to fix; a seed in a file is an incident
  to tell someone about.
*/
export type KeyFileErrorCode =
  /** Not JSON at all — a PSBT, a descriptor .txt, a binary, an empty file. */
  | 'not_json'
  /** Valid JSON, but not a SignBit key envelope (no/foreign `type` marker). */
  | 'not_key_file'
  /** 🚨 Carries a seed phrase or a private key. Refused outright. */
  | 'private_material'
  /** A required field (`xpub`) is missing or not a string. */
  | 'missing_field'
  /** The fingerprint is present but is not 8 hex characters. */
  | 'bad_fingerprint'
  /** The origin path is missing or declares a coin type we cannot read a network from. */
  | 'bad_path'
  /** The extended key fails prefix/parse/checksum validation for its own network. */
  | 'bad_xpub'

export type ParseKeyFileResult =
  | { status: 'ok'; key: ImportedKeyFile }
  | { status: 'error'; code: KeyFileErrorCode; message: string }

/** The `type` marker `enrollmentJson` writes. Recognition of OUR OWN format, not a gate on
 *  anything else — there is no other producer, so an unrecognised file is simply not one. */
export const KEY_FILE_TYPE = 'signbit-companion-key'

/*
  Property names that must never appear in a PUBLIC key file. This is a REFUSAL LIST and it is
  allowed to be conservative — a false positive costs one confusing error on a file that had no
  business carrying that field anyway, while a false negative means this app silently swallowed
  a secret off a USB stick.

  ⚠️ Matched case-insensitively on the NAME, at any depth, and independently of the VALUE:
  `{"mnemonic": ""}` is still a file someone built to carry a mnemonic.
*/
const SECRET_FIELD_NAMES = [
  'mnemonic',
  'seed',
  'seedphrase',
  'phrase',
  'words',
  'privatekey',
  'privkey',
  'xprv',
  'secret',
]

/** Does any string ANYWHERE in the parsed value look like an extended PRIVATE key, or does any
 *  property name announce a secret? */
function hasPrivateMaterial(value: unknown, depth = 0): boolean {
  // Bounded so a deeply-nested hostile file cannot exhaust the stack before it is refused.
  if (depth > 8) return false
  if (typeof value === 'string') return PRIVATE_PREFIXES.some((p) => value.trim().startsWith(p))
  if (Array.isArray(value)) return value.some((v) => hasPrivateMaterial(v, depth + 1))
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD_NAMES.includes(k.toLowerCase().replace(/[_ -]/g, ''))) return true
      if (hasPrivateMaterial(v, depth + 1)) return true
    }
  }
  return false
}

function err(code: KeyFileErrorCode, message: string): ParseKeyFileResult {
  return { status: 'error', code, message }
}

/** Read a string property, or undefined if absent / not a string. */
function str(obj: Record<string, unknown>, name: string): string | undefined {
  const v = obj[name]
  return typeof v === 'string' ? v : undefined
}

/**
 * Parse an exported public-key envelope. PURE — no I/O, never throws; every failure comes back
 * as a coded result so the caller can localize it.
 *
 * ⚠️ Order matters, and it is the rule the platform's descriptor importer has paid for three
 * times: SHAPE checks first (is this even our file?), then per-field validity, so a refusal
 * never reports the wrong error and sends the user to fix the wrong thing. The ONE exception is
 * `private_material`, raised BEFORE any field is read — a file with a seed in it must be
 * refused as such even when its xpub is also malformed.
 */
export function parseKeyFile(text: string): ParseKeyFileResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return err('not_json', 'That file is not a SignBit key file (it is not valid JSON).')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('not_key_file', 'That file is not a SignBit key file.')
  }
  const obj = parsed as Record<string, unknown>
  if (str(obj, 'type') !== KEY_FILE_TYPE) {
    return err('not_key_file', 'That file is not a SignBit key file.')
  }

  // 🚨 Before any field is read. See the ordering note above.
  if (hasPrivateMaterial(obj)) {
    return err(
      'private_material',
      'Refusing this file: it contains private key material. A key file carries PUBLIC keys only, so ' +
        'delete this copy and export the public key again.',
    )
  }

  const xpub = str(obj, 'xpub')?.trim()
  if (!xpub) return err('missing_field', 'That key file has no extended public key in it.')

  /*
    The PATH decides the network, so a missing or unreadable one is fatal rather than defaulted.
    Defaulting would pick a network on the user's behalf and then validate the xpub against it —
    which is the exact "the file mislabels itself" failure this reader exists to prevent,
    reintroduced one layer down.
  */
  const path = (str(obj, 'path') ?? '').trim().replace(/^m\//i, '')
  const coin = path ? coinTypeOfPath(path) : null
  if (coin === null) {
    return err(
      'bad_path',
      'That key file does not say which derivation path (and so which network) its key belongs to.',
    )
  }
  const network: NetworkName = coin === 0 ? 'mainnet' : 'testnet'

  let fingerprint: string
  try {
    fingerprint = normalizeFingerprint(str(obj, 'fingerprint') ?? '')
  } catch {
    return err(
      'bad_fingerprint',
      'That key file has a malformed master fingerprint (it must be 8 hex characters).',
    )
  }

  let canonicalXpub: string
  try {
    // ⚠️ normalizeXpub: a key FILE may carry a Vpub/Zpub, and what we KEEP must be the
    // canonical form — everything downstream compares these as strings.
    canonicalXpub = normalizeXpub(xpub, network)
  } catch (e) {
    return err(
      'bad_xpub',
      e instanceof BuildDescriptorError ? e.message : 'That key file has an invalid extended public key.',
    )
  }

  return {
    status: 'ok',
    key: {
      label: (str(obj, 'label') ?? '').trim(),
      xpub: canonicalXpub,
      fingerprint,
      path: path || multisigAccountPath(network),
      network,
    },
  }
}
