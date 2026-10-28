import { useState } from 'react'
import { Button, Card, Label, Alert, PasswordInput, Modal } from './ui'
import { useKeystore } from '../lib/keystore'
import { PassphraseStrength } from './PassphraseStrength'
import { MIN_PASSPHRASE_LENGTH } from '../lib/passphrase-strength'
import { BACKUP_FILE_EXT, collectBackupPayload, createBackup, defaultBackupFilename } from '../lib/backup'
import { saveTextFile } from '../lib/download'
import { useI18n } from '../i18n'

/*
  Settings → Change passphrase. Re-encrypts the keystore under a new passphrase; the keys
  themselves are untouched.

  ── Why this exists at all ───────────────────────────────────────────────────────────
  The passphrase is the ONLY thing protecting the keystore at rest, and the scrypt cost is the
  whole defense (an attacker with the file guesses offline, where no lockout can reach them).
  Without this, someone who suspects their passphrase is compromised — shoulder-surfed, typed
  into the wrong window, or simply weak and later regretted — has exactly one remedy: reveal
  every seed, wipe the device, and re-import each key by hand. That path walks every mnemonic
  through the screen and the clipboard, which is the single most dangerous thing this app can
  ask anyone to do. A re-encrypt never surfaces key material at all.

  ── The consequence that must be stated, not discovered ──────────────────────────────
  Exported backup FILES keep the passphrase they were written with. Nothing can reach into a
  file the user has already put on a USB stick or in cloud storage. So after a successful
  change they hold a keystore opening with B and backups opening with A — and if they forget
  that, their recovery path is a file whose passphrase they no longer remember choosing.

  We therefore OFFER a fresh export immediately (the native save dialog, dismissible), rather
  than leaving a note in a card that goes unread. The offer is a real export through the same
  write-verified `saveTextFile` path the Backup card uses — not a reminder to go and do it.
*/
export function ChangePassphraseCard() {
  const { entries, changePass } = useKeystore()
  const { t } = useI18n()

  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // The post-change export offer. Holds the NEW passphrase so the fresh backup is encrypted
  // under it — kept only for the moment between success and the user's answer.
  const [offerExport, setOfferExport] = useState<string | null>(null)
  const [exportNote, setExportNote] = useState<string | null>(null)

  function reset() {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
    setBusy(false)
  }

  const canSubmit =
    current.length > 0 && next.length >= MIN_PASSPHRASE_LENGTH && next === confirm && next !== current && !busy

  async function runChange() {
    setError(null)
    setBusy(true)
    try {
      // The sequence (verify old → re-encrypt → prove the new envelope opens → commit) lives in
      // lib/restore.ts; a wrong current passphrase throws with nothing written.
      await changePass(current, next)
      const newPass = next
      setOpen(false)
      reset()
      setDone(true)
      // Offer the re-export while the change is fresh and the reason is obvious.
      setOfferExport(newPass)
    } catch (e) {
      // Distinguish the ONE error the user can act on (wrong current passphrase) from a genuine
      // storage failure, which must not be mistaken for a typo.
      const msg = (e as Error).message
      setError(/decrypt|passphrase|auth/i.test(msg) ? t('settings.changePass.wrongCurrent') : msg)
      setBusy(false)
    }
  }

  async function runExport(pass: string) {
    setExportNote(null)
    try {
      const file = createBackup(collectBackupPayload(entries), pass)
      const res = await saveTextFile(defaultBackupFilename(), JSON.stringify(file, null, 2), [
        { name: 'SignBit backup', extensions: [BACKUP_FILE_EXT.slice(1)] },
      ])
      // Cancelling is a legitimate choice, not an error — but leave a note, because the stale
      // older backup is now the thing standing between them and their keys.
      setExportNote(res.status === 'cancelled' ? t('settings.changePass.exportSkipped') : t('settings.changePass.exportSaved'))
    } catch (e) {
      setExportNote((e as Error).message)
    } finally {
      setOfferExport(null)
    }
  }

  return (
    <Card className="space-y-3">
      <div>
        <Label>{t('settings.changePass.label')}</Label>
        <p className="text-xs text-ink-muted">{t('settings.changePass.hint')}</p>
      </div>

      {done && <Alert kind="ok">{t('settings.changePass.changed')}</Alert>}
      {exportNote && <Alert kind="warn">{exportNote}</Alert>}

      <Button
        variant="secondary"
        className="w-full sm:w-auto"
        onClick={() => {
          reset()
          setDone(false)
          setExportNote(null)
          setOpen(true)
        }}
      >
        {t('settings.changePass.action')}
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          reset()
        }}
        title={t('settings.changePass.modalTitle')}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{t('settings.changePass.modalBody')}</p>

          {/* Stated BEFORE the change, not after — a consequence discovered afterwards is one
              the user never got to weigh. */}
          <Alert kind="warn">{t('settings.changePass.backupWarning')}</Alert>

          <div className="space-y-1.5">
            <Label>{t('settings.changePass.currentLabel')}</Label>
            <PasswordInput
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('settings.changePass.newLabel')}</Label>
            <PasswordInput
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <PassphraseStrength value={next} />
          </div>

          <div className="space-y-1.5">
            <Label>{t('settings.changePass.confirmLabel')}</Label>
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void runChange()
              }}
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {/* Inline mismatch feedback while typing — cheaper than failing on submit. */}
            {confirm.length > 0 && next !== confirm && (
              <p className="text-xs text-red-600 dark:text-red-400">{t('settings.changePass.mismatch')}</p>
            )}
            {next.length > 0 && next === current && (
              <p className="text-xs text-red-600 dark:text-red-400">{t('settings.changePass.sameAsCurrent')}</p>
            )}
          </div>

          {error && <Alert kind="error">{error}</Alert>}

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button className="w-full sm:w-auto" disabled={!canSubmit} onClick={() => void runChange()}>
              {busy ? t('settings.changePass.changing') : t('settings.changePass.confirmAction')}
            </Button>
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                reset()
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* The post-change export offer. Dismissible — but it opens the real save dialog rather
          than telling the user to go and find the Backup card themselves. */}
      <Modal
        open={offerExport !== null}
        onClose={() => setOfferExport(null)}
        title={t('settings.changePass.exportTitle')}
      >
        <div className="space-y-4">
          <Alert kind="ok">{t('settings.changePass.changed')}</Alert>
          <p className="text-sm text-ink-muted">{t('settings.changePass.exportBody')}</p>
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button className="w-full sm:w-auto" onClick={() => offerExport && void runExport(offerExport)}>
              {t('settings.changePass.exportAction')}
            </Button>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={() => setOfferExport(null)}>
              {t('settings.changePass.exportLater')}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  )
}
