import { useEffect, useState } from 'react'
import { useKeystore } from '../lib/keystore'
import { Button, PasswordInput, Label, Alert } from '../components/ui'
import { RestoreScreen } from './RestoreScreen'
import { ResetDeviceScreen } from './ResetDeviceScreen'
import { PassphraseStrength } from '../components/PassphraseStrength'
import { MIN_PASSPHRASE_LENGTH } from '../lib/passphrase-strength'
import { useI18n } from '../i18n'
import { LocaleSwitcher } from '../components/LocaleSwitcher'
import { BrandLockup } from '../components/Wordmark'
import { LiveClock } from '../components/LiveClock'

/*
  Passphrase gate. Two modes:
   - first run (status 'empty'): CHOOSE a passphrase (with confirm) → initializes an empty
     encrypted keystore.
   - returning (status 'locked'): enter passphrase → decrypt. Wrong passphrase fails loudly.
*/
export function UnlockScreen() {
  const { status, initialize, unlock } = useKeystore()
  const { t } = useI18n()
  const firstRun = status === 'empty'
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [resetting, setResetting] = useState(false)

  /*
    Clear the reset flag once a reset has actually landed (status → 'empty'). The guard on the
    early return below is what stops the stuck screen; this stops the STALE FLAG outliving it —
    otherwise `resetting` stays true for the rest of the session, and the next time the app
    reached a locked state it would drop straight back into the reset screen unasked.
  */
  useEffect(() => {
    if (firstRun && resetting) setResetting(false)
  }, [firstRun, resetting])

  if (restoring) return <RestoreScreen onBack={() => setRestoring(false)} />
  /*
    Reset offers restore as its way out, so it can hand straight over to the restore screen.

    ⚠️ `!firstRun` is LOAD-BEARING, not a tidy-up. A successful reset flips status → 'empty',
    which is the app's own signal that the wipe is done — but this early return runs BEFORE the
    render below reads `firstRun`, so without the guard the screen kept rendering itself over an
    app that had already reset. Its `busy` flag was frozen true (the component unmounts mid-await,
    so `runReset`'s continuation never lands), leaving "Erasing…" on screen forever while the keys
    were in fact already gone. The user is told the destructive operation is still running, on the
    one screen where that is most alarming, and their only move is to force-quit.

    Deriving the exit from status rather than from a callback is deliberate: status is what
    actually changed, and a reset that succeeds must always leave this screen, including on any
    future path that resets without going through `runReset`.
  */
  if (resetting && !firstRun) {
    return (
      <ResetDeviceScreen
        onBack={() => setResetting(false)}
        onRestore={() => {
          setResetting(false)
          setRestoring(true)
        }}
      />
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (firstRun && pass !== confirm) {
      setError(t('unlock.errorMismatch'))
      return
    }
    if (firstRun && pass.length < MIN_PASSPHRASE_LENGTH) {
      setError(t('unlock.errorTooShort'))
      return
    }
    setBusy(true)
    try {
      if (firstRun) await initialize(pass)
      else await unlock(pass)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col justify-center overflow-hidden bg-surface px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))] supports-[height:100dvh]:min-h-[100dvh] sm:px-5">
      {/* The brand backdrop (user, 2026-11-08: "our bgs and gradient and color missing"): the
          dot-grid texture and the orange glow, BEHIND the solid cards. The fintech pass took
          them out by mistake; solid means the cards, never the page. */}
      <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="bg-glow pointer-events-none absolute inset-x-0 top-0 h-96" aria-hidden="true" />
      {/* ONE clean, solid card centred on the page (the fintech pass): no glass. It holds everything in three ruled bands, like a statement panel:
          brand + language in the header bar, the title and passphrase form in the body, the
          recovery links (and clock) in a footer bar. */}
      {/* Padding scales phone → tablet (p-5 → p-8); p-8 flat ate ~64px of a 360px screen. */}
      <div className="card relative mx-auto w-full max-w-md overflow-hidden animate-fade-in-up sm:max-w-lg">
      <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3 sm:px-8">
        <BrandLockup />
        <LocaleSwitcher variant="ghost" />
      </div>

      <div className="p-5 sm:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-[-0.03em] text-ink">
          {firstRun ? t('unlock.createTitle') : t('unlock.unlockTitle')}
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          {firstRun ? t('unlock.createSubtitle') : t('unlock.unlockSubtitle')}
        </p>
      </div>

      {/* The passphrase form sits straight on the card: one surface, no nested box. */}
      <form onSubmit={submit} className="space-y-5">
        <div>
          <Label>{t('unlock.passphrase')}</Label>
          <PasswordInput
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete={firstRun ? 'new-password' : 'current-password'}
          />
          {/* Only while CHOOSING one — scoring a passphrase the user is merely re-typing to
              unlock would be pointless commentary on a decision already made. */}
          {firstRun && <PassphraseStrength value={pass} />}
        </div>
        {firstRun && (
          <div>
            <Label>{t('unlock.confirmPassphrase')}</Label>
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        <Button type="submit" disabled={busy} className="min-h-11 w-full">
          {busy ? t('unlock.working') : firstRun ? t('unlock.createKeystore') : t('unlock.unlockButton')}
        </Button>
      </form>
      </div>

      {/* First run: a subtle link to restore an existing keystore instead of creating one,
          with the live clock centered underneath. Covers the case where the app switched to
          portable storage and the user's real keystore still lives at the old (per-user)
          location. Footer bar: ruled off the form, a faint inner fill (not `bg-surface-2`,
          which is the card's own colour). */}
      {firstRun && (
        <div className="space-y-3 border-t border-line bg-ink/[0.02] px-5 py-4 text-center sm:px-8">
          <p className="text-xs text-ink-muted">
            {t('unlock.alreadyHaveKeystore')}{' '}
            <button
              type="button"
              onClick={() => setRestoring(true)}
              className="text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
            >
              {t('unlock.restoreIt')}
            </button>
          </p>
          <LiveClock className="text-center" />
        </div>
      )}

      {/* Returning (locked): the two recovery routes on the left, live clock on the right.
          RESTORE IS LISTED FIRST AND RESET SECOND, deliberately — a locked-out user's best
          outcome is opening a backup, and reset is what's left only when there isn't one.
          (Restore used to be offered on first run ONLY, which meant the one state where
          someone actually needs it — locked out, passphrase forgotten — had no route to it
          at all, and the reset link beside it did nothing.) */}
      {!firstRun && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-ink/[0.02] px-5 py-4 sm:px-8">
          <div className="space-y-1">
            <p className="text-xs text-ink-muted">
              {t('unlock.alreadyHaveKeystore')}{' '}
              <button
                type="button"
                onClick={() => setRestoring(true)}
                className="text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
              >
                {t('unlock.restoreIt')}
              </button>
            </p>
            <p className="text-xs text-ink-muted">
              {t('unlock.forgotPassphrase')}{' '}
              <button
                type="button"
                onClick={() => setResetting(true)}
                className="text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
              >
                {t('unlock.resetDevice')}
              </button>
            </p>
          </div>
          {/* Desktop only — on a phone the clock wrapped onto its own line under the
              recovery links, which is noise on the screen someone is trying to get
              past. The OS already shows the time there. */}
          <LiveClock className="hidden lg:block" />
        </div>
      )}
      </div>
    </div>
  )
}
