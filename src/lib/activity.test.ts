import { beforeEach, describe, expect, it } from 'vitest'
import { readSettings, readSettingsResult, writeSettings, type AppSettings } from './activity'

// Minimal in-memory localStorage shim (Node test env has no DOM). activity.ts only uses
// getItem/setItem/removeItem.
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
  clear() {
    this.m.clear()
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()
})

const BASE: AppSettings = { autoLockMinutes: 5, theme: 'system', network: 'testnet' }

describe('settings', () => {
  it('defaults a FRESH INSTALL to a 5-minute auto-lock, system theme, and MAINNET', () => {
    expect(readSettings()).toEqual({ autoLockMinutes: 5, theme: 'system', network: 'mainnet' })
  })

  it('round-trips a valid auto-lock value', () => {
    writeSettings({ ...BASE, autoLockMinutes: 15 })
    expect(readSettings().autoLockMinutes).toBe(15)
    writeSettings({ ...BASE, autoLockMinutes: 0 }) // never
    expect(readSettings().autoLockMinutes).toBe(0)
  })

  it('rejects an invalid persisted value, falling back to the default', () => {
    localStorage.setItem('signbit.settings', JSON.stringify({ autoLockMinutes: 999 }))
    expect(readSettings().autoLockMinutes).toBe(5)
  })

  it('round-trips the theme preference and rejects an invalid one', () => {
    writeSettings({ ...BASE, theme: 'dark' })
    expect(readSettings().theme).toBe('dark')
    writeSettings({ ...BASE, theme: 'light' })
    expect(readSettings().theme).toBe('light')
    localStorage.setItem('signbit.settings', JSON.stringify({ autoLockMinutes: 5, theme: 'neon' }))
    expect(readSettings().theme).toBe('system') // invalid → default
  })
})

/*
  The network preference. These pin the asymmetry that matters: the ONLY way to end up on
  mainnet is a genuinely fresh install or an explicit choice. Every degraded path — corrupt
  blob, invalid value, an upgrade from a pre-mainnet build — resolves to testnet, because
  reading mainnet when the user meant testnet silently points a signer at real funds after an
  event the user never initiated.
*/
describe('settings — network', () => {
  it('round-trips an explicit choice in both directions', () => {
    writeSettings({ ...BASE, network: 'mainnet' })
    expect(readSettings().network).toBe('mainnet')
    writeSettings({ ...BASE, network: 'testnet' })
    expect(readSettings().network).toBe('testnet')
  })

  it('falls back to TESTNET when the stored blob is unparseable, and flags it', () => {
    localStorage.setItem('signbit.settings', '{ this is not json')
    const r = readSettingsResult()
    expect(r.settings.network).toBe('testnet')
    expect(r.corrupted).toBe(true)
  })

  it('falls back to TESTNET on an invalid network value, and flags it', () => {
    localStorage.setItem('signbit.settings', JSON.stringify({ ...BASE, network: 'dogecoin' }))
    const r = readSettingsResult()
    expect(r.settings.network).toBe('testnet')
    expect(r.corrupted).toBe(true)
  })

  it('treats a PRE-MAINNET blob (no network field) as testnet WITHOUT flagging corruption', () => {
    // An upgrading user was on testnet by definition — that is their real previous state, not
    // an error, and promoting them to mainnet on update would be exactly the wrong surprise.
    localStorage.setItem('signbit.settings', JSON.stringify({ autoLockMinutes: 15, theme: 'dark' }))
    const r = readSettingsResult()
    expect(r.settings.network).toBe('testnet')
    expect(r.corrupted).toBe(false)
    expect(r.settings.autoLockMinutes).toBe(15) // the rest of their prefs survive
  })

  it('rejects signet — it has no UI here, so it must not arrive by hand-edit', () => {
    localStorage.setItem('signbit.settings', JSON.stringify({ ...BASE, network: 'signet' }))
    expect(readSettings().network).toBe('testnet')
  })

  it('a fresh install is NOT reported as corrupted', () => {
    expect(readSettingsResult().corrupted).toBe(false)
  })
})
