import { beforeEach, describe, expect, it } from 'vitest'
import { addVaultBackup, parseVaultBackupFile, readVaultBackups, writeVaultBackups } from './vaults.js'
import { readBackup, BACKUP_TYPE, BACKUP_FORMAT_VERSION } from './backup.js'
import { encryptPayload } from './crypto.js'

/*
  THE FILES THE APP PARSES BEFORE IT TRUSTS ANYTHING.

  🚨 EVERY OTHER ADVERSARIAL SUITE HERE ATTACKS STATE THE APP WROTE ITSELF. This one attacks
  what a user HANDS it: a vault backup .txt and a full app backup .json, both picked from a
  file dialog, both parsed before any passphrase has been checked, and neither of which the app
  has any reason to believe it produced.

  ⚠️ THE INTERESTING DAMAGE HERE IS NOT CODE EXECUTION — it is a value that gets STORED and
  then cannot be got rid of. A signer is a device people keep for years; an entry that cannot
  be removed is a permanent fixture of a screen they have to read correctly before signing.
*/

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()
})

/* ─────────────── the vault backup .txt: a label is a DELETE CONFIRMATION ─────────────── */

describe('🚨 UNTRUSTED FILE: a vault label must stay typeable, because deleting requires typing it', () => {
  /*
    🚨 THE LABEL IS NOT DECORATION — IT IS THE DELETE CONFIRMATION. `VaultsScreen.tsx` gates
    removal on `typed.trim().toLowerCase() === entry.label.trim().toLowerCase()`, and
    `uniqueVaultLabel` already reasons about this ("the remove modal asks the user to TYPE THE
    LABEL to confirm, so two identically-named vaults make that confirmation unable to
    distinguish what is about to be deleted").

    What nobody checked is where the label COMES FROM. `parseVaultBackupFile` reads it off a
    `# Label:` line in a file the user picked, and `addVaultBackup` stored it verbatim — only
    trimmed. So a label the confirmation box cannot reproduce makes the entry PERMANENTLY
    UNDELETABLE:

      · an EMBEDDED NEWLINE — the confirm field is a single-line <Input>, so a newline simply
        cannot be typed, no matter how short and innocent the label looks on the card;
      · a CONTROL CHARACTER, invisible on screen and unreachable from a keyboard;
      · a 100 KB label, which nobody is going to retype and which drags through every render.

    None of that needs an attacker — a mangled export or a hand-edited file does it — but an
    attacker gets a permanent, attention-grabbing row on the screen a user must read correctly
    before they sign. Same failure family as the platform's own `safeText`
    and the same remedy: bound and clean the value AT THE BOUNDARY, not at each use.

    ⚠️ HEALED ON READ, NOT ONLY ON WRITE. `healEntries` already repairs ids on every read for
    exactly this reason — a guard on the add path alone cannot reach a row the restore path
    wrote wholesale, or one already sitting in storage.
  */
  const typeable = (label: string) => !/[\n\r\t\u0000-\u001f\u007f]/.test(label) && label.length <= 120

  it('strips an embedded NEWLINE, which a single-line confirm box can never reproduce', () => {
    const entry = addVaultBackup('Family\nVault', 'wsh(a)#aaaaaaaa')
    expect(typeable(entry.label), `label ${JSON.stringify(entry.label)} cannot be typed`).toBe(true)
    expect(entry.label).not.toContain('\n')
  })

  it('strips invisible control characters', () => {
    const entry = addVaultBackup('Fam\u0000ily\u0007', 'wsh(b)#aaaaaaaa')
    expect(typeable(entry.label)).toBe(true)
    expect(entry.label).toBe('Family')
  })

  it('bounds an absurdly long label', () => {
    const entry = addVaultBackup('V'.repeat(100_000), 'wsh(c)#aaaaaaaa')
    expect(typeable(entry.label)).toBe(true)
  })

  it('HEALS a row already in storage, not just new adds', () => {
    // What the app-backup restore path writes wholesale — it does not go through addVaultBackup.
    writeVaultBackups([
      { id: 'v1', label: 'Old\nBad\u0000Label', descriptor: 'wsh(d)#aaaaaaaa', savedAt: '2026-01-01T00:00:00.000Z' },
    ])
    const [healed] = readVaultBackups()
    expect(typeable(healed.label), 'a stored row must heal on read like a collided id does').toBe(true)
  })

  it('leaves an ordinary label completely alone', () => {
    // The guard must be invisible to everyone who is not being attacked. Accents, spaces and
    // punctuation are all perfectly typeable and must survive byte for byte.
    const ordinary = "Famille Dupont — 3 sur 5 (côté maman)"
    expect(addVaultBackup(ordinary, 'wsh(e)#aaaaaaaa').label).toBe(ordinary)
  })

  it('a label read off an untrusted FILE lands clean in storage', () => {
    // The whole path, end to end: hostile file → parse → save → what the delete box must match.
    const file = `# Label: Vault\u0000\nwsh(sortedmulti(2,[aaaaaaaa/48'/1'/0'/2']tpubAAA/0/*))#aaaaaaaa\n`
    const parsed = parseVaultBackupFile(file)
    const entry = addVaultBackup(parsed.label, parsed.descriptor)
    expect(typeable(entry.label)).toBe(true)
  })
})

/* ──────────────── the app backup .json: parsed before any passphrase ──────────────── */

describe('🚨 UNTRUSTED FILE: readBackup refuses a file it cannot vouch for', () => {
  /*
    These run BEFORE the passphrase is checked, so they are the only thing standing between a
    mis-picked (or hostile) file and the decrypt path. Pins rather than fixes — this half held
    on every attack — but the branches are load-bearing and nothing else asserts them.
  */
  const sealed = (payload: unknown, pass = 'pw') => ({
    type: BACKUP_TYPE,
    version: BACKUP_FORMAT_VERSION,
    createdWith: '0.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...encryptPayload(JSON.stringify(payload), pass),
  })

  it('refuses text that is not JSON at all', () => {
    expect(() => readBackup('not json {{{', 'pw')).toThrow(/isn't valid JSON|isn't a SignBit backup/)
  })

  it('refuses a JSON file that is not a SignBit backup', () => {
    expect(() => readBackup(JSON.stringify({ hello: 'world' }), 'pw')).toThrow(/isn't a SignBit backup/)
  })

  it('refuses a backup from a FUTURE format with an actionable message, not a decrypt failure', () => {
    const file = { ...sealed({ keys: [] }), version: BACKUP_FORMAT_VERSION + 1 }
    expect(() => readBackup(JSON.stringify(file), 'pw')).toThrow(/newer version/)
  })

  it('refuses a JSON primitive dressed up as a file', () => {
    for (const raw of ['null', '42', '"signbit-backup"', '[]']) {
      expect(() => readBackup(raw, 'pw')).toThrow()
    }
  })

  it('gives the SAME generic error for a wrong passphrase and a tampered ciphertext', () => {
    // No oracle: the two must be indistinguishable, or the message tells an attacker which
    // half of their guess was right.
    const file = sealed({ keys: [{ id: 'a', mnemonic: 'x' }] })
    const wrongPass = (() => {
      try {
        readBackup(JSON.stringify(file), 'WRONG')
      } catch (e) {
        return (e as Error).message
      }
    })()
    const tampered = (() => {
      try {
        readBackup(JSON.stringify({ ...file, tag: Buffer.alloc(16, 9).toString('base64') }), 'pw')
      } catch (e) {
        return (e as Error).message
      }
    })()
    expect(wrongPass).toBe(tampered)
  })

  it('refuses a decrypted payload carrying no usable keys', () => {
    for (const payload of [{ keys: [] }, { keys: 'not an array' }, { keys: [{ id: 'a' }] }, {}]) {
      expect(() => readBackup(JSON.stringify(sealed(payload)), 'pw')).toThrow(/no keys/i)
    }
  })

  it('does not let a backup pollute Object.prototype', () => {
    // JSON.parse itself is safe here (it defines own properties rather than invoking setters),
    // but the payload is spread and merged downstream, so assert the outcome rather than the
    // mechanism — this is the cheap check that catches a future refactor to a deep merge.
    const payload = {
      keys: [{ id: 'a', mnemonic: 'abandon about', label: 'k', createdAt: '' }],
      __proto__: { polluted: 'yes' },
      vaults: [{ id: 'v', descriptor: 'wsh(x)#aaaaaaaa', keyLabels: { __proto__: { bad: 1 } } }],
    }
    readBackup(JSON.stringify(sealed(payload)), 'pw')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).bad).toBeUndefined()
  })
})
