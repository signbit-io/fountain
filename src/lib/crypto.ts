import { createCipheriv, createDecipheriv } from 'node:crypto'
import { scrypt } from '@noble/hashes/scrypt'
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils'
import type { NetworkName } from './bitcoin-network.js'

/*
  Encrypted keystore — the barebones-but-real at-rest protection for the user's mnemonics.
  Passphrase → scrypt KDF → AES-256-GCM (authenticated encryption).

  ⚠️ The KDF uses @noble/hashes' PURE-JS scrypt, NOT node:crypto's scryptSync — the Vite
  node-polyfill (crypto-browserify) does NOT implement scrypt, so scryptSync is undefined in
  the webview. noble's scrypt is audited and runs identically in Node (tests) and the webview.

  ⚠️ **ONLY THE CIPHER COMES FROM `node:crypto` NOW.** `randomBytes` used to as well, and that
  was the one place where the module under test was not the module that shipped — see the
  `randomBytes` wrapper below, which routes the salt and IV through @noble/hashes instead so
  both environments run the same code. AES-GCM itself stays on node:crypto (the polyfill does
  implement it, and crypto.test.ts covers it).

  Threat model: the keystore file at rest. It does NOT protect against a compromised host while
  unlocked (keys are in memory then). OS-keychain and dedicated signing hardware are the planned
  stronger tiers. The format is versioned so those can migrate it.

  ⚠️ This now guards MAINNET keys — real funds, not testnet play money. Nothing here was
  weakened for that (the scrypt cost below was always sized for a key vault), but the stakes
  changed, so read the paragraph above as a live limitation rather than an MVP caveat: a user
  who keeps mainnet keys on a general-purpose machine is trusting their passphrase and this
  file, and nothing else.

  Wrong passphrase fails LOUDLY: GCM auth-tag verification throws on decrypt — we never
  return garbage plaintext.
*/

const VERSION = 1
const KDF = 'scrypt'
const CIPHER = 'aes-256-gcm'
// scrypt cost params. N=2^17 for a KEY VAULT: the on-disk envelope is the ONLY brute-force
// defense (an attacker copies keystore.json and guesses OFFLINE — no UI, no rate limit, no
// lockout can touch that; only KDF cost does), so we pay a heavier tax per guess than a
// typical interactive default. r=8 → ~128 MB memory per attempt, which is what makes it
// hostile to GPU/ASIC cracking. Still tolerable on a phone (Tauri mobile target).
// ⚠️ decryptKeystore reads N/r/p FROM THE ENVELOPE, so raising this does NOT break existing
// keystores — they decrypt with their stored (older) params and re-encrypt to the new cost
// on the next write. Bump further for higher-value deployments.
const SCRYPT_N = 131072
const SCRYPT_r = 8
const SCRYPT_p = 1
const KEY_LEN = 32
const SALT_LEN = 16
const IV_LEN = 12

/**
 * The salt and the IV.
 *
 * 🚨 **NOT `node:crypto`'s `randomBytes`, AND THE DIFFERENCE IS THE WHOLE POINT.** In the
 * WebView `node:crypto` is not node:crypto at all — Vite substitutes `crypto-browserify` (see
 * vite.config.ts) — so the RNG that ran in the shipped app was never the one the tests
 * exercised, because vitest runs under Node and resolves the real module. An IV is the one
 * input to AES-GCM that must never repeat under a given key, and a repeat is not a degraded
 * mode: it breaks confidentiality and forgeability outright.
 *
 * The polyfill did turn out to fail closed (`randombytes/browser.js` throws rather than
 * reaching for `Math.random`), so nothing was ever weak — but that was a property of a
 * transitive dependency's `browser` field, asserted nowhere and one `npm install` from
 * changing. @noble/hashes' `randomBytes` goes straight to `crypto.getRandomValues`, throws
 * when it is absent, is already the source `@scure/bip39` uses for the SEED, and is the
 * identical module in Node and in the WebView. So the question stops needing an answer.
 *
 * ⚠️ Only the RNG moved. `node:crypto` still provides the CIPHER (AES-256-GCM), which the
 * polyfill does implement and `crypto.test.ts` covers. Found by the 2026-09-18 cross-platform
 * adversarial pass; asserted in `cross-platform.adversarial.test.ts`.
 */
function randomBytes(length: number): Buffer {
  return Buffer.from(nobleRandomBytes(length))
}

/**
 * Unicode-normalize a passphrase before it reaches the KDF.
 *
 * 🚨 **THE QUIETEST WAY TO LOSE A VAULT FOR EVER.** Unicode lets the same character be spelled
 * more than one way — "é" is either U+00E9 (composed) or "e" + U+0301 (decomposed). They render
 * identically, a human reading a passphrase off a card cannot tell them apart, and they are
 * DIFFERENT BYTES. Which one a keyboard emits is a platform decision, not the user's. So a
 * passphrase typed on desktop and re-typed on Android derived a DIFFERENT KEY, and every
 * failure path below deliberately returns the same generic message — the app told someone who
 * had typed their passphrase correctly that it was "wrong, or the data is damaged", with
 * nothing to try differently. On a backup carried to a replacement device that is
 * unrecoverable, and it is exactly the moment this product exists for.
 *
 * ⚠️ **NFKD, matching BIP-39's own rule** for mnemonics and passphrases. This app already lives
 * in that ecosystem; agreeing with it beats inventing a second convention.
 */
function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFKD')
}

/** One stored key: a label the user gives it + the BIP-39 mnemonic (the secret). */
export type KeyEntry = {
  id: string
  label: string
  mnemonic: string
  createdAt: string
  /**
   * The network this key was GENERATED for — stamped once at create/import and never changed.
   *
   * ⚠️ This is what the key derives at, NOT the app's current toggle. The same seed yields a
   * different account xpub per network (BIP-48 coin 0 vs coin 1), so deriving an existing key
   * against whatever the toggle happens to say would silently produce a different key than the
   * one the user enrolled in their vault.
   *
   * OPTIONAL for backwards compatibility: keystores written before mainnet existed have no
   * stamp, and every key in them was necessarily made on testnet — so an absent value reads as
   * 'testnet'. keystore.tsx backfills it on unlock so the ambiguity lasts one session, not
   * forever. Adding an optional field is deliberately NOT a backup-format change (see
   * lib/backup.ts — BACKUP_FORMAT_VERSION stays 1).
   */
  network?: NetworkName
}

/** The on-disk encrypted envelope. Only `ct`/`salt`/`iv`/`tag` hold ciphertext; the rest
 *  is public metadata needed to derive the key + decrypt. NO secret is outside `ct`. */
export type EncryptedKeystore = {
  version: number
  kdf: typeof KDF
  cipher: typeof CIPHER
  scrypt: { N: number; r: number; p: number }
  salt: string // base64
  iv: string // base64
  tag: string // base64
  ct: string // base64 — AES-GCM ciphertext of JSON.stringify(KeyEntry[])
}

// scrypt via @noble/hashes (pure-JS; works in Node + webview). Returns a Buffer key.
function deriveKeyWith(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  const out = scrypt(Buffer.from(passphrase, 'utf8'), salt, { N, r, p, dkLen: KEY_LEN })
  return Buffer.from(out)
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return deriveKeyWith(normalizePassphrase(passphrase), salt, SCRYPT_N, SCRYPT_r, SCRYPT_p)
}

/** The crypto half of an envelope, without the format/versioning fields wrapped around it.
 *  Shared by the keystore (EncryptedKeystore) and the portable app backup (lib/backup.ts) so
 *  both go through the SAME audited encrypt/decrypt path — one place to get AEAD right. */
export type SealedPayload = {
  kdf: string
  cipher: string
  scrypt: { N: number; r: number; p: number }
  salt: string // base64
  iv: string // base64
  tag: string // base64
  ct: string // base64
}

/**
 * Encrypt an arbitrary UTF-8 string under a passphrase (scrypt → AES-256-GCM).
 *
 * The generic primitive behind BOTH the keystore and the app backup. Callers wrap the
 * result in their own versioned envelope; the KDF params are returned INSIDE the sealed
 * payload so the file stays self-describing and future-proof (raising SCRYPT_N later can
 * never orphan an already-written file — it decrypts with its own stored params).
 */
export function encryptPayload(plaintextUtf8: string, passphrase: string): SealedPayload {
  if (!passphrase) throw new Error('A passphrase is required')
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv(CIPHER, key, iv)
  const plaintext = Buffer.from(plaintextUtf8, 'utf8')
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    kdf: KDF,
    cipher: CIPHER,
    scrypt: { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  }
}

/** Encrypt the full list of key entries under a passphrase. */
export function encryptKeystore(entries: KeyEntry[], passphrase: string): EncryptedKeystore {
  return { version: VERSION, ...encryptPayload(JSON.stringify(entries), passphrase) } as EncryptedKeystore
}

// Floor for the KDF cost we're willing to HONOR on decrypt (independent of what we WRITE —
// SCRYPT_N above). The envelope's N/r/p are attacker-controlled input (a copied/tampered/
// "restored" keystore.json): without this floor, a downgraded envelope (e.g. N=1) would make
// scrypt nearly free, defeating the "KDF cost is the only brute-force defense" threat model
// (the keystore threat model) — offline attackers control the file they're guessing against. This
// floor matches security.test.ts's guard on the DEFAULT; here it's enforced on every decrypt,
// not just asserted about what we currently write.
const MIN_SCRYPT_N = 65536 // 2^16
const MIN_SCRYPT_R = 1
const MIN_SCRYPT_P = 1

/*
  ⚠️ AND A CEILING, for the opposite attack (2026-10-04). The same header fields are just as
  attacker-written upward: {N: 65536, r: 1, p: 8,000,000} passed the floor and ran scrypt on
  the main thread for days, freezing restore/compare/import on any file someone was handed.
  noble's 1 GB `maxmem` stops a huge N or r but not a huge p. Every value here is far above
  what this app writes (2^17 / 8 / 1), so raising SCRYPT_N later stays inside it.
*/
const MAX_SCRYPT_N = 2 ** 20
const MAX_SCRYPT_R = 16
const MAX_SCRYPT_P = 4

/**
 * Decrypt a sealed payload back to its UTF-8 string.
 *
 * The generic counterpart to encryptPayload, shared by the keystore and the app backup so
 * the KDF-floor check below is enforced on EVERY decrypt path, not just the keystore's.
 * `genericMessage` lets each caller phrase its own user-facing wording while keeping the
 * critical property: every failure mode returns the SAME message, so it can't be used as
 * an oracle for which field was wrong (or whether the passphrase was merely close).
 */
export function decryptPayload(sealed: SealedPayload, passphrase: string, genericMessage?: string): string {
  const generic = () => new Error(genericMessage ?? 'Could not decrypt this. The passphrase is wrong, or the data is damaged.')
  if (!sealed || typeof sealed !== 'object') throw generic()
  const n = sealed.scrypt?.N
  const r = sealed.scrypt?.r
  const p = sealed.scrypt?.p
  if (
    typeof n !== 'number' ||
    typeof r !== 'number' ||
    typeof p !== 'number' ||
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < MIN_SCRYPT_N ||
    r < MIN_SCRYPT_R ||
    p < MIN_SCRYPT_P
  ) {
    throw generic()
  }
  // A specific message on purpose: the header is readable without the passphrase, so naming
  // the cause reveals nothing an attacker does not already have.
  if (n > MAX_SCRYPT_N || r > MAX_SCRYPT_R || p > MAX_SCRYPT_P) {
    throw new Error('This file asks for far more key-stretching work than SignBit ever uses, so it was not opened. It is damaged, or it is not a SignBit file.')
  }
  if (typeof sealed.salt !== 'string' || typeof sealed.iv !== 'string' || typeof sealed.tag !== 'string' || typeof sealed.ct !== 'string') {
    throw generic()
  }
  const attempt = (secret: string): string => {
    const salt = Buffer.from(sealed.salt, 'base64')
    const iv = Buffer.from(sealed.iv, 'base64')
    const tag = Buffer.from(sealed.tag, 'base64')
    const ct = Buffer.from(sealed.ct, 'base64')
    const key = deriveKeyWith(secret, salt, n, r, p)
    const decipher = createDecipheriv(CIPHER, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  }

  const normalized = normalizePassphrase(passphrase)
  try {
    return attempt(normalized)
  } catch {
    /*
      ⚠️ **THE RAW RETRY IS A MIGRATION, NOT A WEAKNESS.** Keystores and backups written before
      `normalizePassphrase` existed were sealed under the passphrase's RAW bytes, and a file the
      user already stored elsewhere can never be reached to re-wrap. Without this, adding
      normalization would have locked every non-ASCII passphrase out of its own backup — the
      exact failure it was added to prevent, pointed the other way.

      **It costs nothing in the normal case and gives an attacker nothing.** The second scrypt
      run happens ONLY when normalization actually changed the string, so an ASCII passphrase
      (very nearly all of them) pays exactly one derivation. And an offline guesser already
      chooses the bytes they guess with, so being allowed two spellings of one guess is not
      ground they did not have.
    */
    if (normalized !== passphrase) {
      try {
        return attempt(passphrase)
      } catch {
        throw generic()
      }
    }
    // GCM auth failure, malformed base64, bad IV/tag length, etc. = wrong passphrase or a
    // corrupted/tampered/malformed file. Never leak which — same generic error every time.
    throw generic()
  }
}

/** Decrypt a keystore. Throws on a wrong passphrase (GCM tag mismatch), tampering, or an
 *  envelope whose declared KDF cost/shape is invalid/too weak to trust. Never returns partial
 *  plaintext — every failure path throws the same generic message (no info leak about which
 *  field was wrong). */
export function decryptKeystore(store: EncryptedKeystore, passphrase: string): KeyEntry[] {
  const generic = () => new Error('Could not unlock. The passphrase is wrong, or the keystore is damaged.')
  if (!store || typeof store !== 'object') throw generic()
  if (store.version !== VERSION) throw new Error(`Unsupported keystore version ${store.version}`)
  const plaintext = decryptPayload(store, passphrase, 'Could not unlock. The passphrase is wrong, or the keystore is damaged.')
  try {
    return JSON.parse(plaintext) as KeyEntry[]
  } catch {
    // Decrypted "successfully" (shouldn't happen under GCM) but wasn't valid JSON — still
    // never leak partial plaintext or a parser error; treat as corrupted.
    throw generic()
  }
}

/** Generate a random id for a new key entry (not secret; just a stable handle). */
export function newId(): string {
  return randomBytes(8).toString('hex')
}
