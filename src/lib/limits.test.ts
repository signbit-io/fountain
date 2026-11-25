import { describe, it, expect, vi } from 'vitest'
import {
  MAX_KEYS,
  MAX_VAULTS,
  BACKUP_SIZE_WARN_BYTES,
  assertCanAddKey,
  assertCanAddVault,
  shouldShowCount,
} from './limits.js'
import { MAX_BACKUP_IMPORT_BYTES } from './download.js'
import { createBackup, readBackup, type BackupPayload } from './backup.js'
import { restoreFromBackupFile, type RestoreEffects } from './restore.js'
import { decryptKeystore, type KeyEntry } from './crypto.js'

/*
  Capacity limits — and, more importantly, the ONE case that must never be limited.

  The asymmetry pinned here is the whole point of lib/limits.ts: adding is capped, RESTORING is
  not. A cap shipped today must never make a backup written yesterday unrecoverable. If a future
  refactor "tidies" the cap into a shared helper that both paths call, the restore test below is
  what fails.
*/

const PASS = 'correct horse battery staple'

function key(i: number): KeyEntry {
  return {
    id: `k${i}`,
    label: `Key ${i}`,
    mnemonic: 'abandon '.repeat(23) + 'about',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

// A realistic 3-of-5 descriptor — five full xpub key expressions, ~1.5 KB. This is what makes a
// backup big, far more than the keys themselves.
const KEY_EXPR =
  "[73c5da0a/48'/1'/0'/2']tpubDFH9dgzveyD8yHQb8VrpG8FnJBcpJqjPeQVYbGpTZY3E5v8xVhLPPjqPnVdNCPYbnJfMcWLbLBhpQjKvUFRvHRWZEheQ/0/*"
const DESCRIPTOR = `wsh(sortedmulti(3,${Array(5).fill(KEY_EXPR).join(',')}))#pmetja34`

function vault(i: number) {
  return {
    id: `v${i}`,
    label: `Vault ${i}`,
    descriptor: DESCRIPTOR,
    changeDescriptor: DESCRIPTOR.replace(/\/0\/\*/g, '/1/*'),
    savedAt: '2026-01-01T00:00:00.000Z',
  }
}

function spyEffects(): RestoreEffects {
  return {
    writeKeystore: vi.fn(async () => {}),
    writeVaults: vi.fn(),
    writeSettings: vi.fn(),
    writeLocale: vi.fn(),
  }
}

describe('add-path capacity guards', () => {
  it('allows adding below the cap', () => {
    expect(() => assertCanAddKey(0)).not.toThrow()
    expect(() => assertCanAddKey(MAX_KEYS - 1)).not.toThrow()
    expect(() => assertCanAddVault(MAX_VAULTS - 1)).not.toThrow()
  })

  it('refuses the one that would exceed the cap, and says what to do', () => {
    expect(() => assertCanAddKey(MAX_KEYS)).toThrow(/maximum of 1000 keys/i)
    expect(() => assertCanAddKey(MAX_KEYS)).toThrow(/remove one/i)
    expect(() => assertCanAddVault(MAX_VAULTS)).toThrow(/maximum of 1000 saved vaults/i)
  })

  it('stays refused past the cap (an over-limit device can not add more)', () => {
    expect(() => assertCanAddKey(MAX_KEYS + 500)).toThrow()
  })
})

describe('⚠️ RESTORE IS NEVER CAPPED — the guarantee that makes a cap safe to ship', () => {
  it('restores a backup holding MORE than MAX_KEYS keys, in full', async () => {
    // The scenario: someone accumulated 1200 keys before the cap existed (or on another build).
    // Refusing this would destroy their only route back to those seeds — the precise
    // recovery-path failure the caps were introduced to remove.
    const over = MAX_KEYS + 200
    const payload: BackupPayload = { keys: Array.from({ length: over }, (_, i) => key(i)), vaults: [] }
    const raw = JSON.stringify(createBackup(payload, PASS))
    const effects = spyEffects()

    const result = await restoreFromBackupFile(raw, PASS, effects)

    expect(result.keys).toHaveLength(over)
    // And the keystore actually COMMITTED all of them — not silently truncated to the cap.
    const written = vi.mocked(effects.writeKeystore).mock.calls[0][0]
    expect(decryptKeystore(written, PASS)).toHaveLength(over)
  })

  it('reads an over-limit backup without complaint', () => {
    const payload: BackupPayload = {
      keys: Array.from({ length: MAX_KEYS + 1 }, (_, i) => key(i)),
      vaults: [],
    }
    const raw = JSON.stringify(createBackup(payload, PASS))
    expect(() => readBackup(raw, PASS)).not.toThrow()
  })
})

describe('byte caps', () => {
  it('a backup that would have failed the OLD 1 MB cap now round-trips', () => {
    // A realistic full signer: keys AND saved vaults. Vault descriptors are the bulky part
    // (five full xpub key expressions each), which is exactly why the old keystore-sized 1 MB
    // bound stopped fitting once backups started carrying them.
    const payload: BackupPayload = {
      keys: Array.from({ length: 800 }, (_, i) => key(i)),
      vaults: Array.from({ length: 800 }, (_, i) => vault(i)),
    }
    const raw = JSON.stringify(createBackup(payload, PASS))

    expect(raw.length).toBeGreaterThan(1024 * 1024) // would have been rejected before
    expect(raw.length).toBeLessThan(MAX_BACKUP_IMPORT_BYTES) // and is accepted now
    const back = readBackup(raw, PASS)
    expect(back.keys).toHaveLength(800)
    expect(back.vaults).toHaveLength(800)
  })

  it('keeps the export warn threshold below the hard read cap', () => {
    // If these ever cross, the app would warn about a size it has already refused to write —
    // or worse, write a file it can never read back.
    expect(BACKUP_SIZE_WARN_BYTES).toBeLessThan(MAX_BACKUP_IMPORT_BYTES)
  })

  it('sizes the entity caps so they can never reach the byte cap', () => {
    // The entity cap is the USER-FACING limit; the byte cap is only the memory bound underneath.
    // A full-capacity backup must fit comfortably, or a user could hit the invisible limit first.
    // The true worst case: BOTH caps maxed out at once.
    const full: BackupPayload = {
      keys: Array.from({ length: MAX_KEYS }, (_, i) => key(i)),
      vaults: Array.from({ length: MAX_VAULTS }, (_, i) => vault(i)),
    }
    const raw = JSON.stringify(createBackup(full, PASS))
    expect(raw.length).toBeLessThan(MAX_BACKUP_IMPORT_BYTES)
  })
})

describe('count display threshold', () => {
  it('stays hidden for a normal user and appears approaching the cap', () => {
    expect(shouldShowCount(0, MAX_KEYS)).toBe(false)
    expect(shouldShowCount(12, MAX_KEYS)).toBe(false) // a heavy-but-ordinary signer
    expect(shouldShowCount(MAX_KEYS / 2, MAX_KEYS)).toBe(true)
    expect(shouldShowCount(MAX_KEYS, MAX_KEYS)).toBe(true)
  })
})
