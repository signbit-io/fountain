import { useEffect, useState } from 'react'
import { useKeystore } from '../lib/keystore'
import { Button, Card, Input, Alert, Modal, Mono } from '../components/ui'
import { storageInfo, type StorageInfo } from '../lib/storage'
import { useI18n } from '../i18n'
import { LocaleSwitcher } from '../components/LocaleSwitcher'
import { BrandLockup } from '../components/Wordmark'

/*
  RESET THIS DEVICE — the escape hatch for someone who has lost their passphrase.

  Reached only from the LOCK screen, which shapes every decision here: the person on the other
  side cannot unlock, so we cannot ask them to prove anything, and we cannot show them what
  they're about to destroy. The keystore is encrypted; its labels are unreadable without the
  passphrase they don't have.

  ── Why that missing detail matters ──────────────────────────────────────────────────
  The destructive-import flow's FinalConfirmModal NAMES each key it is about to delete, because
  a recognised label is what makes someone stop. This flow structurally cannot do that. So the
  copy carries the weight instead, and says plainly that the app can't tell them what is in
  there — which is itself the most honest warning available.

  ── The two gates (deliberately different words) ─────────────────────────────────────
   1. type-to-confirm RESET  — the same shape as the import path's OVERWRITE, a DIFFERENT word.
      They mean different things (OVERWRITE: replaced, recoverable from the file in your hand.
      RESET: gone, nothing to recover from), and a distinct word stops muscle memory from one
      clearing the other unread.
   2. a final consequence modal — states the outcome in plain terms, one action away from done.

  ── Restore comes first ──────────────────────────────────────────────────────────────
  The honest framing is that reset is what you pick AFTER confirming you have no backup. So the
  restore route is offered above the destructive control, not buried under it.
*/

/** The word the user must type. Uppercase, short, and NOT the import flow's OVERWRITE. */
const CONFIRM_WORD = 'RESET'

/** Cooling-off period on the final confirm button. See the timer note in the component. */
const RESET_COOLDOWN_SECONDS = 30

export function ResetDeviceScreen({ onBack, onRestore }: { onBack: () => void; onRestore: () => void }) {
  const { resetDevice } = useKeystore()
  const { t } = useI18n()
  const [typed, setTyped] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // WHERE this reset will delete from. Turns an abstract "erase this device" into a concrete
  // folder the user recognises — and it quietly explains the offer they may see afterwards: if
  // reset named `…\data`, a later restore offer from `%APPDATA%\…` reads as an obviously
  // DIFFERENT file rather than the same keystore coming back from the dead.
  const [storage, setStorage] = useState<StorageInfo | null>(null)

  useEffect(() => {
    storageInfo()
      .then(setStorage)
      .catch(() => setStorage(null)) // no Tauri shell (browser dev) — just omit the path
  }, [])

  // Case-sensitive on purpose: the point of a typed confirmation is a deliberate act, and
  // accepting "reset" would make it one keystroke from a stray Enter. Trimmed because a
  // trailing space from a mobile keyboard's autocomplete is not a different intent.
  const confirmOk = typed.trim() === CONFIRM_WORD

  /*
    A COOLING-OFF TIMER on the final button — the last gate is time, not another click.

    Every other friction in this flow can be cleared while committed to a decision already made:
    a typed word is muscle memory, a modal is one more dismissal. None of them creates the thing
    that actually prevents regret, which is a pause long enough to reconsider. This is the only
    irreversible action in the app, so it gets the one gate the others can't provide.

    ⚠️ It counts down only while the modal is OPEN, and RESETS when it closes — so backing out
    and returning gives the full period again rather than banking progress toward the destructive
    click. Cancel stays enabled the entire time: the timer must never trap someone in the modal,
    only slow the way forward.
  */
  const [secondsLeft, setSecondsLeft] = useState(RESET_COOLDOWN_SECONDS)

  useEffect(() => {
    if (!confirmOpen) {
      setSecondsLeft(RESET_COOLDOWN_SECONDS) // re-arm for next time
      return
    }
    if (secondsLeft <= 0) return
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(id)
  }, [confirmOpen, secondsLeft])

  const cooldownDone = secondsLeft <= 0

  async function runReset() {
    setBusy(true)
    setError(null)
    try {
      await resetDevice()
      // On success the keystore status flips to 'empty' and App swaps to the first-run screen —
      // no navigation needed here. Deliberately no success toast: the fresh "create a
      // passphrase" screen IS the confirmation, and a cheerful message about destroyed keys
      // would be the wrong note.
    } catch (e) {
      // The Rust side verifies the file is really gone before returning, so an error here
      // genuinely means the keys are still on disk and nothing was cleared. Surfaced verbatim
      // because it tells the user what to do (close the other copy of the app).
      setError((e as Error).message)
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col justify-center overflow-hidden px-4 py-8 supports-[height:100dvh]:min-h-[100dvh] sm:px-5 sm:py-10">
      <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="bg-glow pointer-events-none absolute inset-x-0 top-0 h-96" aria-hidden="true" />

      <div className="relative mx-auto w-full max-w-md sm:max-w-lg lg:max-w-xl">
        <div className="mb-6 animate-fade-in-up">
          <div className="flex items-center justify-between gap-2">
            <BrandLockup />
            <LocaleSwitcher variant="ghost" />
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-ink">{t('reset.title')}</h1>
          <p className="mt-1 text-sm text-ink-muted">{t('reset.subtitle')}</p>
        </div>

        <Card className="animate-fade-in-up space-y-5">
          {/* What this does, stated before any control. Includes the fact the app cannot list
              what it's deleting — the piece of honesty this flow can't buy any other way. */}
          <Alert kind="warn">{t('reset.warning')}</Alert>

          {/* The concrete target. Only the FOLDER is shown (storage_info returns no filename and
              no key material) — enough to recognise which install is being erased, which is the
              whole point on a machine that may hold both a portable and an installed copy. */}
          {storage && (
            /* Three DIFFERENT kinds of thing stacked, so they get different spacing rather than
               one flat rhythm: a label, a path the user reads character by character, and a
               separate caveat about what is NOT touched. The path gets its own breathing room
               (it is the thing being verified) and the caveat is divided off, because it is a
               new thought rather than a continuation of the path. */
            <div className="border border-line bg-surface p-3 sm:p-4">
              <p className="text-xs text-ink-muted">
                {t(storage.portable ? 'reset.locationPortable' : 'reset.locationAppData')}
              </p>
              {/* Mono + generous margins: this is a value verified character by character, and a
                  path cramped against its own label is exactly where a misread happens. */}
              <Mono className="mt-2 block break-all text-xs leading-relaxed text-ink">{storage.dir}</Mono>
              {/* Reset clears the ACTIVE location only. On a portable install an older app-data
                  copy can survive — deliberately, since it's a real recovery route for someone
                  who moved from an installed build. Saying so here stops the later restore offer
                  from looking like the reset failed. */}
              {storage.portable && (
                <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-muted">
                  {t('reset.locationOtherNote')}
                </p>
              )}
            </div>
          )}

          {/* The way OUT, above the way through. Someone who has a backup file should never have
              to scroll past a destructive button to find that out. */}
          <div className="space-y-2 border border-line bg-surface p-3">
            <p className="text-sm font-medium text-ink">{t('reset.tryRestoreTitle')}</p>
            <p className="text-xs text-ink-muted">{t('reset.tryRestoreBody')}</p>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={onRestore}>
              {t('reset.tryRestoreAction')}
            </Button>
          </div>

          {/* GATE 1 — type the word. */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-ink" htmlFor="reset-confirm">
              {t('reset.typeToConfirm', { word: CONFIRM_WORD })}
            </label>
            <Input
              id="reset-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              // A confirmation word must not be autocompleted, autocapitalised, or spell-checked
              // into something else on a phone keyboard.
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder={CONFIRM_WORD}
            />
          </div>

          {error && <Alert kind="error">{error}</Alert>}

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button
              variant="danger"
              className="w-full sm:w-auto"
              disabled={!confirmOk || busy}
              onClick={() => {
                setError(null)
                setConfirmOpen(true)
              }}
            >
              {t('reset.action')}
            </Button>
            <Button variant="secondary" className="w-full sm:w-auto" disabled={busy} onClick={onBack}>
              {t('common.cancel')}
            </Button>
          </div>
        </Card>

        {/* GATE 2 — the final consequence modal. Deliberately NOT a second type-to-confirm:
            stacking two identical gates trains people to clear both unread (the same reasoning
            as the backup-import flow). */}
        <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t('reset.finalTitle')}>
          <div className="space-y-4">
            <Alert kind="error">{t('reset.finalWarning')}</Alert>
            <p className="text-sm text-ink-muted">{t('reset.finalBody')}</p>
            {error && <Alert kind="error">{error}</Alert>}
            {/* Says WHY the button is dead, and that it is temporary. A disabled control with no
                explanation reads as a broken app — especially here, where the user has already
                cleared two gates and expects this one to work. */}
            {!cooldownDone && !busy && (
              <p className="text-xs leading-relaxed text-ink-muted" aria-live="polite">
                {t('reset.cooldownNote')}
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                variant="danger"
                className="w-full sm:w-auto"
                disabled={busy || !cooldownDone}
                onClick={() => void runReset()}
              >
                {/* The countdown lives ON the button: the number is right where the user is
                    looking and pointing, so the wait reads as deliberate rather than as a
                    hang. Falls back to the plain label the moment it expires. */}
                {busy
                  ? t('reset.resetting')
                  : cooldownDone
                    ? t('reset.finalConfirm')
                    : t('reset.finalConfirmWaiting', { seconds: String(secondsLeft) })}
              </Button>
              <Button
                variant="secondary"
                className="w-full sm:w-auto"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  )
}
