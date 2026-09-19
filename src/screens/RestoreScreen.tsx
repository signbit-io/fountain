import { useEffect, useState } from 'react'
import { useKeystore } from '../lib/keystore'
import { Button, Card, PasswordInput, Label, Alert, Mono } from '../components/ui'
import { restoreCandidate, readTextAt, type RestoreCandidate } from '../lib/storage'
import { BACKUP_TYPE } from '../lib/backup'
import type { EncryptedKeystore } from '../lib/crypto'
import { useI18n } from '../i18n'
import { LocaleSwitcher } from '../components/LocaleSwitcher'
import { BrandLockup } from '../components/Wordmark'

/*
  Restore screen — recover an existing keystore instead of starting fresh. Reached by a subtle
  link on the first-run passphrase screen. Two sources:
   - AUTO: a keystore found in the location NOT currently in use — the common case after the
     app switched to portable storage (empty data/) while the user's real keystore still sits
     in the OS config dir from before. Offered as one click.
   - MANUAL: pick a file with the native dialog — EITHER a full app backup (Settings → Backup:
     keys + saved vault descriptors + prefs, the cross-device path) OR a bare keystore.json.
     Which one it is, is detected from the file's CONTENT (a backup carries a `type` marker),
     never from a mode the user has to choose correctly under pressure.
  Either way we VERIFY the passphrase decrypts the chosen file BEFORE copying it into place —
  so a wrong passphrase (or a bad file) never overwrites the active store.
*/
export function RestoreScreen({ onBack }: { onBack: () => void }) {
  const { restoreFrom, restoreFromBackup } = useKeystore()
  const { t } = useI18n()
  // The chosen source: an auto-detected candidate path or a user-picked file, plus its parsed
  // envelope (read but NOT yet applied — application waits for a verified passphrase).
  // A chosen source is EITHER a raw keystore envelope or a full app-backup file. We sniff which
  // by content (the backup carries a `type` marker) rather than asking the user to know — both
  // are .json, and picking the wrong radio button on a recovery screen is a terrible experience.
  const [chosen, setChosen] = useState<
    { path: string; kind: 'keystore'; store: EncryptedKeystore } | { path: string; kind: 'backup'; raw: string } | null
  >(null)
  // The whole candidate, not just its path — `location` is what lets the offer be explained in
  // words rather than as a raw filesystem path the user has to interpret.
  const [candidate, setCandidate] = useState<RestoreCandidate | null>(null)
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Look for an auto-detectable previous keystore on mount.
  useEffect(() => {
    restoreCandidate()
      .then((c) => setCandidate(c))
      .catch(() => setCandidate(null)) // no Tauri shell / nothing found — manual only
  }, [])

  async function choosePath(path: string) {
    setError(null)
    setBusy(true)
    try {
      const raw = await readTextAt(path)
      // Sniff the file KIND by content, not by extension or a user-picked mode. A full app
      // backup carries `type: 'signbit-backup'`; a bare keystore envelope has no such marker.
      let isBackup = false
      try {
        isBackup = (JSON.parse(raw) as { type?: string })?.type === BACKUP_TYPE
      } catch {
        // Not JSON at all — fall through and let the keystore path report it.
      }
      if (isBackup) {
        setChosen({ path, kind: 'backup', raw })
      } else {
        setChosen({ path, kind: 'keystore', store: JSON.parse(raw) as EncryptedKeystore })
      }
    } catch (e) {
      setError((e as Error).message || t('restore.errorReadFile'))
    } finally {
      setBusy(false)
    }
  }

  async function pickFile() {
    setError(null)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      // Both artifacts are `signbit-*.json` (backup or keystore) — but the filter stays a broad
      // `.json` on purpose: a user restoring under pressure may have renamed the file, and a
      // narrow filter that hides their own backup is worse than one extra file in the list.
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'SignBit backup or keystore (signbit-*.json)', extensions: ['json'] }],
      })
      if (typeof picked === 'string') await choosePath(picked)
    } catch (e) {
      setError((e as Error).message || t('restore.errorOpenPicker'))
    }
  }

  async function apply(e: React.FormEvent) {
    e.preventDefault()
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    try {
      // Both paths verify the passphrase BEFORE writing anything, then unlock on success
      // (the app leaves the restore gate automatically once status → unlocked).
      if (chosen.kind === 'backup') {
        await restoreFromBackup(chosen.raw, pass) // keys + vault descriptors + prefs
      } else {
        await restoreFrom(chosen.store, pass) // keystore envelope only
      }
    } catch (e) {
      // A backup can fail for reasons the user can ACT on (a newer app is needed, the file
      // has no keys) — show those verbatim. A plain crypto failure stays generic so it can't
      // be used to probe whether a passphrase was close.
      const msg = (e as Error).message
      setError(chosen.kind === 'backup' && msg && !/wrong passphrase/i.test(msg) ? msg : t('restore.errorWrongPassphrase'))
      setPass('')
    } finally {
      setBusy(false)
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
          <h1 className="mt-4 text-2xl font-semibold text-ink">{t('restore.title')}</h1>
          <p className="mt-1 text-sm text-ink-muted">{t('restore.subtitle')}</p>
        </div>

        <Card className="animate-fade-in-up space-y-4">
          {/* Source pickers — hidden once a file is chosen (then it's just the passphrase). */}
          {!chosen && (
            <div className="space-y-3">
              {/* The auto-detected offer. It used to show a title, a generic subtitle and a raw
                  path — which reads as "we found your keys" and leaves the user to decode
                  %APPDATA%\… themselves.

                  ⚠️ What it actually found is a keystore in the location NOT currently in use.
                  On a portable install that means an older app-data copy predating the move to
                  portable, and the app CANNOT know whether it holds the same keys or opens with
                  the same passphrase — it is encrypted, which is often exactly why the user is
                  on this screen. So the offer now names the folder in words and states the
                  passphrase caveat, instead of implying a guaranteed recovery.

                  The offer is deliberately NOT suppressed after a reset: for someone who really
                  did move from an installed build to portable, this file is their genuine
                  lifeline, and hiding it to spare a different user's confusion is the worse
                  trade. Label it, don't hide it. */}
              {candidate && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => choosePath(candidate.path)}
                  className="w-full border border-brand-500/40 bg-brand-500/5 p-3 text-left transition-colors hover:bg-brand-500/10 disabled:opacity-50"
                >
                  <div className="text-sm font-medium text-ink">{t('restore.autoTitle')}</div>
                  <div className="mt-0.5 text-xs text-ink-muted">
                    {t(candidate.location === 'appData' ? 'restore.autoFromAppData' : 'restore.autoFromPortable')}
                  </div>
                  <Mono className="mt-1 block break-all text-[11px] text-ink-muted">{candidate.path}</Mono>
                  <div className="mt-1.5 text-[11px] leading-snug text-ink-muted">{t('restore.autoPassphraseNote')}</div>
                </button>
              )}
              <Button variant="secondary" className="w-full" disabled={busy} onClick={pickFile}>
                {t('restore.chooseFile')}
              </Button>
              {/* What to look for when there is nothing to auto-detect — the far more common
                  blank first run (new machine, reinstall) where the user's backup is sitting in
                  Downloads or on a USB stick that this app has no view of. `restore_candidate`
                  only ever checks two known folders. Every file the app writes carries the
                  `signbit-` prefix precisely so one machine-wide search finds them all, but that
                  is only useful if the user is told the prefix. */}
              <p className="text-xs leading-snug text-ink-muted">{t('restore.searchHint')}</p>
            </div>
          )}

          {chosen && (
            <form onSubmit={apply} className="space-y-4">
              <div className="border border-line bg-surface p-3">
                <div className="text-xs text-ink-muted">{t('restore.restoringFrom')}</div>
                <Mono className="mt-0.5 block break-all text-[11px] text-ink">{chosen.path}</Mono>
              </div>
              <div>
                <Label>{t('restore.passphrase')}</Label>
                <PasswordInput
                  autoFocus
                  value={pass}
                  onChange={(ev) => setPass(ev.target.value)}
                  autoComplete="current-password"
                />
                <p className="mt-1 text-xs text-ink-muted">{t('restore.passphraseHint')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || !pass}>
                  {busy ? t('restore.restoring') : t('restore.restoreAndUnlock')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setChosen(null)
                    setPass('')
                    setError(null)
                  }}
                >
                  {t('restore.pickDifferentFile')}
                </Button>
              </div>
            </form>
          )}

          {error && <Alert kind="error">{error}</Alert>}
        </Card>

        <p className="mt-5 text-center text-xs text-ink-muted">
          <button
            type="button"
            onClick={onBack}
            className="text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
          >
            {t('restore.backToCreate')}
          </button>
        </p>
      </div>
    </div>
  )
}
