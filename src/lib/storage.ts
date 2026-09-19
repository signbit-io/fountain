import { invoke } from '@tauri-apps/api/core'
import type { EncryptedKeystore } from './crypto.js'

/*
  Thin bridge to the Rust keystore commands (load_keystore / save_keystore). The encrypted
  envelope is produced/consumed in JS (crypto.ts); Rust only persists the opaque bytes to
  the app config dir. Kept separate from crypto.ts so the crypto stays pure + unit-testable
  with no Tauri dependency.

  ⚠️ The FILENAME is owned by Rust, not here — `signbit-keystore.json`, with a read-only
  fallback to the pre-0.6 `keystore.json` in the same directory (read-both / write-new, so an
  in-place upgrade keeps working and the next save migrates the name). JS never names the file.
*/

/** Load the encrypted keystore, or null on first run (no file yet). */
export async function loadKeystore(): Promise<EncryptedKeystore | null> {
  const raw = await invoke<string | null>('load_keystore')
  if (!raw) return null
  return JSON.parse(raw) as EncryptedKeystore
}

/** Persist the encrypted keystore envelope. */
export async function saveKeystore(store: EncryptedKeystore): Promise<void> {
  await invoke('save_keystore', { contents: JSON.stringify(store, null, 2) })
}

/** Non-secret location of the keystore, for display in Settings (portable vs OS config dir). */
export type StorageInfo = { portable: boolean; dir: string }

export async function storageInfo(): Promise<StorageInfo> {
  return invoke<StorageInfo>('storage_info')
}

/* ----- restore -------------------------------------------------------------------------- */

/**
 * A keystore found in the location NOT currently in use (e.g. an old %APPDATA% keystore while
 * the app now runs portable with an empty data/ folder). Null when there's nothing to offer.
 *
 * `location` names WHICH folder it came from, so the UI can explain the offer in words instead
 * of printing a path the user has to decode. This matters most right after a device reset: the
 * app cannot read either file, so it cannot know whether this one holds the same keys — but it
 * can at least say the file is from a different place and may need an older passphrase.
 */
export type RestoreCandidate = { path: string; location: 'appData' | 'portable' }

export async function restoreCandidate(): Promise<RestoreCandidate | null> {
  return invoke<RestoreCandidate | null>('restore_candidate')
}

/** Read a keystore envelope from an explicit path (auto-detected or user-picked). No write. */
export async function readKeystoreAt(path: string): Promise<EncryptedKeystore> {
  return JSON.parse(await readTextAt(path)) as EncryptedKeystore
}

/**
 * Read a file's raw text from an explicit path. Same Rust command as readKeystoreAt (which
 * enforces a 1 MB cap) but WITHOUT parsing — the restore screen needs the raw text to tell a
 * keystore envelope from a full app-backup file before deciding how to handle it.
 */
export async function readTextAt(path: string): Promise<string> {
  return invoke<string>('read_keystore_at', { path })
}

/** Commit a restore — copy the (already passphrase-verified) envelope into active storage. */
export async function restoreKeystore(store: EncryptedKeystore): Promise<void> {
  await invoke('restore_keystore', { contents: JSON.stringify(store, null, 2) })
}

/* ----- reset ---------------------------------------------------------------------------- */

/**
 * Delete the keystore from the active location — the "reset this device" wipe. Removes both the
 * current and legacy filenames (Rust owns both names; see the read-both/write-new contract
 * above) and throws if the file survives, so a failed wipe never reports success.
 *
 * Destroys key material irreversibly. Call only behind the reset flow's confirmation gates,
 * and see `wipeDevice` in lib/reset.ts for the ordering this participates in.
 */
export async function wipeKeystore(): Promise<void> {
  await invoke('wipe_keystore')
}
