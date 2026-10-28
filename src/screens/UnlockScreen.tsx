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
    <div className="relative flex min-h-screen flex-col justify-center overflow-hidden px-4 py-8 supports-[height:100dvh]:min-h-[100dvh] sm:px-5 sm:py-10">
      {/* Full-bleed backdrop: dot-grid texture + brand glow (matches the unlocked shell). */}
      <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="bg-glow pointer-events-none absolute inset-x-0 top-0 h-96" aria-hidden="true" />

      {/* One glass panel holds EVERYTHING — header, form, footer links — so the dot-grid/glow
          backdrop shows through the whole block, not just the inner form. The inner form no
          longer needs its own Card/border; it just sits on the glass. */}
      {/* Padding scales phone → tablet → desktop (p-5 → p-10 → p-12); p-8 flat ate ~64px of a
          360px screen. */}
      <div className="relative mx-auto w-full max-w-lg animate-fade-in-up rounded-2xl border border-white/10 bg-surface-2/60 p-5 shadow-lift backdrop-blur-xl dark:border-white/5 sm:max-w-xl sm:p-10 lg:max-w-2xl lg:p-12">
      <div className="mb-8">
        <div className="flex items-center justify-between gap-2">
          <BrandLockup />
          <LocaleSwitcher variant="ghost" />
        </div>
        <h1 className="mt-6 text-2xl font-semibold text-ink">
          {firstRun ? t('unlock.createTitle') : t('unlock.unlockTitle')}
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          {firstRun ? t('unlock.createSubtitle') : t('unlock.unlockSubtitle')}
        </p>
      </div>

      {/* Passphrase block gets its own subtle separation from the header — a nested box
          inside the outer glass panel, not a second fully-opaque Card. */}
      <form onSubmit={submit} className="mt-8 space-y-6 rounded-xl border border-line/60 bg-surface/40 p-4 sm:p-7">
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
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? t('unlock.working') : firstRun ? t('unlock.createKeystore') : t('unlock.unlockButton')}
        </Button>
      </form>

      {/* First run: a subtle link to restore an existing keystore instead of creating one,
          with the live clock centered underneath. Covers the case where the app switched to
          portable storage and the user's real keystore still lives at the old (per-user)
          location. */}
      {firstRun && (
        <div className="mt-9 space-y-3 text-center">
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
        <div className="mt-7 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
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
