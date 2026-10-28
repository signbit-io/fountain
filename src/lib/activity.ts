/*
  Non-secret app settings (auto-lock timeout, theme).

  A local security-event log used to live here too, but it was removed: a localStorage log is
  security theater against its own threat model — a host-level attacker who can act as the user
  can also just delete the localStorage entry, so the log gave false assurance rather than real
  tamper-evidence. Real tamper-evidence needs an append-only store the app can't rewrite (OS/
  hardware), out of scope until a hardware-storage tier.
*/

import type { NetworkName } from './bitcoin-network.js'

const SETTINGS_KEY = 'signbit.settings'

/* ----- non-secret settings (auto-lock, theme) ----------------------------------------- */

export type AutoLockMinutes = 0 | 1 | 5 | 15 | 30 // 0 = never

// 'system' follows the OS preference (default); the palette itself lives in index.css.
export type ThemePref = 'light' | 'dark' | 'system'

export type AppSettings = {
  autoLockMinutes: AutoLockMinutes
  theme: ThemePref
  /** Which network the app is working on. Decides what NEW keys are stamped with, and what the
   *  UI shows — never how an existing key derives (that is KeyEntry.network). */
  network: NetworkName
}

/*
  ⚠️ TWO different defaults, deliberately.

  A FRESH INSTALL starts on mainnet — this is a real-bitcoin product and presenting as a test
  tool by default would be wrong.

  But a CORRUPTED settings blob must fall back to TESTNET, not to the fresh-install default.
  The failure directions are not symmetric: reading testnet when the user meant mainnet is an
  inconvenience they will notice immediately, while reading mainnet when the user meant testnet
  silently points a signer at real funds after an event the user never initiated. Corruption is
  rare (an interrupted localStorage write, a damaged profile, a hand-edit) but it must not be
  able to move someone toward real money on its own.

  readSettings therefore distinguishes "nothing stored" from "stored but unreadable", which the
  old single-DEFAULT_SETTINGS shape could not.
*/
const FRESH_INSTALL: AppSettings = { autoLockMinutes: 5, theme: 'system', network: 'mainnet' }
const SAFE_FALLBACK_NETWORK: NetworkName = 'testnet'

/** What readSettings found, so the UI can warn when stored settings were unreadable. */
export type SettingsRead = {
  settings: AppSettings
  /** True when a settings blob EXISTED but could not be read — the app fell back to testnet. */
  corrupted: boolean
}

/** Read settings, reporting whether stored values had to be discarded. */
export function readSettingsResult(): SettingsRead {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SETTINGS_KEY)
  } catch {
    // localStorage itself unavailable — nothing was stored to lose, so this is a fresh start,
    // not corruption.
    return { settings: FRESH_INSTALL, corrupted: false }
  }
  if (!raw) return { settings: FRESH_INSTALL, corrupted: false }

  let parsed: Partial<AppSettings>
  try {
    parsed = JSON.parse(raw) as Partial<AppSettings>
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
  } catch {
    // Settings EXISTED and are unreadable → the safe direction, and say so.
    return { settings: { ...FRESH_INSTALL, network: SAFE_FALLBACK_NETWORK }, corrupted: true }
  }

  const validMinutes: AutoLockMinutes[] = [0, 1, 5, 15, 30]
  const validThemes: ThemePref[] = ['light', 'dark', 'system']
  // Only the two the UI can actually choose. 'signet' exists in NetworkName but has no UI here,
  // so a hand-edited "signet" is treated as invalid rather than silently half-supported.
  const validNetworks: NetworkName[] = ['testnet', 'mainnet']

  const networkValid = validNetworks.includes(parsed.network as NetworkName)
  return {
    settings: {
      autoLockMinutes: validMinutes.includes(parsed.autoLockMinutes as AutoLockMinutes)
        ? (parsed.autoLockMinutes as AutoLockMinutes)
        : FRESH_INSTALL.autoLockMinutes,
      theme: validThemes.includes(parsed.theme as ThemePref) ? (parsed.theme as ThemePref) : FRESH_INSTALL.theme,
      /*
        Anything but a valid network → testnet, covering two distinct cases that both want it:

         - ABSENT: a settings blob written before mainnet existed. That user WAS on testnet, so
           testnet is their actual previous state. An upgrade must never silently promote an
           existing user to mainnet — only a genuinely fresh install (no blob at all, handled
           above) starts there.
         - PRESENT BUT INVALID: corruption. Safe direction, and flagged below.
      */
      network: networkValid ? (parsed.network as NetworkName) : SAFE_FALLBACK_NETWORK,
    },
    // Only the second case is worth warning about — an upgrading user did nothing wrong.
    corrupted: parsed.network !== undefined && !networkValid,
  }
}

export function readSettings(): AppSettings {
  return readSettingsResult().settings
}

export function writeSettings(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

/** Drop stored settings so the next read returns defaults — used by the device reset. Removing
 *  the key (rather than writing DEFAULT_SETTINGS) keeps "never configured" and "reset to
 *  defaults" indistinguishable, which is what a reset should leave behind. */
export function clearSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_KEY)
    localStorage.removeItem(MOTION_KEY)
  } catch {
    /* ignore */
  }
}

/* ----- theme application -------------------------------------------------------------- */

/** Resolve a theme preference to the concrete mode, consulting the OS for 'system'. */
export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return pref
}

/**
 * Apply a theme preference to <html> by toggling the `.dark` class (Tailwind darkMode:'class').
 * The `.dark` palette is defined in index.css; here we only flip the switch.
 */
export function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', resolveTheme(pref) === 'dark')
}

/* ----- animations ---------------------------------------------------------------------- */

/*
  Animations on or off (user, 2026-10-28: on by default, a switch in Settings). A device display
  preference, like the OS's own reduce-motion setting, so it is NOT part of AppSettings and does
  not travel in a backup. Off adds `.motion-off` to <html>, which index.css treats exactly like
  `prefers-reduced-motion: reduce`; the OS setting still wins when this is on.
*/
const MOTION_KEY = 'signbit.motion'

export function readMotion(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeMotion(on: boolean): void {
  try {
    if (on) localStorage.removeItem(MOTION_KEY)
    else localStorage.setItem(MOTION_KEY, 'off')
  } catch {
    /* ignore */
  }
}

export function applyMotion(on: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('motion-off', !on)
}
