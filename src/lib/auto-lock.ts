/*
  WHEN SHOULD THE KEYSTORE BE LOCKED? — the auto-lock decision, as a pure function.

  🚨 **THIS EXISTS BECAUSE A TIMER IS NOT A CLOCK.** Auto-lock was implemented as a bare
  `setTimeout(lock, minutes * 60_000)` re-armed on user input. That is correct while the
  process is running and WRONG the moment the machine stops running it: **`setTimeout` does
  not advance while the OS is suspended.** Close the lid on an unlocked signer, and the
  countdown closes with it — the laptop can sit in a bag for a week and resume with the
  timer holding exactly as many milliseconds as it had when the lid shut.

  ⚠️ **THAT IS THE DEVICE-ATTACKER CASE, WHICH IS THE ONLY ATTACKER AN AIR-GAPPED SIGNER
  HAS.** There is no network to come from; whoever reaches this app is holding the machine.
  A stolen sleeping laptop is the overwhelmingly likely version of that, and it is precisely
  the one a monotonic-timer-only design does not defend against. LLM_CONTEXT §6 concedes the
  app "does NOT defend a compromised host while unlocked" and says auto-lock narrows the
  window — but a window that does not close while the lid is shut was not narrowed at all.

  ⚠️ **THE FIX IS TO DECIDE ON WALL-CLOCK ELAPSED TIME, NOT ON TIMER DELIVERY.** The timer
  stays (it is what makes the lock happen while the app is genuinely idle and running), but
  it is now an INVITATION TO RE-CHECK rather than the decision itself, and the same check
  runs again whenever the app regains visibility or focus. Whatever wakes us, the question is
  identical: how much real time has passed since the user last did something?

  ⚠️ Pure and side-effect-free on purpose: the whole point is that this is testable without a
  DOM, a real clock, or a suspended operating system.
*/

/** Auto-lock is disabled at 0 ("never"); any positive value is a real timeout. */
export function isAutoLockEnabled(minutes: number): boolean {
  return Number.isFinite(minutes) && minutes > 0
}

/**
 * Should the keystore be locked right now?
 *
 * @param lastActivityAt  epoch ms of the last real user activity
 * @param now             epoch ms, read at decision time (NOT when the timer was armed)
 * @param minutes         the configured timeout; 0 = never
 */
export function shouldAutoLock(lastActivityAt: number, now: number, minutes: number): boolean {
  if (!isAutoLockEnabled(minutes)) return false
  /*
    ⚠️ **A BACKWARDS CLOCK MUST NOT UNLOCK ANYTHING.** `now < lastActivityAt` means the
    system clock moved backwards (an NTP correction, a timezone-adjacent bug, or an attacker
    who simply set the clock back to keep a stolen machine unlocked). Elapsed time is
    therefore clamped at 0 rather than allowed to go negative: a negative elapsed would read
    as "no time has passed" forever. Clamping makes a rolled-back clock fail CLOSED — it can
    postpone nothing, and the next genuine forward tick locks.
  */
  const elapsedMs = Math.max(0, now - lastActivityAt)
  return elapsedMs >= minutes * 60_000
}

/**
 * How long until the lock is due, in ms — what to arm a timer with.
 *
 * ⚠️ Never negative and never zero-looping: an already-overdue lock returns 0 so the caller
 * acts immediately rather than scheduling a timer in the past.
 */
export function msUntilAutoLock(lastActivityAt: number, now: number, minutes: number): number {
  if (!isAutoLockEnabled(minutes)) return Number.POSITIVE_INFINITY
  const deadline = lastActivityAt + minutes * 60_000
  return Math.max(0, deadline - now)
}
