import { accountKey, networkOf, type NetworkName } from './key.js'
import type { KeyEntry } from './crypto.js'
import type { BackupPayload } from './backup.js'
import type { VaultBackup, VaultKeyLabels } from './vaults.js'
import type { AppSettings } from './activity.js'

/*
  Backup DIFF — compare this device's live state against a decrypted backup payload.

  Used by BOTH Settings actions, which are the same computation with different endings:
   - COMPARE: show the diff and stop. Read-only, no writes, nothing at risk.
   - IMPORT:  show the SAME diff as the confirmation surface, then overwrite.

  ── Why the diff is the confirmation, not a "are you sure?" ──────────────────────────
  Importing a backup is a FULL REPLACE (lib/restore.ts re-encrypts the backup's keys as the
  entire keystore and writes the vault cache wholesale). A key that exists on this device but
  is NOT in the file is therefore DESTROYED, and a mnemonic that exists nowhere else is gone
  for good. A generic "this will overwrite your data" cannot convey that; naming the specific
  key that is about to disappear can. So this module's real job is finding the `removed` keys —
  everything else it reports is context around that one dangerous fact.

  ── Identity: FINGERPRINT, never the entry id ────────────────────────────────────────
  `KeyEntry.id` is a random local handle (crypto.newId()) minted when a key was created or
  imported ON THIS DEVICE. Import the same 24 words on two devices and you get two different
  ids for one key — so an id-based diff would report "1 added, 1 removed" for a key that never
  moved, i.e. it would cry data loss on the most common case there is (restoring your own
  backup onto a device that already imported the same seed).

  What actually identifies a key is the MASTER FINGERPRINT derived from its mnemonic — the
  same 8 hex chars the descriptor's `[fp/48'/1'/0'/2']` origin carries, so it's also the value
  the user can already see in the app and on the platform. Deriving it means running BIP-32 on
  every key on both sides, which is why this module is the one place that does it: the UI must
  never re-implement "are these the same key".

  ⚠️ Fingerprints are derived from the mnemonic but are PUBLIC (they appear in descriptors).
  This module returns fingerprints and labels; it NEVER returns a mnemonic. Nothing here is
  safe to log, but nothing here is a secret either.
*/

/** How one item on either side relates to the other side. */
export type DiffStatus =
  /** Same identity, same content — present in both, nothing to do. */
  | 'unchanged'
  /** In the backup only. Importing brings it in. */
  | 'added'
  /** On this device only. ⚠️ Importing DESTROYS it. */
  | 'removed'
  /** Same identity, different content (e.g. relabelled, or a vault gained a change descriptor). */
  | 'changed'

/** One key, as it differs between the device and the backup. */
export type KeyDiff = {
  status: DiffStatus
  /** Master fingerprint — the identity. Undefined only if the mnemonic failed to derive.
   *  ⚠️ Identical on testnet and mainnet, so it can never distinguish the two. */
  fingerprint?: string
  /** Label on this device (absent when the key is only in the backup). */
  deviceLabel?: string
  /** Label in the backup (absent when the key is only on this device). */
  backupLabel?: string
  /** True when both sides hold this key but under different labels. */
  labelChanged: boolean
  /** Network stamp on this device (absent when the key is only in the backup). */
  deviceNetwork?: NetworkName
  /** Network stamp in the backup (absent when the key is only on this device). */
  backupNetwork?: NetworkName
  /** True when the two sides derive this key at DIFFERENT networks — importing would change
   *  which xpub it produces, even though the seed is byte-identical. */
  networkChanged?: boolean
}

/** One saved vault descriptor, as it differs. */
export type VaultDiff = {
  status: DiffStatus
  /** Identity: the receive descriptor (the vault IS its descriptor). */
  descriptor: string
  deviceLabel?: string
  backupLabel?: string
  labelChanged: boolean
  /** Set when only one side carries a change descriptor, or the two disagree. */
  changeDescriptor: 'same' | 'onlyDevice' | 'onlyBackup' | 'differs'
  /**
   * Cosigner names (VaultBackup.keyLabels), compared as a whole map.
   *
   * ⚠️ Reported because Compare exists to say exactly what an import will change, and names
   * are the one part of a vault entry a user edits by hand. This matters MORE than the
   * add-only rule elsewhere might suggest: restore writes the file's vault list WHOLESALE
   * (lib/restore.ts → writeVaultBackups), so it does NOT go through addVaultBackup and the
   * file's names REPLACE the device's outright. Importing a backup whose only difference is
   * who the cosigners are called would otherwise report "unchanged" and then silently rename
   * every one of them.
   */
  keyLabels: 'same' | 'onlyDevice' | 'onlyBackup' | 'differs'
}

/** A single non-secret preference that differs. Values are rendered as-is. */
export type SettingDiff = {
  key: string
  deviceValue: string
  backupValue: string
}

export type BackupDiff = {
  keys: KeyDiff[]
  vaults: VaultDiff[]
  settings: SettingDiff[]
  /** Rollup for the headline + the "nothing differs" case. */
  totals: {
    keysAdded: number
    /** ⚠️ The dangerous number — keys that importing would permanently destroy. */
    keysRemoved: number
    keysChanged: number
    keysUnchanged: number
    vaultsAdded: number
    vaultsRemoved: number
    vaultsChanged: number
    vaultsUnchanged: number
    settingsChanged: number
  }
  /** True when importing would change nothing at all (every list is unchanged). */
  identical: boolean
  /** True when importing would destroy at least one key. Drives the type-to-confirm gate. */
  destructive: boolean
}

/**
 * Master fingerprint for a mnemonic, or undefined if it can't be derived.
 *
 * The network is irrelevant to the MASTER fingerprint (it's the hash160 prefix of the master
 * public key, identical on testnet and mainnet) — but `accountKey` needs one, so callers pass
 * the app's current network and the result is network-independent regardless. A mnemonic that
 * throws (hand-edited backup, corrupt entry) yields undefined rather than failing the whole
 * diff: a user comparing a damaged file still deserves to see everything else in it.
 */
function fingerprintOf(mnemonic: string, network: NetworkName): string | undefined {
  try {
    return accountKey(mnemonic, network).masterFingerprint.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Group entries by fingerprint. A device CAN hold the same seed twice only if the duplicate
 * guard was bypassed (importKey rejects duplicates), so this keeps the FIRST occurrence and
 * treats later ones as the same identity — a diff is not the place to surface that anomaly.
 */
function byFingerprint(entries: KeyEntry[], network: NetworkName): Map<string, KeyEntry> {
  const map = new Map<string, KeyEntry>()
  for (const e of entries) {
    const fp = fingerprintOf(e.mnemonic, network)
    // A key whose fingerprint won't derive is keyed by its id instead, so it still appears in
    // the diff (as its own identity) rather than silently vanishing from the comparison.
    const id = fp ?? `underivable:${e.id}`
    if (!map.has(id)) map.set(id, e)
  }
  return map
}

/** Normalize a descriptor for identity comparison — whitespace only; case is significant
 *  (base58 xpubs are case-sensitive, so lowercasing would merge genuinely different keys). */
function normalizeDescriptor(d: string): string {
  return d.trim()
}

function diffKeys(deviceKeys: KeyEntry[], backupKeys: KeyEntry[], network: NetworkName): KeyDiff[] {
  const device = byFingerprint(deviceKeys, network)
  const backup = byFingerprint(backupKeys, network)
  const out: KeyDiff[] = []

  // Walk the device side first so `removed` (the dangerous status) is computed against the
  // authoritative live state, then pick up whatever the backup adds.
  for (const [id, entry] of device) {
    const fingerprint = id.startsWith('underivable:') ? undefined : id
    const other = backup.get(id)
    if (!other) {
      out.push({
        status: 'removed',
        fingerprint,
        deviceLabel: entry.label,
        labelChanged: false,
        deviceNetwork: networkOf(entry),
      })
      continue
    }
    const labelChanged = entry.label !== other.label
    /*
      The NETWORK STAMP can differ too, and it matters far more than a label: the same seed
      derives a different account xpub per network, so importing a stamp change silently
      re-points an enrolled key at a different derivation. The fingerprint is identical across
      networks (verified in security.test.ts), so this is invisible to identity matching and has
      to be compared explicitly — otherwise the two sides look 'unchanged' while the import
      changes what the key produces.
    */
    const deviceNetwork = networkOf(entry)
    const backupNetwork = networkOf(other)
    const networkChanged = deviceNetwork !== backupNetwork
    out.push({
      status: labelChanged || networkChanged ? 'changed' : 'unchanged',
      fingerprint,
      deviceLabel: entry.label,
      backupLabel: other.label,
      labelChanged,
      deviceNetwork,
      backupNetwork,
      networkChanged,
    })
  }
  for (const [id, entry] of backup) {
    if (device.has(id)) continue
    out.push({
      status: 'added',
      fingerprint: id.startsWith('underivable:') ? undefined : id,
      backupLabel: entry.label,
      labelChanged: false,
      backupNetwork: networkOf(entry),
    })
  }
  return sortByStatus(out)
}

function diffVaults(deviceVaults: VaultBackup[], backupVaults: VaultBackup[]): VaultDiff[] {
  const index = (list: VaultBackup[]) => {
    const map = new Map<string, VaultBackup>()
    // A vault backup's own `id` is local like a key's, so identity is the DESCRIPTOR — the
    // thing that actually names the vault on-chain and is identical across every device.
    for (const v of list) {
      const key = normalizeDescriptor(v.descriptor)
      if (!map.has(key)) map.set(key, v)
    }
    return map
  }
  const device = index(deviceVaults)
  const backup = index(backupVaults)
  const out: VaultDiff[] = []

  for (const [descriptor, v] of device) {
    const other = backup.get(descriptor)
    if (!other) {
      out.push({
        status: 'removed',
        descriptor,
        deviceLabel: v.label,
        labelChanged: false,
        changeDescriptor: v.changeDescriptor ? 'onlyDevice' : 'same',
        keyLabels: v.keyLabels ? 'onlyDevice' : 'same',
      })
      continue
    }
    const labelChanged = v.label !== other.label
    const change = compareChangeDescriptor(v.changeDescriptor, other.changeDescriptor)
    const names = compareKeyLabels(v.keyLabels, other.keyLabels)
    out.push({
      status: labelChanged || change !== 'same' || names !== 'same' ? 'changed' : 'unchanged',
      descriptor,
      deviceLabel: v.label,
      backupLabel: other.label,
      labelChanged,
      changeDescriptor: change,
      keyLabels: names,
    })
  }
  for (const [descriptor, v] of backup) {
    if (device.has(descriptor)) continue
    out.push({
      status: 'added',
      descriptor,
      backupLabel: v.label,
      labelChanged: false,
      changeDescriptor: v.changeDescriptor ? 'onlyBackup' : 'same',
      keyLabels: v.keyLabels ? 'onlyBackup' : 'same',
    })
  }
  return sortByStatus(out)
}

/** Whether the two sides agree on a vault's change descriptor. Worth its own status because
 *  a missing change descriptor is exactly what makes the Sign screen unable to classify change
 *  outputs — so "the backup has one and this device doesn't" is a real, actionable difference,
 *  not cosmetic drift. */
function compareChangeDescriptor(device?: string, backup?: string): VaultDiff['changeDescriptor'] {
  const d = device?.trim() || ''
  const b = backup?.trim() || ''
  if (d === b) return 'same'
  if (d && !b) return 'onlyDevice'
  if (!d && b) return 'onlyBackup'
  return 'differs'
}

/** Compare two cosigner-name maps as WHOLE maps — key-order-independent, so serialization
 *  order can never masquerade as a change. */
function compareKeyLabels(device?: VaultKeyLabels, backup?: VaultKeyLabels): VaultDiff['keyLabels'] {
  const norm = (m?: VaultKeyLabels) => {
    const entries = Object.entries(m ?? {}).filter(([, v]) => v)
    entries.sort(([a], [b]) => a.localeCompare(b))
    return entries
  }
  const d = norm(device)
  const b = norm(backup)
  const same = d.length === b.length && d.every(([k, v], i) => b[i]![0] === k && b[i]![1] === v)
  if (same) return 'same'
  if (d.length > 0 && b.length === 0) return 'onlyDevice'
  if (d.length === 0 && b.length > 0) return 'onlyBackup'
  return 'differs'
}

function diffSettings(device: AppSettings, backup?: AppSettings, deviceLocale?: string, backupLocale?: string): SettingDiff[] {
  const out: SettingDiff[] = []
  // A backup without settings carries no opinion — restore leaves the device's prefs alone
  // (lib/restore.ts only writes them `if (payload.settings)`), so there is nothing to report.
  if (backup) {
    if (device.autoLockMinutes !== backup.autoLockMinutes) {
      out.push({
        key: 'autoLockMinutes',
        deviceValue: String(device.autoLockMinutes),
        backupValue: String(backup.autoLockMinutes),
      })
    }
    if (device.theme !== backup.theme) {
      out.push({ key: 'theme', deviceValue: device.theme, backupValue: backup.theme })
    }
    // The network the app WORKS ON (not any key's own stamp). Importing writes settings
    // wholesale, so a backup made on testnet silently moves a mainnet device to testnet and
    // vice versa — the user has to see that coming.
    if (device.network !== backup.network) {
      out.push({ key: 'network', deviceValue: device.network, backupValue: backup.network })
    }
  }
  if (backupLocale && backupLocale !== (deviceLocale ?? '')) {
    out.push({ key: 'locale', deviceValue: deviceLocale || '—', backupValue: backupLocale })
  }
  return out
}

/** Order every list the same way: the destructive rows first, then additions, then changes,
 *  then the unchanged bulk. A user scanning a long diff must hit what they can LOSE before
 *  they hit forty rows of "unchanged". */
const STATUS_ORDER: Record<DiffStatus, number> = { removed: 0, added: 1, changed: 2, unchanged: 3 }

function sortByStatus<T extends { status: DiffStatus }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
}

/** This device's live state, as the diff needs it. Passed in (not read here) so the module
 *  stays pure and testable — the caller already holds the unlocked keys. */
export type DeviceState = {
  keys: KeyEntry[]
  vaults: VaultBackup[]
  settings: AppSettings
  locale?: string
}

/**
 * Compare this device's live state against a decrypted backup payload.
 *
 * Pure: reads no storage and writes nothing, so COMPARE is provably side-effect-free and
 * IMPORT can show the user exactly what its own apply step will do.
 */
export function diffBackup(device: DeviceState, backup: BackupPayload, network: NetworkName): BackupDiff {
  const keys = diffKeys(device.keys, backup.keys, network)
  const vaults = diffVaults(device.vaults, backup.vaults)
  const settings = diffSettings(device.settings, backup.settings, device.locale, backup.locale)

  const count = <T extends { status: DiffStatus }>(rows: T[], status: DiffStatus) =>
    rows.filter((r) => r.status === status).length

  const totals = {
    keysAdded: count(keys, 'added'),
    keysRemoved: count(keys, 'removed'),
    keysChanged: count(keys, 'changed'),
    keysUnchanged: count(keys, 'unchanged'),
    vaultsAdded: count(vaults, 'added'),
    vaultsRemoved: count(vaults, 'removed'),
    vaultsChanged: count(vaults, 'changed'),
    vaultsUnchanged: count(vaults, 'unchanged'),
    settingsChanged: settings.length,
  }

  const identical =
    totals.keysAdded === 0 &&
    totals.keysRemoved === 0 &&
    totals.keysChanged === 0 &&
    totals.vaultsAdded === 0 &&
    totals.vaultsRemoved === 0 &&
    totals.vaultsChanged === 0 &&
    totals.settingsChanged === 0

  return {
    keys,
    vaults,
    settings,
    totals,
    identical,
    // ONLY key removal counts as destructive. A dropped vault descriptor is a cache the
    // platform can re-supply; a dropped seed may exist nowhere else on earth.
    destructive: totals.keysRemoved > 0,
  }
}

/** The word a user must type to confirm a destructive import. Not localized on purpose —
 *  a type-to-confirm token that changes with the UI language is one the user can get subtly
 *  wrong, and this is the last gate before seeds are destroyed. (Same reasoning as the
 *  platform's vault-delete confirm.) */
export const OVERWRITE_CONFIRM_WORD = 'OVERWRITE'
