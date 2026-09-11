import { encryptPayload, decryptPayload, type KeyEntry } from './crypto.js'
import { readVaultBackups, normalizeKeyLabels, type VaultBackup } from './vaults.js'
import { readSettings, type AppSettings } from './activity.js'
import { version as APP_VERSION } from '../../package.json'

/*
  Full-app encrypted backup — the "move my whole signer to a new device" artifact.

  WHY this exists separately from the keystore file: the keystore holds ONLY the seeds.
  A user's actual working state also includes their saved vault descriptors (which vaults
  exist, their quorums, every cosigner's xpub) plus small prefs. Copying keystore.json
  alone restores the keys but silently loses every vault descriptor — which is what makes
  the Sign screen unable to classify change outputs. So a backup wraps ALL of it.

  ── The portability contract (this file's whole reason for being) ────────────────────
  A backup written by ANY build must open on ANY other build, on any OS, including ones
  that don't exist yet (iOS). That means:

   1. SELF-DESCRIBING. Everything needed to decrypt — including the scrypt cost params —
      travels INSIDE the file. Raising the app's KDF cost later never orphans an old
      backup: it decrypts with its own stored params. (Same principle as the keystore
      envelope, and the reason decryptPayload reads N/r/p from the file.)
   2. TWO DIFFERENT VERSIONS, deliberately:
        `version`     — the FORMAT contract. Code branches on this. Bump ONLY when the
                        structure changes, never for an ordinary app release.
        `createdWith` — which app build wrote it. Diagnostics/support only; never
                        branched on. Without this split, every app release would look
                        like a new format to a reader.
      An older app meeting a newer `version` says so plainly instead of failing obscurely.
      ⚠️ An OPTIONAL ADDITIVE FIELD is NOT a structural change and must NOT bump `version`.
      Worked example — `VaultBackup.keyLabels` (cosigner names): an old backup opens on a
      new app with the field simply absent (it degrades to "Signer N"), and a new backup
      opens on an OLD app because normalizePayload passes vault objects through whole
      rather than stripping unknown fields — the names survive unread, and a re-export from
      that old build still carries them. Bumping `version` for this would have made every
      new backup unreadable by the previous build, on the restore path, for nothing.
   3. PLAIN JSON + base64 ONLY. No platform APIs, no absolute paths, no device binding,
      no OS keychain. The file is inert text — which is what lets it cross Windows →
      Android → Linux → iOS unchanged.

  ⚠️ SECURITY: the payload is encrypted because vault descriptors, while PUBLIC data
  (xpubs, no secrets), map out the user's entire custody topology — how many vaults, what
  quorums, which cosigners. That is not something to leave in cleartext in a file destined
  for cloud storage. Everything sensitive lives inside `ct`; only the KDF metadata needed
  to decrypt sits outside it.

  ⚠️ The passphrase IS the only protection. A backup in cloud storage can be brute-forced
  OFFLINE forever, with no rate limit or lockout to stop it — exactly the keystore threat
  model, which is why the same deliberately-expensive scrypt cost applies here.
*/

/** Format contract version. Bump ONLY on a structural change to BackupFile/BackupPayload. */
export const BACKUP_FORMAT_VERSION = 1

/** Marker identifying this as a SignBit backup (guards against a mis-picked JSON file). */
export const BACKUP_TYPE = 'signbit-backup'

/** The decrypted contents — everything that makes the app "how it was". */
export type BackupPayload = {
  /** The secrets: BIP-39 mnemonics + their labels. The irreplaceable part. */
  keys: KeyEntry[]
  /** Saved vault descriptor backups (public data, but topology-revealing — see header). */
  vaults: VaultBackup[]
  /** Non-secret prefs. Nice-to-have; a restore is still valid without them. */
  settings?: AppSettings
  /** UI language (`signbit.locale`). */
  locale?: string
}

/** The on-disk backup file. Only `ct`/`salt`/`iv`/`tag` hold ciphertext. */
export type BackupFile = {
  type: typeof BACKUP_TYPE
  /** FORMAT version — what code branches on. Not the app version. */
  version: number
  /** App build that wrote this. Informational only — never branched on. */
  createdWith: string
  createdAt: string
  kdf: string
  cipher: string
  scrypt: { N: number; r: number; p: number }
  salt: string
  iv: string
  tag: string
  ct: string
}

/**
 * Gather every piece of restorable state currently on this device.
 *
 * `keys` must be passed in from the UNLOCKED keystore (this module never touches storage
 * or decrypts anything itself — it composes what the caller already holds). Everything
 * else is read from localStorage here.
 *
 * ⚠️ Deliberately EXCLUDES `signbit.card.*` (which cards you left expanded) — pure UI
 * ephemera that would only add noise and churn to the file.
 */
export function collectBackupPayload(keys: KeyEntry[]): BackupPayload {
  const payload: BackupPayload = {
    keys,
    vaults: readVaultBackups(),
    settings: readSettings(),
  }
  try {
    const locale = localStorage.getItem('signbit.locale')
    if (locale) payload.locale = locale
  } catch {
    // localStorage unavailable — locale is optional, carry on.
  }
  return payload
}

/** Encrypt a payload into the portable backup envelope. */
export function createBackup(payload: BackupPayload, passphrase: string): BackupFile {
  if (!passphrase) throw new Error('A passphrase is required')
  const sealed = encryptPayload(JSON.stringify(payload), passphrase)
  return {
    type: BACKUP_TYPE,
    version: BACKUP_FORMAT_VERSION,
    createdWith: APP_VERSION,
    createdAt: new Date().toISOString(),
    ...sealed,
  }
}

/**
 * Parse + decrypt a backup file. Throws with a SPECIFIC message for the cases a user can
 * actually act on (wrong file / newer app needed) and a deliberately GENERIC one for
 * anything crypto-related — a wrong passphrase and a tampered file are indistinguishable
 * on purpose, so the error can't be used as an oracle.
 */
export function readBackup(raw: string, passphrase: string): BackupPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("That file isn't a SignBit backup (it isn't valid JSON).")
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error("That file isn't a SignBit backup.")
  }
  const file = parsed as Partial<BackupFile>
  if (file.type !== BACKUP_TYPE) {
    throw new Error("That file isn't a SignBit backup.")
  }
  // Forward compatibility: a file from a FUTURE format is a clear, actionable message —
  // never a confusing decrypt failure. This is the branch that makes rule 2 pay off.
  if (typeof file.version !== 'number' || file.version > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup was made by a newer version of SignBit (format ${String(file.version)}). Update the app, then restore again.`,
    )
  }

  const json = decryptPayload(file as BackupFile, passphrase, 'Could not restore — wrong passphrase or corrupted backup.')

  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    throw new Error('Could not restore — wrong passphrase or corrupted backup.')
  }
  return normalizePayload(payload)
}

/**
 * Validate + coerce a decrypted payload into the shape we expect.
 *
 * Defensive on purpose: a backup may have been written by an older build (missing newer
 * optional fields) or hand-edited. `keys` is the ONLY field a restore genuinely requires;
 * anything else degrades to a sane default rather than failing the whole restore — losing
 * a theme preference must never cost someone their seeds.
 */
function normalizePayload(input: unknown): BackupPayload {
  const p = (input ?? {}) as Partial<BackupPayload>
  if (!Array.isArray(p.keys)) {
    throw new Error('Could not restore — this backup has no keys in it.')
  }
  const keys = p.keys.filter(
    (k): k is KeyEntry =>
      !!k && typeof k === 'object' && typeof k.id === 'string' && typeof k.mnemonic === 'string' && k.mnemonic.length > 0,
  )
  if (keys.length === 0) {
    throw new Error('Could not restore — this backup has no keys in it.')
  }
  const vaults = Array.isArray(p.vaults)
    ? p.vaults
        .filter(
          (v): v is VaultBackup =>
            !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.descriptor === 'string',
        )
        // Cosigner names ride inside the encrypted payload like everything else here, but
        // they are still untrusted input on the way back in (older build, hand-edit), so
        // coerce them rather than casting. An unusable map degrades to absent — the card
        // falls back to "Signer N", which is exactly how a pre-keyLabels backup renders.
        .map((v) => (v.keyLabels !== undefined ? { ...v, keyLabels: normalizeKeyLabels(v.keyLabels) } : v))
    : []
  return {
    keys,
    vaults,
    settings: p.settings,
    locale: typeof p.locale === 'string' ? p.locale : undefined,
  }
}

/**
 * Default filename: `signbit-backup-YYYY-MM-DD.json`.
 *
 * Chosen so it's findable by searching a whole drive for either "signbit" or "backup",
 * and DATED so successive backups sort chronologically and never silently overwrite one
 * another. `.json` (not a custom extension) keeps mobile file pickers and cloud apps able
 * to handle it. The user can edit this freely in the save dialog.
 */
export function defaultBackupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `signbit-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}
