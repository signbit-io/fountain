import { encryptKeystore, decryptKeystore, type EncryptedKeystore, type KeyEntry } from './crypto.js'
import { readBackup, type BackupPayload } from './backup.js'

/*
  The RESTORE SEQUENCES — extracted from the KeystoreProvider hook so they are directly
  testable against real crypto, with no React and no Tauri shell.

  WHY this is its own module: these two functions encode an ORDERING that a user's keys rest
  on, and an ordering is exactly the kind of thing that survives a careless refactor while
  quietly inverting. Living inside a `useCallback` closed over React state, the sequence could
  only be tested by transcribing it into a test file — which asserts a COPY and drifts silently
  from the code it claims to cover. Here the test imports the real thing, so a regression fails
  CI instead of waiting to be noticed on someone's recovery day.

  ── The two guarantees ───────────────────────────────────────────────────────────────
   1. VERIFY BEFORE WRITE. Decryption happens FIRST and its throw propagates untouched, so
      nothing reaches storage unless the passphrase is proven to open the file. Inverted, a
      typo on the restore screen would overwrite a perfectly good keystore with a file the
      user cannot open — silent, total, unrecoverable key loss.

   2. KEYS FIRST, side-stores BEST-EFFORT. Seeds are irreplaceable; vault descriptors and
      prefs are a cache the platform can re-supply. So the keystore lands before any side
      store is touched, and a side-store failure is swallowed rather than aborting a restore
      whose irreplaceable part already succeeded.

  Storage effects are INJECTED (not imported) so a test drives the real sequence with a spy,
  and so this module stays free of the Tauri bridge. Callers in the app pass the real writers.
*/

/** The storage effects a restore performs. Injected so the sequence stays pure + testable. */
export type RestoreEffects = {
  /** Commit the encrypted keystore envelope into active storage. */
  writeKeystore: (store: EncryptedKeystore) => Promise<void>
  /** Save vault descriptor backups (best-effort — a cache, never a key). */
  writeVaults: (vaults: BackupPayload['vaults']) => void
  /** Save app settings (best-effort). */
  writeSettings: (settings: NonNullable<BackupPayload['settings']>) => void
  /** Persist the UI locale (best-effort). */
  writeLocale: (locale: string) => void
}

/**
 * Restore from a KEYSTORE FILE — an auto-detected previous keystore or a user-picked one.
 *
 * Verifies the passphrase decrypts the envelope BEFORE committing it, then writes the envelope
 * VERBATIM (never re-encrypted: re-encrypting would change salt/iv and desync the user's other
 * copies of that same file). Returns the decrypted entries for the caller to put into state.
 *
 * @throws if the passphrase does not open the file — in which case NOTHING has been written.
 */
export async function restoreFromKeystoreFile(
  store: EncryptedKeystore,
  passphrase: string,
  effects: Pick<RestoreEffects, 'writeKeystore'>,
): Promise<KeyEntry[]> {
  // GUARANTEE 1 — verify first. A wrong passphrase throws here, before any write.
  const entries = decryptKeystore(store, passphrase)
  await effects.writeKeystore(store)
  return entries
}

/**
 * CHANGE PASSPHRASE — re-encrypt the keystore under a new passphrase, in place.
 *
 * Lives here, beside the restore sequences, because it is the third operation whose ORDERING
 * the user's keys rest on, and it earns its place for a reason the other two make obvious:
 * it is the only path that OVERWRITES a working keystore with a different envelope. Everything
 * about it is arranged so that the write happens only once the replacement is proven good.
 *
 *  1. VERIFY THE OLD. Decrypt with the current passphrase first; a wrong one throws before
 *     anything is written. (The caller may have checked already — this does not trust that.)
 *  2. RE-ENCRYPT under the new passphrase. Fresh salt + iv per `encryptKeystore`, so the new
 *     envelope shares nothing with the old beyond its plaintext.
 *  3. PROVE THE NEW OPENS — decrypt the freshly-built envelope with the new passphrase BEFORE
 *     committing it. This is the step that looks redundant and is not: it is the only thing
 *     standing between a subtly-corrupted encrypt (bad RNG, a future refactor mangling the
 *     envelope) and a keystore that opens with NEITHER passphrase. The old one is about to be
 *     gone; if the new envelope is bad and we've already written it, every key is unreachable.
 *     A few milliseconds of scrypt against that outcome is not a trade worth thinking about.
 *  4. COMMIT. Only now does anything touch disk.
 *
 * Returns the decrypted entries so the caller can refresh state without re-decrypting.
 *
 * ⚠️ Does NOT touch exported backup files — those stay encrypted under whatever passphrase was
 * current when they were written. The UI is responsible for saying so (and for offering a fresh
 * export); there is no way to reach back into a file the user has already put somewhere.
 *
 * @throws if the old passphrase is wrong, or if the new envelope fails its own verification —
 * in both cases NOTHING has been written and the existing keystore is untouched.
 */
export async function changePassphrase(
  store: EncryptedKeystore,
  currentPassphrase: string,
  newPassphrase: string,
  effects: Pick<RestoreEffects, 'writeKeystore'>,
): Promise<KeyEntry[]> {
  // 1 — verify the old. Throws before any write.
  const entries = decryptKeystore(store, currentPassphrase)

  // 2 — re-encrypt under the new passphrase (fresh salt + iv).
  const next = encryptKeystore(entries, newPassphrase)

  // 3 — prove the replacement opens BEFORE it overwrites the thing that currently works.
  decryptKeystore(next, newPassphrase)

  // 4 — commit.
  await effects.writeKeystore(next)
  return entries
}

/**
 * Restore from a full APP BACKUP — the cross-device "move my signer" path.
 *
 * `readBackup` validates and decrypts first (throwing on a wrong passphrase, a tampered file,
 * a non-backup file, or a newer format version), so nothing is written unless the file is
 * proven good. The keys are then committed BEFORE the side stores, and side-store failures are
 * swallowed — a full disk or a locked localStorage profile must cost a cache, never a seed.
 *
 * @throws if the backup cannot be opened — in which case NOTHING has been written.
 */
export async function restoreFromBackupFile(
  raw: string,
  passphrase: string,
  effects: RestoreEffects,
): Promise<BackupPayload> {
  // GUARANTEE 1 — verify first. Throws before anything is written.
  const payload = readBackup(raw, passphrase)

  // GUARANTEE 2a — the irreplaceable part lands first, re-encrypted under the passphrase the
  // user just proved they know (so the new device's keystore opens with it).
  await effects.writeKeystore(encryptKeystore(payload.keys, passphrase))

  // GUARANTEE 2b — everything below is a CACHE. A failure here must not abort a restore whose
  // seeds are already safely committed, so the whole block is deliberately swallowed.
  try {
    if (payload.vaults.length > 0) effects.writeVaults(payload.vaults)
    if (payload.settings) effects.writeSettings(payload.settings)
    if (payload.locale) effects.writeLocale(payload.locale)
  } catch {
    // Intentionally ignored — the keys are restored, which is what matters.
  }

  return payload
}
