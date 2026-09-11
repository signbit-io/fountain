/*
  The RESET SEQUENCE — "reset this device", the wipe reached from the lock screen when someone
  has lost their passphrase and has no backup to restore from.

  WHY this is its own module (same reasoning as lib/restore.ts): it encodes an ORDERING, and an
  ordering is exactly what survives a careless refactor while quietly inverting. Storage effects
  are INJECTED so a test drives the real sequence with spies, with no React and no Tauri shell.

  ── The guarantee ────────────────────────────────────────────────────────────────────
   KEYSTORE FIRST, side-stores after — and the keystore's failure is FATAL where the side
   stores' are not. This is the mirror image of restore's rule, for the same reason: the
   keystore is the only thing here that is irreplaceable, so it is the only thing whose outcome
   is allowed to decide whether the operation succeeded.

   Inverted (side stores first), a keystore that then failed to delete would leave the user
   locked out of an app that had already thrown away their saved vault descriptors — the worst
   of both: nothing reset, cache destroyed. Doing the keystore first means a failure there
   leaves everything else untouched and the error is honest ("nothing was reset").

  ── Why the side stores are best-effort ──────────────────────────────────────────────
   Vault descriptors and prefs are public/local caches. Once the keystore is gone the app WILL
   boot to first-run regardless, so a localStorage failure must not turn a completed reset into
   a reported failure — that would invite the user to run it again looking for a success message
   that can never come. Same swallow-the-cache rule restore.ts uses, pointed the other way.

  ⚠️ This module does NOT gate the action. The confirmation (type-to-confirm RESET + the final
  consequence modal) is the UI's job, in ResetDeviceFlow. Keeping the gates in the UI and the
  ordering here is deliberate: the gates are a design decision that may be tuned, the ordering
  is a correctness property that must not drift.
*/

/** The storage effects a device reset performs. Injected so the sequence stays testable. */
export type ResetEffects = {
  /** Delete the keystore from active storage. FATAL on failure — the whole reset aborts. */
  wipeKeystore: () => Promise<void>
  /** Clear saved vault descriptor backups (best-effort — a cache, never a key). */
  clearVaults: () => void
  /** Clear non-secret app settings (best-effort). */
  clearSettings: () => void
}

/**
 * Wipe this device: delete the keystore, then clear the local caches.
 *
 * @throws if the keystore could not be deleted — in which case NOTHING has been cleared and the
 * app is exactly as it was. The Rust side verifies the file is really gone before returning, so
 * a throw here genuinely means the keys are still on disk.
 */
export async function wipeDevice(effects: ResetEffects): Promise<void> {
  // THE guarantee — the irreplaceable thing goes first, and its failure aborts everything.
  // Anything after this point is running in a world where the keys are already gone.
  await effects.wipeKeystore()

  // Best-effort caches. Deliberately swallowed: the reset has ALREADY succeeded by the time we
  // get here (the keystore is gone and the app will boot to first-run), so a localStorage
  // failure must not be reported as a failed reset.
  try {
    effects.clearVaults()
    effects.clearSettings()
  } catch {
    // Intentionally ignored — the keystore is gone, which is what "reset" means.
  }
}
