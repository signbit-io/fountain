/*
  Local vault descriptor backups — a plain reference cache, NOT part of the signing/keystore
  trust boundary. A vault's descriptor (and change descriptor) is PUBLIC data: xpubs +
  derivation paths + a checksum, no secrets, the same artifact the SignBit platform already
  makes downloadable from the vault page (its "exportable backup artifact").

  Why this exists: if the platform is ever unreachable, a keyholder who saved their vault's
  descriptor here can still reconstruct the vault's addresses / verify a PSBT's outputs in a
  THIRD-PARTY tool (Sparrow, etc.) using only this public descriptor + their own key — no
  platform involvement needed. Descriptors reach this cache two ways: pasted/imported from the
  platform's own backup file, or BUILT from scratch offline by lib/build-descriptor.ts (which
  needs every keyholder's pubkey, including the platform's). Either way this module only
  stores them — it derives nothing itself.

  Stored in localStorage (like activity.ts's settings/log) — public data, no encryption needed.
  This file also holds the offline builder's DRAFT (bottom) — work in progress, deliberately
  NOT the same thing as a saved backup; see that section's comment.
*/

import { assertCanAddVault } from './limits.js'

const STORE_KEY = 'signbit.vaults'
const DRAFT_KEY = 'signbit.vault-draft'

/**
 * Cosigner names for a saved vault, keyed by 8-hex master FINGERPRINT (lowercase).
 *
 * ⚠️ KEYED BY FINGERPRINT, NEVER BY POSITION. The offline builder runs its keys through
 * canonicalKeyOrder() before building, so "the first key I typed" is NOT "the first key in
 * the descriptor" — an index-keyed map would silently attach Alice's name to Bob's key. The
 * fingerprint is the one identifier that survives that sort, and it is already printed in
 * every key expression, so a name can always be matched back to the descriptor it belongs to.
 *
 * Optional and always degradable: a vault with no map (every backup saved before this, and
 * every pasted descriptor) renders exactly as it did before, as "Signer N".
 */
export type VaultKeyLabels = Record<string, string>

export type VaultBackup = {
  id: string
  label: string
  descriptor: string
  changeDescriptor?: string
  savedAt: string // ISO timestamp
  /** Cosigner names by master fingerprint — see VaultKeyLabels. Display only: nothing about
   *  signing, derivation or verification reads this, so a wrong or missing name is cosmetic. */
  keyLabels?: VaultKeyLabels
  /** Last-viewed branch/index in the Derive Address panel — purely a UX convenience
   *  (resume where you left off), not security-relevant; safe to lose/reset. */
  lastDerived?: { branch: 'receive' | 'change'; index: number }
}

/**
 * Coerce an untrusted keyLabels map into shape: lowercase 8-hex keys, non-empty string
 * values, trimmed. Returns undefined when nothing usable survives, so an absent map and an
 * empty one are the same thing downstream.
 *
 * Used on BOTH read paths (localStorage and the restored backup file), because both carry
 * JSON written by an older build or a hand-edit — the same reason normalizePayload is
 * defensive about everything else.
 */
export function normalizeKeyLabels(input: unknown): VaultKeyLabels | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const out: VaultKeyLabels = {}
  for (const [fp, name] of Object.entries(input as Record<string, unknown>)) {
    if (typeof name !== 'string') continue
    const key = fp.trim().toLowerCase()
    const value = name.trim()
    if (!/^[0-9a-f]{8}$/.test(key) || !value) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * A local, per-entry id. Random, never derived from content.
 *
 * ⚠️ THE FALLBACK MUST NOT BE A BARE TIMESTAMP. `crypto.randomUUID` needs a SECURE CONTEXT,
 * so it is absent over a plain-HTTP dev/LAN origin — and the old fallback, `String(Date.now())`,
 * gives two entries saved in the same millisecond the SAME id. Removal filters by id, so a
 * single delete then removed BOTH of them. The random suffix makes that collision
 * vanishingly unlikely; `removeVaultBackup` deleting exactly one row is the real guard.
 */
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Heal rows written by older builds, in memory, on every read.
 *
 * ⚠️ It repairs IDS ONLY — it must never drop a row. Two entries sharing a descriptor are a
 * legitimate duplicate the user asked for (see addVaultBackup); the thing that was genuinely
 * broken is a shared ID, which `newId`'s old timestamp fallback produced for two vaults saved
 * in the same millisecond and which made ONE delete remove BOTH. Regenerating the collided id
 * makes every row independently addressable, which is what removal actually needs. Collapsing
 * rows here instead would silently destroy a vault nobody asked to remove.
 *
 * Read-only: it does not write back. The healed shape is persisted the next time anything
 * calls writeVaultBackups, so a read can never mutate storage as a side effect.
 */
function healEntries(list: VaultBackup[]): VaultBackup[] {
  const out: VaultBackup[] = []
  const seenIds = new Set<string>()
  for (const v of list) {
    if (!v || typeof v !== 'object' || typeof v.descriptor !== 'string') continue
    const entry = v.keyLabels !== undefined ? { ...v, keyLabels: normalizeKeyLabels(v.keyLabels) } : { ...v }
    if (!entry.id || seenIds.has(entry.id)) entry.id = newId()
    seenIds.add(entry.id)
    out.push(entry)
  }
  return out
}

export function readVaultBackups(): VaultBackup[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Everything here is JSON from a previous build or a hand-edit, so it is untrusted input
    // rather than a VaultBackup[] — shape-check and heal before any caller sees it.
    return healEntries(parsed as VaultBackup[])
  } catch {
    return []
  }
}

/** Replace the whole saved-backup list. Exported for the app-backup restore path
 *  (lib/backup.ts), which writes the vault cache wholesale; normal editing goes through the
 *  add/remove helpers below. */
export function writeVaultBackups(entries: VaultBackup[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries))
  } catch {
    // ignore — non-critical local cache
  }
}

/**
 * Find a saved backup by its DESCRIPTOR, which is this cache's real identity — never the
 * local random `id`, which is regenerated on every add and so says nothing about whether
 * two entries describe the same vault. Same rule as lib/backup-diff.ts, and for the same
 * reason: an id-based comparison reports two entries where the user made one.
 */
export function findVaultBackupByDescriptor(descriptor: string, entries = readVaultBackups()): VaultBackup | undefined {
  const needle = descriptor.trim()
  if (!needle) return undefined
  return entries.find((v) => v.descriptor === needle)
}

/**
 * Make a label unique within the cache by appending " (2)", " (3)", … as needed.
 *
 * ⚠️ Two cards showing the same name is the failure this prevents, and it is not cosmetic:
 * the remove modal asks the user to TYPE THE LABEL to confirm, so two identically-named
 * vaults make that confirmation unable to distinguish what is about to be deleted. Suffixing
 * at save time means every card in the list is nameable out loud. The user can rename freely
 * afterwards (renameVaultBackup does NOT re-uniquify — a deliberate rename is their call).
 */
export function uniqueVaultLabel(desired: string, existing: VaultBackup[]): string {
  const base = desired.trim() || 'Vault'
  const taken = new Set(existing.map((v) => v.label))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Save a vault descriptor into the cache. ALWAYS adds a row.
 *
 * ⚠️ Saving the same descriptor twice DOES create a second entry (user decision) — this cache
 * is a plain reference list, not a set, and someone re-saving a vault means to have it there.
 * An earlier build de-duplicated on the descriptor and returned the existing entry, which read
 * as a broken save: the UI appended a card while the message said "nothing was added", and the
 * card vanished on reload. Duplicates are made TELLABLE APART by the label suffix instead of
 * being silently refused — see uniqueVaultLabel.
 *
 * ⚠️ Consequences worth knowing, none of them blocking: `backup-diff.ts` indexes vaults BY
 * DESCRIPTOR and keeps the first, so a Compare/Import shows one row for a duplicated pair; and
 * `findMatchingChangeDescriptor` (psbt-decode) may pick either copy, which is harmless because
 * identical descriptors classify change identically.
 */
export function addVaultBackup(
  label: string,
  descriptor: string,
  changeDescriptor?: string,
  keyLabels?: VaultKeyLabels,
): VaultBackup {
  const existing = readVaultBackups()
  // Capacity guard on the ADD path only. writeVaultBackups (used by the restore path) is
  // deliberately NOT guarded — see lib/limits.ts.
  assertCanAddVault(existing.length)
  const entry: VaultBackup = {
    id: newId(),
    label: uniqueVaultLabel(label, existing),
    descriptor: descriptor.trim(),
    changeDescriptor: changeDescriptor?.trim() || undefined,
    keyLabels: normalizeKeyLabels(keyLabels),
    savedAt: new Date().toISOString(),
  }
  writeVaultBackups([...existing, entry])
  return entry
}

/**
 * Remove ONE saved vault backup — the single entry at that id, never every entry sharing it.
 *
 * ⚠️ This was a `filter(v => v.id !== id)`, which deletes EVERY match. Combined with the old
 * timestamp id fallback (see newId), two vaults saved in the same millisecond shared an id and
 * one delete silently removed both — including a vault whose descriptor was completely
 * different from the one the user confirmed. Splicing a single index makes a delete remove one
 * row no matter what is already in storage, which is the property that actually matters: the
 * id fix alone would not have healed data already written.
 */
export function removeVaultBackup(id: string, descriptor?: string): void {
  const entries = readVaultBackups()
  let i = entries.findIndex((v) => v.id === id)
  // Fall back to the DESCRIPTOR — the stable identity. A collided id is regenerated by
  // healEntries on read, so a caller holding an id from an earlier read may no longer match
  // it; without this the delete would silently do nothing. The descriptor never changes.
  if (i === -1 && descriptor) {
    const needle = descriptor.trim()
    i = entries.findIndex((v) => v.descriptor === needle)
  }
  if (i === -1) return
  writeVaultBackups([...entries.slice(0, i), ...entries.slice(i + 1)])
}

/**
 * Rename a saved vault backup — label only; the descriptor, its change descriptor and every
 * cosigner name are untouched.
 *
 * A label is a local nickname with NO cryptographic meaning: it is not in the descriptor, it
 * never reaches a signature, and two devices may legitimately call the same vault different
 * things. So this is freely editable, unlike the descriptor itself (which is the vault's
 * identity and is replaced by remove-and-re-add, never edited in place).
 *
 * An all-whitespace name falls back to 'Vault' rather than rendering a nameless card — the
 * same default addVaultBackup applies.
 */
export function renameVaultBackup(id: string, label: string): VaultBackup {
  const entries = readVaultBackups()
  const entry = entries.find((v) => v.id === id)
  if (!entry) throw new Error('Vault backup not found')
  const updated: VaultBackup = { ...entry, label: label.trim() || 'Vault' }
  writeVaultBackups(entries.map((v) => (v.id === id ? updated : v)))
  return updated
}

/**
 * Set or clear ONE cosigner's name on a saved vault, keyed by fingerprint.
 *
 * ⚠️ Deliberately EDITABLE, unlike addVaultBackup's add-only rule for the same field. The two
 * are not in conflict: add-only governs an automatic path (a repeat save must never silently
 * rewrite names), whereas this is a person deliberately correcting one. A typo'd cosigner name
 * with no way to fix it is exactly the dead-end the builder's labels already were.
 *
 * Clearing (an empty name) REMOVES the entry rather than storing an empty string, so a cleared
 * name falls back to "Signer N" instead of rendering blank. An unknown fingerprint is a no-op
 * — names are matched to the descriptor's keys, so there is nothing to attach it to.
 */
export function setVaultKeyLabel(id: string, fingerprint: string, name: string): VaultBackup {
  const entries = readVaultBackups()
  const entry = entries.find((v) => v.id === id)
  if (!entry) throw new Error('Vault backup not found')
  const fp = fingerprint.trim().toLowerCase()
  if (!/^[0-9a-f]{8}$/.test(fp)) throw new Error('Fingerprint must be 8 hex characters')
  const next = { ...(entry.keyLabels ?? {}) }
  const value = name.trim()
  if (value) next[fp] = value
  else delete next[fp]
  const updated: VaultBackup = { ...entry, keyLabels: Object.keys(next).length > 0 ? next : undefined }
  writeVaultBackups(entries.map((v) => (v.id === id ? updated : v)))
  return updated
}

/** Persist the last-viewed derive-address branch/index for this vault backup — a
 *  quiet UX convenience, not user-facing data (no confirmation/error surface needed). */
export function saveLastDerived(id: string, branch: 'receive' | 'change', index: number): void {
  const entries = readVaultBackups()
  writeVaultBackups(entries.map((v) => (v.id === id ? { ...v, lastDerived: { branch, index } } : v)))
}

/**
 * ADD-ONLY: fills in a change descriptor on an existing saved vault that doesn't have one
 * yet (e.g. saved before the platform's vault page exposed it, or the user only pasted the receive
 * descriptor at the time). Deliberately refuses to overwrite an existing changeDescriptor —
 * if the user needs to REPLACE one, they remove the entry and add it again, so there's no
 * path to silently swap in a wrong/mismatched descriptor over one that was already verified.
 * Returns the updated entry, or throws if the id isn't found or already has one set.
 */
export function addMissingChangeDescriptor(id: string, changeDescriptor: string): VaultBackup {
  const entries = readVaultBackups()
  const entry = entries.find((v) => v.id === id)
  if (!entry) throw new Error('Vault backup not found')
  if (entry.changeDescriptor) throw new Error('This backup already has a change descriptor — remove and re-add it to replace one')
  const updated: VaultBackup = { ...entry, changeDescriptor: changeDescriptor.trim() || undefined }
  writeVaultBackups(entries.map((v) => (v.id === id ? updated : v)))
  return updated
}

/*
  ── The offline builder's DRAFT ──────────────────────────────────────────────────────────
  Work-in-progress state for the offline vault builder: the keys typed in so far, the
  threshold, the label, and the descriptor last built from them.

  Why this is persisted rather than held in the screen's own state: building a vault offline
  means reading every keyholder's extended public key out loud and typing them in one at a
  time — minutes of transcription that, before this, was discarded by anything that unmounted
  the screen (a tab switch remounts it; see the Shell note in LLM_CONTEXT.md §5) and by every
  app restart. Losing it is silent and total, and the only recovery is to ask everyone in the
  room to read their key out again.

  ⚠️ THIS IS NOT THE SAVED-VAULT CACHE, and the two must not be conflated. A draft is
  unfinished input that no one has vouched for; a VaultBackup is a vault the user confirmed.
  Auto-promoting a draft the moment it builds a VALID descriptor would be wrong: `filled >= 2`
  is the only floor the builder enforces, so two keys entered out of an intended three build a
  perfectly valid 2-of-2 descriptor for a vault nobody is a member of. That entry would then
  sit in the cache the recovery path depends on, and psbt-decode's change classification would
  match against it. A plausible-but-wrong cached vault is worse than a lost draft — the same
  reasoning as never rendering a fabricated date instead of "not known". So the draft removes
  the COST of the explicit save without removing the save itself.

  Public data only (extended PUBLIC keys + fingerprints), so localStorage alongside the cache
  is right; no key material can reach here. Cleared when the draft is saved or discarded.
*/
export type VaultDraftKey = { id: string; xpub: string; fingerprint: string; label: string }

export type VaultDraft = {
  label: string
  threshold: number
  keys: VaultDraftKey[]
  /** The descriptor pair last built from these keys, if the user has built one. Dropped
   *  whenever a key changes, so a stale descriptor can never outlive the keys it came from. */
  built?: { receive: string; change: string }
  savedAt: string
}

/** True when a draft holds anything worth restoring — any typed key field, or a label.
 *  An untouched form is not a draft; persisting one would resurrect empty rows forever. */
export function isDraftWorthKeeping(draft: VaultDraft): boolean {
  if (draft.label.trim()) return true
  return draft.keys.some((k) => k.xpub.trim() || k.fingerprint.trim() || k.label.trim())
}

export function readVaultDraft(): VaultDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as VaultDraft
    // Shape-check before trusting it: this is JSON written by a PREVIOUS version of the app,
    // so the stored object carries whatever shape the draft had then, not the type here.
    // A malformed draft is discarded rather than rendered with holes.
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) return null
    const keys = parsed.keys
      .filter((k) => k && typeof k === 'object')
      .map((k) => ({
        id: typeof k.id === 'string' && k.id ? k.id : newId(),
        xpub: typeof k.xpub === 'string' ? k.xpub : '',
        fingerprint: typeof k.fingerprint === 'string' ? k.fingerprint : '',
        label: typeof k.label === 'string' ? k.label : '',
      }))
    if (keys.length === 0) return null
    return {
      label: typeof parsed.label === 'string' ? parsed.label : '',
      threshold: Number.isFinite(parsed.threshold) && parsed.threshold > 0 ? Math.floor(parsed.threshold) : 2,
      keys,
      built:
        parsed.built && typeof parsed.built.receive === 'string' && typeof parsed.built.change === 'string'
          ? { receive: parsed.built.receive, change: parsed.built.change }
          : undefined,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/** Persist the in-progress build. Writing an untouched draft CLEARS instead, so emptying the
 *  form is a real discard rather than leaving yesterday's draft to reappear. */
export function writeVaultDraft(draft: Omit<VaultDraft, 'savedAt'>): void {
  try {
    const full: VaultDraft = { ...draft, savedAt: new Date().toISOString() }
    if (!isDraftWorthKeeping(full)) {
      localStorage.removeItem(DRAFT_KEY)
      return
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(full))
  } catch {
    // ignore — a draft that fails to persist must never block the build itself
  }
}

export function clearVaultDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    // ignore — non-critical local cache
  }
}

/*
  Parse the SignBit platform's downloadable vault backup file — a plain .txt with `#`-prefixed
  comment lines (label/policy/network), a blank line, the descriptor, and a trailing blank line
  (the format the platform's vault page emits). We only need the label (for
  display) and the descriptor itself; the policy/network comments are informational.
  Falls back to treating the whole trimmed text as a bare descriptor if it doesn't match the
  commented format (e.g. the user just pasted the descriptor line on its own).

  ⚠️ A file may carry BOTH branches (receive then change). They are told apart by the key
  expressions' chain element — `/0/*` is receive, `/1/*` is change — never by line order,
  because a file holding only the change branch would otherwise be imported as the receive
  descriptor and every address derived from it would be wrong. A second line that is neither
  is ignored rather than guessed at.
*/
function descriptorChain(descriptor: string): 0 | 1 | null {
  const chains = new Set([...descriptor.matchAll(/\/([01])\/\*/g)].map((m) => m[1]))
  if (chains.size !== 1) return null
  return chains.has('0') ? 0 : 1
}

export function parseVaultBackupFile(text: string): {
  label: string
  descriptor: string
  changeDescriptor?: string
} {
  const lines = text.split('\n').map((l) => l.trim())
  const labelLine = lines.find((l) => l.startsWith('# Label:'))
  const label = labelLine?.slice('# Label:'.length).trim() || ''
  const candidates = lines.filter((l) => l && !l.startsWith('#'))
  if (candidates.length === 0) return { label, descriptor: text.trim() }

  const receive = candidates.find((l) => descriptorChain(l) === 0)
  const change = candidates.find((l) => descriptorChain(l) === 1)
  // With no identifiable receive branch, keep the old behaviour: the first non-comment line
  // is the descriptor. That covers a hand-pasted or non-standard descriptor.
  return { label, descriptor: receive ?? candidates[0], changeDescriptor: receive ? change : undefined }
}

/*
  Human-readable summary of a wsh(sortedmulti(m,[fp/path]xpub/chain/*,...))#checksum
  descriptor (the platform's exact descriptor shape).
  Public data only (fingerprints + xpubs), so this is safe to compute and display; it never
  touches key material. Returns null if the text doesn't match the expected shape — callers
  fall back to showing the raw descriptor in that case (e.g. a hand-edited or non-standard
  descriptor pasted in by the user).
*/
export type ParsedDescriptor = {
  threshold: number
  total: number
  checksum: string
  keys: {
    fingerprint: string
    /** The FULL extended public key, kept so the UI can offer it for copying. Display uses
     *  xpubShort, but a truncated value is useless to paste into another tool, and this is
     *  public data with nothing to withhold. */
    xpub: string
    xpubShort: string
    path: string
    chain: string
  }[]
}

export function parseDescriptorSummary(descriptor: string): ParsedDescriptor | null {
  const outer = descriptor.trim().match(/^wsh\(sortedmulti\((\d+),(.+)\)\)#([a-z0-9]+)$/i)
  if (!outer) return null
  const threshold = Number(outer[1])
  const checksum = outer[3]
  const keyExprs = outer[2].split(',')
  const keys = keyExprs.map((expr) => {
    const m = expr.match(/^\[([0-9a-fA-F]{8})\/([^\]]+)\]([A-Za-z0-9]+)\/(\d+)\/\*$/)
    if (!m) return null
    const [, fingerprint, path, xpub, chain] = m
    const xpubShort = xpub.length > 16 ? `${xpub.slice(0, 8)}…${xpub.slice(-6)}` : xpub
    return { fingerprint: fingerprint.toLowerCase(), xpub, xpubShort, path, chain }
  })
  if (keys.some((k) => k === null)) return null
  return { threshold, total: keys.length, checksum, keys: keys as ParsedDescriptor['keys'] }
}

/**
 * Sniff a descriptor's network from its extended-key prefix — 'mainnet' for xpub/Ypub/Zpub,
 * else 'testnet' (tpub/Upub/Vpub is shared by testnet AND signet; this build defaults that
 * case to testnet, matching the app's own default network). Lets address
 * derivation use the descriptor's OWN network rather than trusting the app's current global
 * toggle, which may differ from whatever network this particular saved backup was made on.
 */
export function sniffDescriptorNetwork(descriptor: string): 'testnet' | 'mainnet' {
  return /\b(xpub|Ypub|Zpub)[A-Za-z0-9]+/.test(descriptor) ? 'mainnet' : 'testnet'
}
