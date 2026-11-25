/*
  Capacity limits for the things a backup has to carry, and the size warning that goes with them.

  ── Why an ENTITY cap and not just a byte cap ────────────────────────────────────────
  A byte budget is invisible: nobody knows they're approaching "1 MB of keys" until a write
  fails. A COUNT is something a user can see coming and act on — it can be shown as "412 / 1000"
  long before it bites. So the user-facing limit is entities; the byte caps
  (MAX_BACKUP_IMPORT_BYTES in download.ts, MAX_READ_BYTES in src-tauri/src/lib.rs) exist only as
  the memory bound underneath, sized so the entity cap can never reach them.

  Sizing: a key is ~170 bytes (dominated by its 24-word mnemonic), a 3-of-5 vault ~1.5 KB (five
  full xpub key expressions). At the caps below that's ~1.6 MB of JSON → ~2.2 MB encrypted
  (base64 adds ~33%), comfortably inside the 16 MB read bound.

  ⚠️ THE CAPS APPLY TO *ADDING*, NEVER TO RESTORING. See assertCanAddKey/assertCanAddVault:
  they guard the create/import paths only. A restore accepts whatever the file holds, however
  many entries that is. A limit introduced today must never make a backup written yesterday
  unrecoverable — that would reintroduce the exact recovery-path failure these limits exist to
  remove. Over-limit restores are surfaced as a warning, not a refusal.
*/

/** Most keys one signer will hold. Adding beyond this is refused; restoring beyond it is not. */
export const MAX_KEYS = 1000

/** Most saved vault descriptors. Same add-only enforcement as MAX_KEYS. */
export const MAX_VAULTS = 1000

/** Show the live count in Settings once usage crosses this share of a cap — early enough to be
 *  a heads-up, late enough that a normal user (a handful of keys) never sees a limit at all. */
export const COUNT_WARN_RATIO = 0.5

/**
 * Byte size at which an EXPORTED backup is worth warning about, ~75% of the 16 MB read bound.
 *
 * The point is to warn while the user still HOLDS every key, rather than letting them discover
 * at restore time that the file can't be read back. Nothing realistic reaches this — it's the
 * backstop for a case the entity caps don't model (e.g. unusually long labels).
 */
export const BACKUP_SIZE_WARN_BYTES = 12 * 1024 * 1024

/** True when a count is far enough along that the UI should start showing it. */
export function shouldShowCount(count: number, max: number): boolean {
  return count >= Math.floor(max * COUNT_WARN_RATIO)
}

/**
 * Throw if another key can't be added. Called by the CREATE/IMPORT paths only.
 * The message names the limit and what to do, since "failed" alone is not actionable.
 */
export function assertCanAddKey(current: number): void {
  if (current >= MAX_KEYS) {
    throw new Error(
      `This signer holds the maximum of ${MAX_KEYS} keys. Remove one you no longer need before adding another.`,
    )
  }
}

/** Throw if another saved vault can't be added. ADD path only — never the restore path. */
export function assertCanAddVault(current: number): void {
  if (current >= MAX_VAULTS) {
    throw new Error(
      `This signer holds the maximum of ${MAX_VAULTS} saved vaults. Remove one you no longer need before adding another.`,
    )
  }
}
