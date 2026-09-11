import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  encryptKeystore,
  decryptKeystore,
  newId,
  type KeyEntry,
} from './crypto'
import { loadKeystore, saveKeystore, restoreKeystore, wipeKeystore } from './storage'
import type { EncryptedKeystore } from './crypto'
import { generateKey, accountKey, isValidMnemonic, findDuplicateMnemonic, networkOf } from './key'
import type { AccountKey, NetworkName } from './key'
import { restoreFromKeystoreFile, restoreFromBackupFile, changePassphrase as changePassphraseSeq } from './restore'
import { wipeDevice } from './reset'
import { writeVaultBackups } from './vaults'
import { writeSettings, clearSettings } from './activity'
import { assertCanAddKey } from './limits'

/*
  App keystore state — the single source of truth for the vault of keys and the lock state.
  Holds the passphrase in memory ONLY while unlocked (needed to re-encrypt on every change);
  it is never persisted. Locking drops both the passphrase and the decrypted entries.
*/

type Status = 'loading' | 'empty' | 'locked' | 'unlocked'

type KeystoreContextValue = {
  status: Status
  entries: KeyEntry[]
  /** First-run: set the passphrase (no file yet). */
  initialize: (passphrase: string) => Promise<void>
  unlock: (passphrase: string) => Promise<void>
  /**
   * Restore from a keystore file (an auto-detected previous keystore or a user-picked one):
   * verify the passphrase decrypts it, copy it into active storage, then unlock. Throws
   * (nothing written) if the passphrase is wrong for that file.
   */
  restoreFrom: (store: EncryptedKeystore, passphrase: string) => Promise<void>
  /**
   * Restore from a full APP BACKUP file (keys + vault descriptors + prefs) — the cross-device
   * path. `raw` is the file's text. Throws (nothing written) on a wrong passphrase, a tampered
   * file, or a backup from a newer format version.
   */
  restoreFromBackup: (raw: string, passphrase: string) => Promise<void>
  /** Lock the keystore. `auto` = triggered by the idle timer (logged distinctly). */
  lock: (auto?: boolean) => void
  /**
   * Create a fresh key STAMPED with `network` — the network it will derive at for good.
   * Returns the new entry (so the UI can show the mnemonic once).
   */
  createKey: (label: string, network: NetworkName) => Promise<KeyEntry>
  /** Import an existing mnemonic, stamped with `network` (see createKey). */
  importKey: (label: string, mnemonic: string, network: NetworkName) => Promise<KeyEntry>
  removeKey: (id: string) => Promise<void>
  /** Rename a key's label (in place — id/mnemonic untouched). */
  renameKey: (id: string, label: string) => Promise<void>
  /**
   * Public export (tpub/fp/path) for a stored key, derived at THAT KEY'S OWN network.
   * Takes no network argument on purpose — see the implementation's note.
   */
  exportPublic: (id: string) => AccountKey
  /** The mnemonic for a key (used by signing screens; stays in-process). */
  mnemonicFor: (id: string) => string
  /** Re-verify the unlock passphrase (for a sensitive action like revealing a seed). */
  verifyPassphrase: (passphrase: string) => Promise<boolean>
  /**
   * Re-encrypt the keystore under a new passphrase, in place. Keys are untouched; only the
   * envelope changes. Throws (nothing written) if `current` is wrong.
   *
   * ⚠️ Existing EXPORTED backup files keep the passphrase they were written with — there is no
   * way to reach into a file the user has already stored elsewhere. The UI says so and offers a
   * fresh export.
   */
  changePass: (current: string, next: string) => Promise<void>
  /**
   * RESET THIS DEVICE — delete the keystore and local caches, returning the app to first run.
   * Irreversible: any seed not written down is gone. Reached from the lock screen (the user
   * cannot unlock), so it deliberately requires no passphrase; the UI owns the confirmations.
   */
  resetDevice: () => Promise<void>
}

/*
  How long to wait for the boot keystore probe before showing the lock screen anyway.

  Sized as "clearly broken", not "slow": reading one local file should take milliseconds, so
  five seconds is far beyond any legitimate cold start (including a phone's first launch)
  while still being short enough that a user does not conclude the app is dead. It is a
  DEADLOCK ESCAPE, not a performance budget — a late answer still corrects the screen.
*/
const BOOT_PROBE_TIMEOUT_MS = 5_000

const KeystoreContext = createContext<KeystoreContextValue | null>(null)

export function KeystoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [entries, setEntries] = useState<KeyEntry[]>([])

  /*
    On boot: is there a keystore file? → locked; else → empty (first run).

    🚨 THE BOOT PROBE IS BOUNDED, because `status` starting at 'loading' is a state with NO
    ESCAPE. `loadKeystore()` is a Tauri IPC round trip to the Rust side; if that never
    settles — the shell not ready, a wedged command, a WebView reload racing it — then
    neither `.then` nor `.catch` ever runs, `status` stays 'loading' forever, and App renders
    a bare centred "Loading…" with no button, no lock screen, and no way for the user to do
    anything but kill the app. A promise that never settles is not an error anyone catches.

    ⚠️ THE TIMEOUT RESOLVES TO 'locked', NOT 'empty'. Those are very different screens:
    'empty' is FIRST RUN and invites the user to choose a new passphrase, which on a device
    that already holds keys reads as "your keys are gone". 'locked' offers unlock plus the
    restore path, which is correct whether or not a keystore actually exists — an unlock
    against no keystore simply fails and says so. When we do not know, present the screen
    whose wrong case is recoverable rather than alarming.

    ⚠️ A LATE ANSWER STILL WINS. The probe is not cancelled, so if it settles after the
    timeout it corrects the status and a merely slow boot lands in the right place.
    `probeAnswered` guards only the reverse direction — the timeout must never overwrite a
    real answer — and `cancelled` covers unmount.
  */
  useEffect(() => {
    let cancelled = false
    let probeAnswered = false

    loadKeystore()
      .then((store) => {
        probeAnswered = true
        // A late answer still corrects the fallback — a slow boot must not strand the user
        // on the wrong screen once the truth arrives.
        if (!cancelled) setStatus(store ? 'locked' : 'empty')
      })
      .catch(() => {
        probeAnswered = true
        if (!cancelled) setStatus('empty')
      })

    // Generous: this is a local file probe, so anything beyond a second or two means
    // something is wrong rather than slow. Long enough not to pre-empt a cold start.
    const timer = setTimeout(() => {
      if (!cancelled && !probeAnswered) setStatus('locked')
    }, BOOT_PROBE_TIMEOUT_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const persist = useCallback(async (next: KeyEntry[], pass: string) => {
    await saveKeystore(encryptKeystore(next, pass))
  }, [])

  const initialize = useCallback(async (pass: string) => {
    if (!pass) throw new Error('Choose a passphrase')
    await persist([], pass)
    setPassphrase(pass)
    setEntries([])
    setStatus('unlocked')
  }, [persist])

  const unlock = useCallback(async (pass: string) => {
    const store = await loadKeystore()
    if (!store) {
      // Raced with a fresh install — treat as first run.
      setStatus('empty')
      return
    }
    const decrypted = decryptKeystore(store, pass) // throws on wrong passphrase

    /*
      ONE-SHOT MIGRATION — stamp any key written before mainnet support existed.

      Such a key was necessarily created on testnet, so the value is known, not guessed. Doing
      it here (rather than leaning on networkOf()'s fallback forever) means the "unstamped"
      state lasts a single session: after this, every entry says out loud what it derives at,
      and the fallback stops being load-bearing.

      Best-effort on the WRITE only. If persisting fails we still hand back the stamped entries
      for this session — a failed cosmetic migration must never block an unlock, and the next
      successful save will carry the stamps anyway.
    */
    const needsStamp = decrypted.some((e) => !e.network)
    const entries = needsStamp ? decrypted.map((e) => ({ ...e, network: networkOf(e) })) : decrypted
    if (needsStamp) {
      try {
        await persist(entries, pass)
      } catch {
        /* ignore — see above */
      }
    }

    setPassphrase(pass)
    setEntries(entries)
    setStatus('unlocked')
  }, [persist])

  /*
    Both restore paths delegate their SEQUENCE to lib/restore.ts, which owns the two ordering
    guarantees the user's keys rest on — verify-before-write, and keys-before-side-stores. That
    lives there (not inline here) so it is testable against real crypto without React: an
    ordering is exactly what a careless refactor inverts silently, and a test that had to
    transcribe the sequence would assert a copy while the real code drifted. This hook keeps
    only what is genuinely React's job — turning the result into state.

    Both throw with nothing written if the file can't be opened, so the restore screen can
    surface the error and leave the active keystore untouched.
  */
  const restoreEffects = useMemo(
    () => ({
      writeKeystore: restoreKeystore,
      writeVaults: writeVaultBackups,
      writeSettings,
      writeLocale: (locale: string) => localStorage.setItem('signbit.locale', locale),
    }),
    [],
  )

  const restoreFrom = useCallback(
    async (store: EncryptedKeystore, pass: string) => {
      const decrypted = await restoreFromKeystoreFile(store, pass, restoreEffects)
      setPassphrase(pass)
      setEntries(decrypted)
      setStatus('unlocked')
    },
    [restoreEffects],
  )

  const restoreFromBackup = useCallback(
    async (raw: string, pass: string) => {
      const payload = await restoreFromBackupFile(raw, pass, restoreEffects)
      setPassphrase(pass)
      setEntries(payload.keys)
      setStatus('unlocked')
    },
    [restoreEffects],
  )

  // `auto` distinguishes an idle auto-lock from a manual Lock (kept for future UI use).
  const lock = useCallback((_auto = false) => {
    setPassphrase(null)
    setEntries([])
    setStatus('locked')
  }, [])

  const addEntry = useCallback(
    async (label: string, mnemonic: string, network: NetworkName): Promise<KeyEntry> => {
      if (!passphrase) throw new Error('Locked')
      // Capacity guard on the ADD path only — createKey and importKey both funnel through here.
      // Restore deliberately bypasses this (see lib/limits.ts): a cap added today must never
      // make an existing backup unrecoverable.
      assertCanAddKey(entries.length)
      const entry: KeyEntry = {
        id: newId(),
        label: label.trim() || 'Key',
        mnemonic,
        createdAt: new Date().toISOString(),
        // Stamped ONCE, here, and never changed afterwards — this is what the key derives at
        // for the rest of its life. Everything downstream reads the stamp, not the app's
        // current toggle (see KeyEntry.network).
        network,
      }
      const next = [...entries, entry]
      await persist(next, passphrase)
      setEntries(next)
      return entry
    },
    [entries, passphrase, persist],
  )

  const createKey = useCallback(
    (label: string, network: NetworkName) => addEntry(label, generateKey(), network),
    [addEntry],
  )

  const importKey = useCallback(
    (label: string, mnemonic: string, network: NetworkName) => {
      const m = mnemonic.trim().replace(/\s+/g, ' ').toLowerCase()
      if (!isValidMnemonic(m)) throw new Error('That is not a valid BIP-39 seed phrase.')
      // Duplicates stay blocked regardless of network. Allowing the same seed twice under two
      // stamps would give two entries one master fingerprint, and backup-diff identifies keys
      // BY fingerprint — the pair would collapse into a single diff row and hide one of them
      // from the destructive-import warning.
      const dupe = findDuplicateMnemonic(entries, m)
      if (dupe) throw new Error(`This seed phrase is already imported as "${dupe.label}".`)
      return addEntry(label, m, network)
    },
    [addEntry, entries],
  )

  const removeKey = useCallback(
    async (id: string) => {
      if (!passphrase) throw new Error('Locked')
      const next = entries.filter((e) => e.id !== id)
      await persist(next, passphrase)
      setEntries(next)
    },
    [entries, passphrase, persist],
  )

  const renameKey = useCallback(
    async (id: string, label: string) => {
      if (!passphrase) throw new Error('Locked')
      const trimmed = label.trim()
      if (!trimmed) throw new Error('Enter a label')
      const next = entries.map((e) => (e.id === id ? { ...e, label: trimmed } : e))
      await persist(next, passphrase)
      setEntries(next)
    },
    [entries, passphrase, persist],
  )

  /*
    ⚠️ Deliberately takes NO network argument. The network a key derives at is a property of
    the KEY, and every caller here is displaying/exporting one specific key — so there is
    exactly one right answer and no reason to let a call site choose. Passing the app's global
    toggle (which all three call sites used to do) silently re-derives a DIFFERENT xpub for an
    already-enrolled seed. Keeping the parameter would mean re-auditing every future caller;
    removing it makes the mistake unrepresentable.
  */
  const exportPublic = useCallback(
    (id: string): AccountKey => {
      const entry = entries.find((e) => e.id === id)
      if (!entry) throw new Error('Key not found')
      return accountKey(entry.mnemonic, networkOf(entry))
    },
    [entries],
  )

  const mnemonicFor = useCallback(
    (id: string): string => {
      const entry = entries.find((e) => e.id === id)
      if (!entry) throw new Error('Key not found')
      return entry.mnemonic
    },
    [entries],
  )

  // Re-verify the passphrase for a sensitive action (e.g. revealing a seed) WITHOUT
  // trusting the in-memory `passphrase`: re-load the on-disk envelope and attempt a real
  // decrypt with the entered value. Same crypto path as unlock — wrong passphrase → false.
  const verifyPassphrase = useCallback(async (pass: string): Promise<boolean> => {
    try {
      const store = await loadKeystore()
      if (!store) return false
      decryptKeystore(store, pass) // throws on wrong passphrase (GCM auth-tag failure)
      return true
    } catch {
      return false
    }
  }, [])

  /*
    Change passphrase + reset both delegate their SEQUENCE to a lib module for the same reason
    the restore paths do (see the note above): each encodes an ordering the user's keys rest on,
    and an ordering tested through a hook can only be asserted as a transcribed copy. Here the
    hook keeps only what is React's job — turning the result into state.
  */
  const changePass = useCallback(
    async (current: string, next: string) => {
      const store = await loadKeystore()
      if (!store) throw new Error('No keystore to change')
      // Re-encrypts and verifies the new envelope opens BEFORE overwriting the working one;
      // throws with nothing written if `current` is wrong.
      const decrypted = await changePassphraseSeq(store, current, next, { writeKeystore: saveKeystore })
      // Only now does the in-memory passphrase move — it must match what is actually on disk,
      // or every subsequent save would re-encrypt under a passphrase the keystore no longer uses.
      setPassphrase(next)
      setEntries(decrypted)
    },
    [],
  )

  const resetDevice = useCallback(async () => {
    // Throws (nothing cleared) if the keystore file survives, so the UI can report honestly.
    await wipeDevice({
      wipeKeystore,
      clearVaults: () => writeVaultBackups([]),
      clearSettings: clearSettings,
    })
    // Back to first run. Drop every trace from memory too — the entries array outliving a wipe
    // would leave seeds readable in a tab the user believes they just erased.
    setPassphrase(null)
    setEntries([])
    setStatus('empty')
  }, [])

  return (
    <KeystoreContext.Provider
      value={{
        status,
        entries,
        initialize,
        unlock,
        restoreFrom,
        restoreFromBackup,
        lock,
        createKey,
        importKey,
        removeKey,
        renameKey,
        exportPublic,
        mnemonicFor,
        verifyPassphrase,
        changePass,
        resetDevice,
      }}
    >
      {children}
    </KeystoreContext.Provider>
  )
}

export function useKeystore(): KeystoreContextValue {
  const ctx = useContext(KeystoreContext)
  if (!ctx) throw new Error('useKeystore must be used within KeystoreProvider')
  return ctx
}
