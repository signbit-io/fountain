import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldAutoLock, msUntilAutoLock } from './auto-lock.js'

/*
  🚨 **THE AUTO-LOCK WINDOW STARTS WHEN THE KEYSTORE UNLOCKS, NOT BEFORE IT.**

  THE BUG (Android, user, 2026-09-19): *"when entering my password. sometimes it just locks
  instantly even on successful password."*

  `lastActivityAt` is a ref on a component that stays mounted across a lock, so it held the
  timestamp of the PREVIOUS session. Lock, leave the app longer than the timeout — on Android
  the OS backgrounds it, so that is the ordinary case — then unlock: the effect re-activates,
  arms for a remaining time of 0 against that stale timestamp, and locks on the spot. The
  passphrase was right; the window it reopened had already expired before it was typed.

  ⚠️ **"Sometimes" was a RACE.** Activity listeners attach only while unlocked, so a touch
  landing before the 0ms timer reset the clock and the session survived; losing that race
  locked it. Nothing about the passphrase differed between the two outcomes — which is exactly
  why it read as flaky rather than as a rule.

  ⚠️ **The pure policy in `auto-lock.ts` was never wrong**, and that is the point worth keeping:
  a correct decision function fed a stale input gives a confidently wrong answer. The tests
  below cover the INPUT, which is where the defect lived.
*/

const MIN = 5
const MINUTE = 60_000

describe('the stale-timestamp arithmetic that produced the instant lock', () => {
  it('a timestamp from before the lock is ALREADY overdue at unlock', () => {
    // The state the app was in: last activity 10 minutes ago, 5-minute timeout, just unlocked.
    const lastActivityBeforeLock = 0
    const unlockedAt = 10 * MINUTE
    expect(shouldAutoLock(lastActivityBeforeLock, unlockedAt, MIN)).toBe(true)
    expect(msUntilAutoLock(lastActivityBeforeLock, unlockedAt, MIN)).toBe(0)
  })

  it('🚨 restamping at unlock gives the user the FULL window', () => {
    const unlockedAt = 10 * MINUTE
    // What the fix does: the clock starts at the unlock.
    expect(shouldAutoLock(unlockedAt, unlockedAt, MIN)).toBe(false)
    expect(msUntilAutoLock(unlockedAt, unlockedAt, MIN)).toBe(MIN * MINUTE)
  })

  it('⚠️ and the window still EXPIRES normally from there', () => {
    // The fix must not become "unlocking disables auto-lock".
    const unlockedAt = 10 * MINUTE
    expect(shouldAutoLock(unlockedAt, unlockedAt + MIN * MINUTE, MIN)).toBe(true)
    expect(shouldAutoLock(unlockedAt, unlockedAt + MIN * MINUTE - 1, MIN)).toBe(false)
  })
})

/*
  Source scrape: this repo's vitest runs in a NODE environment with no DOM and no
  testing-library, and adding either to test one line would buy a dependency to check a
  dependency — against the standing rule that every package is a liability. What is asserted
  here is that the hook restamps on activation, which is the whole fix.
*/
const APP = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
const hook = APP.slice(APP.indexOf('function useAutoLock'))
const body = hook.slice(0, hook.indexOf('\n}\n'))

describe('the hook restamps the activity clock when it activates', () => {
  it('writes lastActivityAt at the top of the effect', () => {
    const effect = body.slice(body.indexOf('useEffect(() => {'))
    const beforeArm = effect.slice(0, effect.indexOf('const check ='))
    expect(beforeArm).toMatch(/lastActivityAt\.current = Date\.now\(\)/)
  })

  it('does so AFTER the enabled guard — a disabled auto-lock changes nothing', () => {
    const effect = body.slice(body.indexOf('useEffect(() => {'))
    const guard = effect.indexOf('if (!active || !isAutoLockEnabled(minutes)) return')
    const stamp = effect.indexOf('lastActivityAt.current = Date.now()')
    expect(guard).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(guard)
  })

  it('🚨 focus and visibility still CHECK rather than restamp', () => {
    /*
      The security half. Returning to a window is not activity: if resume restamped, a stolen
      sleeping device would resume unlocked forever, which is the entire reason `auto-lock.ts`
      decides on wall-clock time instead of timer delivery.
    */
    expect(body).toMatch(/window\.addEventListener\('focus', check\)/)
    expect(body).toMatch(/document\.addEventListener\('visibilitychange', check\)/)
    expect(body).not.toMatch(/addEventListener\('focus', onActivity\)/)
    expect(body).not.toMatch(/addEventListener\('visibilitychange', onActivity\)/)
  })
})
