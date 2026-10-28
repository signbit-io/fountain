import { useMemo, useState } from 'react'
import { Button, Card, Label, Alert, Input, PasswordInput, Modal } from './ui'
import { useKeystore } from '../lib/keystore'
import {
  BACKUP_FILE_EXT,
  BACKUP_FILE_PREFIX,
  backupFilename,
  backupNamePart,
  collectBackupPayload,
  createBackup,
  defaultBackupNamePart,
} from '../lib/backup'
import { saveTextFile, MAX_BACKUP_IMPORT_BYTES } from '../lib/download'
import { BACKUP_SIZE_WARN_BYTES, MAX_KEYS, MAX_VAULTS, shouldShowCount } from '../lib/limits'
import { readVaultBackups } from '../lib/vaults'
import { useI18n } from '../i18n'

/*
  Settings → Backup. Exports the WHOLE app state (seeds + saved vault descriptors + prefs) as
  one encrypted, portable file the user can put on a USB stick or in cloud storage and restore
  on any other device — including a different OS.

  Passphrase-gated on purpose, exactly like Reveal seed: exporting produces a file that IS the
  keys (encrypted), so an unattended unlocked device must not be one click away from writing
  every seed to disk. Re-typing the passphrase is also what we encrypt with, so it can't drift
  out of sync with the keystore's own passphrase.

  The save itself goes through lib/download.ts's saveTextFile, which write-verifies (read the
  file back, retry once, throw rather than report success on an empty write) — the Android SAF
  0-byte trap. That matters more here than anywhere else in the app: a backup the user BELIEVES
  they have but which is actually empty is the worst possible failure, because they find out
  only when they need it.
*/
export function BackupCard({ onOpenTransfer }: { onOpenTransfer: (mode: 'import' | 'compare') => void }) {
  const { t } = useI18n()
  const { entries, verifyPassphrase } = useKeystore()
  const [open, setOpen] = useState(false)
  const [pass, setPass] = useState('')
  // Re-typed confirmation of the SAME passphrase. Not a second secret and not a security
  // gate — verifyPassphrase below already rejects a wrong one against the on-disk envelope.
  // What this catches is the case that gate cannot: the user typing what they BELIEVE their
  // passphrase is, into a masked field, on the one surface whose output they may not open for
  // years. A mismatch between the two boxes is a typo caught now rather than a backup they
  // find they cannot read later. Same shape as every "choose a passphrase" field in the app.
  const [passConfirm, setPassConfirm] = useState('')
  const [filename, setFilename] = useState(defaultBackupNamePart())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // Set when a backup is large but still restorable — shown alongside the success message so
  // the user learns it now rather than when a future export finally crosses the hard limit.
  const [sizeNote, setSizeNote] = useState<string | null>(null)
  // Read once per mount, not per render (this hits localStorage). Settings remounts on every
  // tab switch — App's <main key={tab}> — so the count is refreshed whenever the user could
  // plausibly have changed it on the Vaults tab.
  const vaultCount = useMemo(() => readVaultBackups().length, [])

  function reset() {
    setPass('')
    setPassConfirm('')
    setFilename(defaultBackupNamePart())
    setError(null)
    setBusy(false)
  }

  // Both boxes must agree before anything is derived or written. Checked here rather than only
  // disabling the button, so the Enter-key path can't skip it.
  const passesMatch = pass.length > 0 && pass === passConfirm

  async function runExport() {
    setError(null)
    if (!passesMatch) {
      setError(t('settings.backup.passphraseMismatch'))
      return
    }
    setBusy(true)
    try {
      // Verify against the ON-DISK envelope (same path as unlock) rather than trusting an
      // in-memory flag — a wrong passphrase must fail here, not silently produce a backup
      // encrypted under something the user doesn't know.
      const ok = await verifyPassphrase(pass)
      if (!ok) {
        setError(t('settings.backup.wrongPassphrase'))
        setBusy(false)
        return
      }
      const file = createBackup(collectBackupPayload(entries), pass)
      const name = backupFilename(filename)
      const text = JSON.stringify(file, null, 2)

      /*
        Size check HERE — before the write, while the user still holds every key.

        The failure this prevents: a backup too large for the import path to read back is
        useless, and without this check the user finds that out at RESTORE time, on a device
        they may have already wiped. Checking after the fact would be checking too late.

        Deliberately a hard refusal, not a warning: writing a file we already know cannot be
        read back would be handing someone a backup that lies. `blob` measures real BYTES
        (a JSON string of multi-byte characters is longer in bytes than in code units, and the
        byte length is what the reader's cap compares against).
      */
      const bytes = new Blob([text]).size
      if (bytes > MAX_BACKUP_IMPORT_BYTES) {
        setError(t('settings.backup.tooLargeToRestore', { mb: String(Math.ceil(bytes / 1024 / 1024)) }))
        setBusy(false)
        return
      }
      if (bytes > BACKUP_SIZE_WARN_BYTES) {
        // Large but still restorable — proceed, and say so afterwards rather than blocking.
        setSizeNote(t('settings.backup.largeFileNote', { mb: String(Math.ceil(bytes / 1024 / 1024)) }))
      }

      const res = await saveTextFile(
        name,
        text,
        [{ name: 'SignBit backup', extensions: [BACKUP_FILE_EXT.slice(1)] }],
      )
      if (res.status === 'cancelled') {
        setBusy(false)
        return
      }
      setOpen(false)
      reset()
      setDone(t('settings.backup.saved', { count: String(entries.length) }))
    } catch (e) {
      // Includes the write-verify failure (empty file) — surfaced verbatim because it tells
      // the user exactly what to do instead.
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3">
      <div>
        <Label>{t('settings.backup.label')}</Label>
        <p className="text-xs text-ink-muted">{t('settings.backup.hint')}</p>
      </div>

      {done && <Alert kind="ok">{done}</Alert>}
      {sizeNote && <Alert kind="warn">{sizeNote}</Alert>}

      {/* Live capacity counts — shown ONLY past ~50% of a cap. A normal user (a handful of keys)
          never sees a limit at all; someone approaching one sees it long before it bites, which
          is the whole reason the user-facing limit is a COUNT rather than a byte budget. */}
      {(shouldShowCount(entries.length, MAX_KEYS) || shouldShowCount(vaultCount, MAX_VAULTS)) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
          {shouldShowCount(entries.length, MAX_KEYS) && (
            <span>
              {t('settings.backup.keyCount')}{' '}
              <span className="font-mono text-ink">{entries.length} / {MAX_KEYS}</span>
            </span>
          )}
          {shouldShowCount(vaultCount, MAX_VAULTS) && (
            <span>
              {t('settings.backup.vaultCount')}{' '}
              <span className="font-mono text-ink">{vaultCount} / {MAX_VAULTS}</span>
            </span>
          )}
        </div>
      )}

      {/* The "anyone with this file + your passphrase has your keys" warning lives in the
          EXPORT MODAL, not here — it's the moment before committing, which is when it's
          actually load-bearing. Keeping it permanently on the card made this the tallest
          card in Settings (skewing the two-column layout) to repeat a caution the user
          hasn't acted on yet. */}
      {/* Export / Import / Compare. Stacked full-width on a phone (three side-by-side buttons
          crush to unreadable at 320px), inline from sm up. Import and Compare hand off to the
          full-screen BackupTransferScreen — the diff they show is too big for a modal, and
          Import's confirmation IS that diff. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          variant="secondary"
          className="w-full sm:w-auto"
          disabled={entries.length === 0}
          onClick={() => {
            reset()
            setDone(null)
            setSizeNote(null)
            setOpen(true)
          }}
        >
          {t('settings.backup.action')}
        </Button>
        {/* Import is NOT gated on having keys — importing into an empty signer is a normal
            recovery path (and the only one reachable once the app is already unlocked). */}
        <Button variant="secondary" className="w-full sm:w-auto" onClick={() => onOpenTransfer('import')}>
          {t('settings.backup.importAction')}
        </Button>
        <Button variant="secondary" className="w-full sm:w-auto" onClick={() => onOpenTransfer('compare')}>
          {t('settings.backup.compareAction')}
        </Button>
      </div>
      {entries.length === 0 && <p className="text-xs text-ink-muted">{t('settings.backup.noKeys')}</p>}
      <p className="text-xs text-ink-muted">{t('settings.backup.transferHint')}</p>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          reset()
        }}
        title={t('settings.backup.modalTitle')}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{t('settings.backup.modalBody')}</p>

          <Alert kind="warn">{t('settings.backup.warning')}</Alert>

          <div className="space-y-1.5">
            <Label>{t('settings.backup.filenameLabel')}</Label>
            {/* Only the middle is editable: the prefix and `.sbk` are fixed (lib/backup.ts). */}
            <div className="flex items-stretch font-mono text-sm">
              <span className="flex shrink-0 items-center whitespace-nowrap border border-r-0 border-line bg-surface-2 px-2 text-xs text-ink-muted">
                {BACKUP_FILE_PREFIX}
              </span>
              <Input
                aria-label={t('settings.backup.filenameLabel')}
                className="min-w-0 font-mono"
                value={filename}
                placeholder={defaultBackupNamePart()}
                onChange={(e) => {
                  // Spaces become hyphens as they are typed, so the box always shows the real
                  // name. Same length, so the caret is put back where it was, not at the end.
                  const el = e.target
                  const at = el.selectionStart
                  setFilename(el.value.replace(/\s/g, '-'))
                  requestAnimationFrame(() => el.setSelectionRange(at, at))
                }}
                onBlur={() => setFilename(backupNamePart(filename))}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <span className="flex shrink-0 items-center whitespace-nowrap border border-l-0 border-line bg-surface-2 px-2 text-xs text-ink-muted">
                {BACKUP_FILE_EXT}
              </span>
            </div>
            <p className="text-xs text-ink-muted">{t('settings.backup.filenameHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t('settings.backup.passphraseLabel')}</Label>
            <PasswordInput
              aria-label={t('settings.backup.passphraseLabel')}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && passesMatch && !busy) void runExport()
              }}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="text-xs text-ink-muted">{t('settings.backup.passphraseHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t('settings.backup.passphraseConfirmLabel')}</Label>
            <PasswordInput
              aria-label={t('settings.backup.passphraseConfirmLabel')}
              value={passConfirm}
              onChange={(e) => setPassConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && passesMatch && !busy) void runExport()
              }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {/* Only flag a mismatch once the user has actually typed something in the second
                box — warning while they are still mid-word is noise, not help. */}
            {passConfirm.length > 0 && pass !== passConfirm && (
              <p className="text-xs text-red-600 dark:text-red-400">{t('settings.backup.passphraseMismatch')}</p>
            )}
          </div>

          {error && <Alert kind="error">{error}</Alert>}

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button className="w-full sm:w-auto" disabled={!passesMatch || busy} onClick={() => void runExport()}>
              {busy ? t('settings.backup.saving') : t('settings.backup.confirm')}
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
    </Card>
  )
}
