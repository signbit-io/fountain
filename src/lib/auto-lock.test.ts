import { describe, it, expect } from 'vitest'
import { shouldAutoLock, msUntilAutoLock, isAutoLockEnabled } from './auto-lock'

/*
  ADVERSARIAL — AUTO-LOCK, FROM THE DEVICE ATTACKER'S SIDE. Gate ①b
  `adversarial-pentest-pass`, Fountain half.

  🚨 **"PEN-TEST" IS THE WRONG WORD HERE AND THE GATE ROW SAYS SO** — the app is air-gapped,
  there is no request to forge. Which means the ONLY attacker it has is someone holding the
  device. Every test below is written from that seat: the machine is in their hands, and the
  question is whether the keystore is unlocked when they open the lid.

  🚨 **THE DEFECT THIS FILE PINS: `setTimeout` IS NOT A CLOCK.** Auto-lock was a bare
  `setTimeout(lock, minutes * 60_000)`, re-armed on user input. Timers do not advance while
  the OS is suspended, so closing the lid FROZE the countdown. A signer left unlocked and
  suspended resumed unlocked, no matter how long it had been in someone else's bag — the
  single most likely way this app is ever attacked.

  ⚠️ **WHY NOTHING CAUGHT IT.** `activity.test.ts` does test `autoLockMinutes`, but only as a
  SETTING: that it persists, that it round-trips, that a garbage value falls back to 5. The
  CONTROL — does the keystore actually lock — had no test at all. A setting that is faithfully
  stored and never enforced reads as covered on any grep for "autoLock".

  ⚠️ **These are pure-function tests on purpose.** The bug is about elapsed WALL-CLOCK time,
  so the test must be able to say "three days passed while the process was frozen" — which a
  real timer in a Node test environment can never demonstrate.
*/

const MIN = 60_000
/** A fixed, arbitrary epoch to measure from — no dependence on the real clock. */
const T0 = 1_800_000_000_000

describe('ADVERSARIAL — auto-lock against an attacker holding the device', () => {
  /* ───────────────────── the suspend attack ───────────────────── */

  /*
    🚨 **THE HEADLINE CASE: LID CLOSED, LAPTOP STOLEN, LID OPENED.** Under the old
    timer-only design the countdown was frozen for the whole theft and the attacker found an
    unlocked keystore. Decided on elapsed wall-clock time, three days is unambiguously past
    a 5-minute timeout no matter what the timer did or did not deliver.
  */
  it('🚨 locks after a 3-day suspend, even though no timer ever fired', () => {
    const threeDays = 3 * 24 * 60 * MIN
    expect(shouldAutoLock(T0, T0 + threeDays, 5)).toBe(true)
  })

  it('🚨 locks after a suspend of just over the timeout', () => {
    expect(shouldAutoLock(T0, T0 + 5 * MIN + 1, 5)).toBe(true)
  })

  /*
    ⚠️ **THE BOUNDARY IS INCLUSIVE — exactly the timeout LOCKS.** An exclusive boundary
    leaves a keystore unlocked at precisely the moment the user was promised it would not be.
    Where a boundary has to fall on a security control, it falls on the safe side.
  */
  it('locks at EXACTLY the timeout, not one millisecond later', () => {
    expect(shouldAutoLock(T0, T0 + 5 * MIN, 5)).toBe(true)
  })

  it('does NOT lock a moment before the timeout (the control is not overeager)', () => {
    expect(shouldAutoLock(T0, T0 + 5 * MIN - 1, 5)).toBe(false)
  })

  /* ───────────────────── clock tampering ───────────────────── */

  /*
    🚨 **AN ATTACKER HOLDING THE MACHINE CAN SET ITS CLOCK.** That is not exotic: it is a
    settings pane, or a BIOS, on a device they physically control. If elapsed time were
    allowed to go negative, winding the clock back would read as "no time has passed" and
    would postpone the lock indefinitely — turning the OS clock into a remote control for
    this security boundary.

    ⚠️ **Clamping makes a rolled-back clock fail CLOSED**: it buys the attacker nothing, and
    the next genuine forward tick past the deadline locks as normal.
  */
  it('🚨 a clock wound BACKWARDS cannot postpone the lock', () => {
    // Attacker sets the clock a year into the past.
    const aYear = 365 * 24 * 60 * MIN
    expect(shouldAutoLock(T0, T0 - aYear, 5)).toBe(false)
    // …and it does not "bank" that negative time: once the real deadline passes, it locks.
    expect(shouldAutoLock(T0, T0 + 5 * MIN, 5)).toBe(true)
  })

  it('🚨 a clock jumped FORWARD locks immediately rather than overflowing into a no-op', () => {
    expect(shouldAutoLock(T0, T0 + 100 * 365 * 24 * 60 * MIN, 5)).toBe(true)
  })

  /* ───────────────────── the "never" setting ───────────────────── */

  /*
    ⚠️ **0 MEANS NEVER, AND IT MUST MEAN IT EXACTLY.** The user can switch auto-lock off, and
    a control that silently locked anyway would be a different kind of bug — but "never" must
    also not be reachable by ACCIDENT. Hence the explicit finite check: a NaN timeout (a
    corrupted settings file, a hand-edited value) must not be treated as "never", because
    that is a stored value an attacker with the device can edit.
  */
  it('0 minutes means never — no elapsed time locks', () => {
    expect(isAutoLockEnabled(0)).toBe(false)
    expect(shouldAutoLock(T0, T0 + 365 * 24 * 60 * MIN, 0)).toBe(false)
  })

  it('🚨 a NaN or Infinity timeout is NOT treated as "never"', () => {
    // ⚠️ These reach us from a JSON settings file on disk, which the device attacker owns.
    // Neither is a legitimate user choice, and both must fail closed — disabled, so the
    // caller falls back to its validated default rather than honouring a corrupt "never".
    expect(isAutoLockEnabled(Number.NaN)).toBe(false)
    expect(isAutoLockEnabled(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isAutoLockEnabled(-5)).toBe(false)
  })

  /* ───────────────────── arming the timer ───────────────────── */

  it('reports the remaining time so a timer can be armed for the true deadline', () => {
    expect(msUntilAutoLock(T0, T0, 5)).toBe(5 * MIN)
    expect(msUntilAutoLock(T0, T0 + 2 * MIN, 5)).toBe(3 * MIN)
  })

  /*
    ⚠️ **AN OVERDUE LOCK ARMS AT ZERO, NEVER AT A NEGATIVE DELAY.** After a resume the
    deadline is usually already in the past; a negative `setTimeout` delay is coerced to 0 by
    the platform anyway, but returning a clamped 0 makes the intent explicit and keeps the
    caller from scheduling a lock it thinks is in the future.
  */
  it('returns 0 — not a negative delay — when the lock is already overdue', () => {
    expect(msUntilAutoLock(T0, T0 + 10 * MIN, 5)).toBe(0)
  })

  it('never expires when auto-lock is disabled', () => {
    expect(msUntilAutoLock(T0, T0 + 10 * MIN, 0)).toBe(Number.POSITIVE_INFINITY)
  })

  /* ───────────────────── activity genuinely defers ───────────────────── */

  /*
    The control must still be USABLE: real activity pushes the deadline out, or a user gets
    locked out mid-signature. This is the half that keeps the fix honest — a lock that fires
    regardless of activity would pass every test above and be unusable.
  */
  it('fresh activity defers the lock by the full timeout', () => {
    const lastActivity = T0 + 4 * MIN
    expect(shouldAutoLock(lastActivity, T0 + 5 * MIN, 5)).toBe(false)
    expect(shouldAutoLock(lastActivity, lastActivity + 5 * MIN, 5)).toBe(true)
  })
})
