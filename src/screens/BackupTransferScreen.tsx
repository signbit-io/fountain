import { useMemo, useState } from 'react'
import { Button, Card, Label, Alert, Mono, PasswordInput, Input, Modal } from '../components/ui'
import { useKeystore } from '../lib/keystore'
import { readBackup, type BackupPayload } from '../lib/backup'
import { readVaultBackups } from '../lib/vaults'
import { readSettings } from '../lib/activity'
import { readTextFile, MAX_BACKUP_IMPORT_BYTES } from '../lib/download'
import { MAX_KEYS, MAX_VAULTS } from '../lib/limits'
import {
  diffBackup,
  OVERWRITE_CONFIRM_WORD,
  type BackupDiff,
  type DiffStatus,
  type KeyDiff,
  type VaultDiff,
} from '../lib/backup-diff'
import type { NetworkName } from '../lib/key'
import { useI18n } from '../i18n'

/*
  Settings → Import backup / Compare backup. ONE screen, two modes:

   - `compare` — read-only. Decrypt a backup file, show how it differs from this device, stop.
     Nothing is written, ever. For "which of these three files is the current one?" and for
     checking a backup is still readable before trusting it.
   - `import`  — the SAME diff becomes the confirmation surface, then overwrites this device.

  ── Why a full screen and not a modal ────────────────────────────────────────────────
  The diff is the safety mechanism, and a diff that has to scroll inside a phone-sized sheet
  parked above a rising Android keyboard is a diff people dismiss unread. A screen gets the
  side-by-side desktop layout AND lets the passphrase step finish before the diff is ever shown
  (so the keyboard is gone by the time there's anything to read).

  ── Why import is a full OVERWRITE, not a merge ──────────────────────────────────────
  lib/restore.ts's restoreFromBackupFile re-encrypts the backup's keys as the ENTIRE keystore.
  This screen deliberately does not soften that: it shows exactly which keys disappear and
  makes the user type OVERWRITE when any of them would. A merge would produce a keystore that
  matches neither the device nor the file, on the one code path that holds seeds.

  ⚠️ The passphrase here is the BACKUP FILE's, which may differ from this device's unlock
  passphrase (it's whatever was set when that file was written). Import therefore ALSO changes
  this device's unlock passphrase to the file's — restoreFromBackupFile re-encrypts under the
  passphrase the user just proved. That is called out in the confirm step, not buried.
*/

export type TransferMode = 'import' | 'compare'

/** Where the user is in the flow. Deliberately linear: pick → unlock → review. */
type Step = 'pick' | 'review'

export function BackupTransferScreen({
  mode,
  network,
  onBack,
}: {
  mode: TransferMode
  network: NetworkName
  onBack: () => void
}) {
  const { t } = useI18n()
  const { entries, restoreFromBackup } = useKeystore()

  const [raw, setRaw] = useState<string | null>(null)
  const [filename, setFilename] = useState<string | null>(null)
  const [pass, setPass] = useState('')
  const [payload, setPayload] = useState<BackupPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmWord, setConfirmWord] = useState('')
  const [applied, setApplied] = useState(false)
  // The apply step needs the file's passphrase again (`pass` is cleared once the file opens, so
  // a passphrase isn't sitting in state while the user reads the diff).
  const [applyPass, setApplyPass] = useState('')
  // The FINAL stop before any write. Deliberately separate from the apply card's inline
  // warnings: those are read while filling in fields (i.e. skimmed), whereas a modal has to be
  // dismissed deliberately and states the consequence in its plainest form — seeds not written
  // down are gone, and with them the funds they control.
  const [confirmOpen, setConfirmOpen] = useState(false)

  const step: Step = payload ? 'review' : 'pick'

  // The device side is read ONCE per decrypted payload, not on every render — otherwise every
  // keystroke in the confirm box would re-derive a fingerprint for every key (BIP-32 per key).
  const diff = useMemo<BackupDiff | null>(() => {
    if (!payload) return null
    return diffBackup(
      { keys: entries, vaults: readVaultBackups(), settings: readSettings(), locale: readLocale() },
      payload,
      network,
    )
  }, [payload, entries, network])

  async function pickFile() {
    setError(null)
    // Same TEXT-ONLY, read-then-parse path as every other import in the app (§7): the file is
    // never executed or handed to the shell — a mis-picked binary just fails to parse.
    const res = await readTextFile({
      accept: '.json,application/json',
      // A full backup is in a different size class from a PSBT (it carries every seed AND every
      // saved vault descriptor), so it overrides the shared 1 MB default. The old default
      // rejected large-but-valid backups before decryption was even attempted.
      maxBytes: MAX_BACKUP_IMPORT_BYTES,
      tooLargeMessage: t('backupTransfer.errorTooLarge', { mb: String(MAX_BACKUP_IMPORT_BYTES / 1024 / 1024) }),
      readErrorMessage: t('backupTransfer.errorRead'),
    })
    if (res.status === 'cancelled') return
    if (res.status === 'rejected') {
      setError(res.reason)
      return
    }
    setRaw(res.text)
    setFilename(res.name)
    setPayload(null)
    setPass('')
  }

  function unlockFile() {
    if (!raw) return
    setBusy(true)
    setError(null)
    try {
      // readBackup validates the envelope AND decrypts. In compare mode this is the only thing
      // that ever happens — no writer is reachable from this branch at all.
      setPayload(readBackup(raw, pass))
      setPass('') // the file is open; don't keep its passphrase in state longer than needed
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function applyImport() {
    if (!raw || !payload || busy) return
    setBusy(true)
    setError(null)
    try {
      // restoreFromBackup re-reads and re-decrypts `raw` with this passphrase, so the apply
      // step verifies again rather than trusting the payload we decrypted a moment ago.
      await restoreFromBackup(raw, applyPass)
      setConfirmOpen(false)
      setApplied(true)
    } catch (e) {
      // Keep the modal OPEN on failure so the error is read where the action was taken (a
      // wrong passphrase here means nothing was written — restore verifies before it writes).
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isImport = mode === 'import'
  const needsTypedConfirm = !!diff?.destructive
  const confirmOk = !needsTypedConfirm || confirmWord.trim().toUpperCase() === OVERWRITE_CONFIRM_WORD

  if (applied) {
    return (
      <Done
        onBack={onBack}
        title={t('backupTransfer.doneTitle')}
        body={t('backupTransfer.doneBody', { count: String(payload?.keys.length ?? 0) })}
      />
    )
  }

  return (
    <div className="space-y-6">
      <Header
        title={isImport ? t('backupTransfer.importTitle') : t('backupTransfer.compareTitle')}
        subtitle={isImport ? t('backupTransfer.importSubtitle') : t('backupTransfer.compareSubtitle')}
        onBack={onBack}
        backLabel={t('backupTransfer.back')}
      />

      {step === 'pick' && (
        <Card className="mx-auto w-full max-w-2xl space-y-4">
          {isImport && <Alert kind="warn">{t('backupTransfer.importWarning')}</Alert>}

          <div className="space-y-2">
            <Label>{t('backupTransfer.step1')}</Label>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={() => void pickFile()}>
              {t('backupTransfer.chooseFile')}
            </Button>
            {raw && filename && (
              <div className="flex items-start gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <span aria-hidden="true">✓</span>
                {/* Mono — this is a value the user verifies character by character (picking the
                    wrong backup file is the entire risk this screen exists to manage). */}
                <Mono className="text-[11px] text-emerald-700 dark:text-emerald-300">{filename}</Mono>
              </div>
            )}
          </div>

          {raw && (
            <div className="space-y-2">
              <Label>{t('backupTransfer.step2')}</Label>
              <PasswordInput
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pass && !busy) unlockFile()
                }}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {/* The single most confusing thing about this screen: it is NOT necessarily the
                  passphrase they just used to unlock the app. */}
              <p className="text-xs text-ink-muted">{t('backupTransfer.passphraseHint')}</p>
              <Button className="w-full sm:w-auto" disabled={!pass || busy} onClick={unlockFile}>
                {busy ? t('backupTransfer.opening') : t('backupTransfer.openFile')}
              </Button>
            </div>
          )}

          {error && <Alert kind="error">{error}</Alert>}
        </Card>
      )}

      {step === 'review' && diff && (
        <div className="space-y-6">
          {/* Which file this diff is about — kept on screen through the whole review so the
              decision to overwrite is never made against an unnamed file. */}
          <div className="space-y-1.5 border border-line bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs text-ink-muted">{t('backupTransfer.comparingWith')}</span>
              <Mono className="text-[11px] text-ink">{filename}</Mono>
            </div>
            {/* Which passphrase opened this file is the ONE fact the diff below cannot show —
                it compares decrypted contents, so it is blind to the envelope. On COMPARE that
                is the whole point of the screen (telling files apart), so name it here beside
                the filename. Import omits it: its ApplyCard already carries the stronger,
                unconditional warning that this device's unlock passphrase becomes the file's. */}
            {!isImport && <p className="text-[11px] leading-snug text-ink-muted">{t('backupTransfer.comparePassphraseNote')}</p>}
          </div>

          {/* An over-limit backup is RESTORED IN FULL — never refused. A cap added today must
              not make a backup written yesterday unrecoverable. Say so plainly, because a user
              who has seen the "maximum 1000 keys" message elsewhere would otherwise reasonably
              fear the extras are being silently dropped. */}
          {payload && (payload.keys.length > MAX_KEYS || payload.vaults.length > MAX_VAULTS) && (
            <Alert kind="warn">{t('backupTransfer.overLimitNote')}</Alert>
          )}

          <Summary diff={diff} mode={mode} />

          {/* The diff itself. Two columns on lg+ (keys beside vaults) — a wide screen showing
              one narrow strip of rows is the widescreen rule's exact failure case. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <KeysSection rows={diff.keys} mode={mode} />
            <div className="space-y-6">
              <VaultsSection rows={diff.vaults} mode={mode} />
              {diff.settings.length > 0 && <SettingsSection diff={diff} mode={mode} />}
            </div>
          </div>

          {isImport && (
            <ApplyCard
              diff={diff}
              pass={applyPass}
              onPassChange={setApplyPass}
              confirmWord={confirmWord}
              onConfirmWordChange={setConfirmWord}
              needsTypedConfirm={needsTypedConfirm}
              confirmOk={confirmOk}
              busy={busy}
              // The error belongs to the modal once it's open (that's where the action was
              // taken); the card only shows an error if something failed outside it.
              error={confirmOpen ? null : error}
              onApply={() => {
                setError(null)
                setConfirmOpen(true)
              }}
              onCancel={onBack}
            />
          )}

          {isImport && (
            <FinalConfirmModal
              open={confirmOpen}
              diff={diff}
              busy={busy}
              error={error}
              onCancel={() => {
                setConfirmOpen(false)
                setError(null)
              }}
              onConfirm={() => void applyImport()}
            />
          )}

          {!isImport && (
            <Card className="mx-auto w-full max-w-2xl space-y-3">
              {/* Compare's whole promise is that it wrote nothing. Say so explicitly — a
                  read-only tool that doesn't claim to be read-only isn't reassuring. */}
              <Alert kind="ok">{t('backupTransfer.compareReadOnly')}</Alert>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="secondary" className="w-full sm:w-auto" onClick={() => resetTo(setPayload, setRaw, setPass)}>
                  {t('backupTransfer.compareAnother')}
                </Button>
                <Button variant="ghost" className="w-full sm:w-auto" onClick={onBack}>
                  {t('backupTransfer.back')}
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

function resetTo(
  setPayload: (v: BackupPayload | null) => void,
  setRaw: (v: string | null) => void,
  setPass: (v: string) => void,
) {
  setPayload(null)
  setRaw(null)
  setPass('')
}

function readLocale(): string | undefined {
  try {
    return localStorage.getItem('signbit.locale') ?? undefined
  } catch {
    return undefined
  }
}

function Header({
  title,
  subtitle,
  onBack,
  backLabel,
}: {
  title: string
  subtitle: string
  onBack: () => void
  backLabel: string
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        // min-h-11 — this is the only way out of the screen on a phone.
        className="-ml-1 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm text-ink-muted transition-colors hover:text-ink sm:min-h-0"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        {backLabel}
      </button>
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        <p className="text-sm text-ink-muted">{subtitle}</p>
      </div>
    </div>
  )
}

/*
  The headline. On a destructive import this is the LOUDEST thing on the screen — the count of
  keys that are about to stop existing, stated in those words, above everything else.
*/
function Summary({ diff, mode }: { diff: BackupDiff; mode: TransferMode }) {
  const { t } = useI18n()
  const { totals } = diff

  if (diff.identical) {
    return (
      <Card className="mx-auto w-full max-w-2xl space-y-3">
        <Alert kind="ok">{t('backupTransfer.identical')}</Alert>
        {/* ⚠️ "Identical" means identical CONTENTS — the diff runs on the decrypted payload and
            is passphrase-blind by design (identity is the derived fingerprint, see
            lib/backup-diff.ts). Two files holding the same keys under DIFFERENT passphrases
            therefore compare as identical, and the only evidence they differ is the passphrase
            the user just typed, which this screen would otherwise never mention.

            That used to be an edge case. Change-passphrase makes it routine: its whole purpose
            is to leave old backups on the old passphrase while the device and any new backup
            move to the new one. The failure it invites is quiet and slow — someone finds two
            backups a year later, is told they are identical, keeps whichever is handier, and
            has a 50% chance of keeping the one whose passphrase they no longer remember. */}
        <p className="text-xs text-ink-muted">{t('backupTransfer.identicalPassphraseNote')}</p>
      </Card>
    )
  }

  return (
    <Card className="space-y-4">
      {diff.destructive && mode === 'import' && (
        <Alert kind="error">{t('backupTransfer.destructiveWarning', { count: String(totals.keysRemoved) })}</Alert>
      )}
      {/* Stat tiles wrap on a phone (2-up) and spread on desktop — no fixed row that overflows. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('backupTransfer.statKeysRemoved')} value={totals.keysRemoved} tone={totals.keysRemoved > 0 ? 'danger' : 'idle'} />
        <Stat label={t('backupTransfer.statKeysAdded')} value={totals.keysAdded} tone={totals.keysAdded > 0 ? 'add' : 'idle'} />
        <Stat label={t('backupTransfer.statVaultsChanged')} value={totals.vaultsAdded + totals.vaultsRemoved + totals.vaultsChanged} tone="idle" />
        <Stat label={t('backupTransfer.statSettings')} value={totals.settingsChanged} tone="idle" />
      </div>
    </Card>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'idle' | 'add' | 'danger' }) {
  const tones = {
    idle: 'border-line text-ink',
    add: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
    danger: 'border-red-500/50 text-red-700 dark:text-red-300',
  }
  return (
    <div className={`border ${tones[tone]} bg-surface-2 px-3 py-2`}>
      <div className="font-mono text-xl">{value}</div>
      <div className="text-[11px] leading-tight text-ink-muted">{label}</div>
    </div>
  )
}

/*
  Status chip. Wording is MODE-AWARE and future-tense for import ("will be deleted"), plain
  present-tense for compare ("only on this device") — the same underlying status means two very
  different things depending on whether a write is about to happen.
*/
function StatusChip({ status, mode }: { status: DiffStatus; mode: TransferMode }) {
  const { t } = useI18n()
  const tones: Record<DiffStatus, string> = {
    removed: 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300',
    added: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    changed: 'border-brand-500/50 bg-brand-500/10 text-brand-700 dark:text-brand-300',
    unchanged: 'border-line bg-surface-2 text-ink-muted',
  }
  return (
    <span className={`inline-flex shrink-0 border px-1.5 py-0.5 text-[11px] font-medium ${tones[status]}`}>
      {t(`backupTransfer.status.${mode}.${status}`)}
    </span>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <Label>{title}</Label>
        <span className="font-mono text-xs text-ink-muted">{count}</span>
      </div>
      {children}
    </Card>
  )
}

function KeysSection({ rows, mode }: { rows: KeyDiff[]; mode: TransferMode }) {
  const { t } = useI18n()
  return (
    <Section title={t('backupTransfer.sectionKeys')} count={rows.length}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('backupTransfer.noKeys')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((k, i) => (
            <li
              key={k.fingerprint ?? `row-${i}`}
              className={`border p-3 ${k.status === 'removed' ? 'border-red-500/40 bg-red-500/5' : 'border-line bg-surface-2'}`}
            >
              {/* Stacks on a phone, one row from sm up — a label + chip forced side-by-side
                  at 320px squeezes the label to nothing. */}
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">
                    {k.deviceLabel ?? k.backupLabel}
                  </div>
                  {k.labelChanged && (
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {t('backupTransfer.labelChange', { from: k.deviceLabel ?? '', to: k.backupLabel ?? '' })}
                    </div>
                  )}
                  {k.fingerprint ? (
                    <Mono className="mt-1 block text-[11px] text-ink-muted">{k.fingerprint}</Mono>
                  ) : (
                    <div className="mt-1 text-[11px] text-brand-600 dark:text-brand-400">
                      {t('backupTransfer.unreadableKey')}
                    </div>
                  )}
                </div>
                <StatusChip status={k.status} mode={mode} />
              </div>
              {/* The single most important sentence on the screen, on the row it applies to. */}
              {k.status === 'removed' && mode === 'import' && (
                <p className="mt-2 text-xs text-red-700 dark:text-red-300">{t('backupTransfer.keyWillBeLost')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function VaultsSection({ rows, mode }: { rows: VaultDiff[]; mode: TransferMode }) {
  const { t } = useI18n()
  return (
    <Section title={t('backupTransfer.sectionVaults')} count={rows.length}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('backupTransfer.noVaults')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((v) => (
            <li key={v.descriptor} className="border border-line bg-surface-2 p-3">
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{v.deviceLabel ?? v.backupLabel}</div>
                  {v.labelChanged && (
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {t('backupTransfer.labelChange', { from: v.deviceLabel ?? '', to: v.backupLabel ?? '' })}
                    </div>
                  )}
                  {/* Descriptors are long; break-all + a small font keeps them inside a 320px
                      card instead of widening the page. */}
                  <Mono className="mt-1 block text-[11px] leading-snug text-ink-muted">{v.descriptor}</Mono>
                  {v.changeDescriptor !== 'same' && (
                    <div className="mt-1.5 text-xs text-brand-700 dark:text-brand-300">
                      {t(`backupTransfer.changeDescriptor.${v.changeDescriptor}`)}
                    </div>
                  )}
                  {/* Cosigner names — restore replaces the device's vault list wholesale, so
                      a difference here IS a rename the user should see coming. */}
                  {v.keyLabels !== 'same' && (
                    <div className="mt-1.5 text-xs text-brand-700 dark:text-brand-300">
                      {t(`backupTransfer.keyLabels.${v.keyLabels}`)}
                    </div>
                  )}
                </div>
                <StatusChip status={v.status} mode={mode} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function SettingsSection({ diff, mode }: { diff: BackupDiff; mode: TransferMode }) {
  const { t } = useI18n()
  return (
    <Section title={t('backupTransfer.sectionSettings')} count={diff.settings.length}>
      <ul className="space-y-2">
        {diff.settings.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center justify-between gap-2 border border-line bg-surface-2 px-3 py-2">
            <span className="text-sm text-ink">{t(`backupTransfer.setting.${s.key}`)}</span>
            <span className="font-mono text-xs text-ink-muted">
              {s.deviceValue}
              <span className="mx-1.5 text-ink-muted/60">{mode === 'import' ? '→' : 'vs'}</span>
              <span className="text-ink">{s.backupValue}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/*
  The apply gate. Two locks, and both exist for a reason:
   1. The file's passphrase, re-entered — restoreFromBackup verifies it AGAIN before writing
      anything (verify-before-write, lib/restore.ts guarantee 1), so a typo here costs nothing.
   2. Type-to-confirm, but ONLY when the import destroys a key. A confirm word on a harmless
      import trains people to type it without reading, which is exactly how the dangerous one
      gets waved through.
*/
function ApplyCard({
  diff,
  pass,
  onPassChange,
  confirmWord,
  onConfirmWordChange,
  needsTypedConfirm,
  confirmOk,
  busy,
  error,
  onApply,
  onCancel,
}: {
  diff: BackupDiff
  pass: string
  onPassChange: (v: string) => void
  confirmWord: string
  onConfirmWordChange: (v: string) => void
  needsTypedConfirm: boolean
  confirmOk: boolean
  busy: boolean
  error: string | null
  onApply: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  return (
    <Card className="mx-auto w-full max-w-2xl space-y-4">
      <div>
        <Label>{t('backupTransfer.applyTitle')}</Label>
        <p className="text-xs text-ink-muted">{t('backupTransfer.applyBody')}</p>
      </div>

      {/* Importing re-encrypts the keystore under the FILE's passphrase — i.e. it silently
          changes how this device unlocks. Someone who then locks the app and types their old
          passphrase would think the app had eaten their keys. Say it before, not after. */}
      <Alert kind="warn">{t('backupTransfer.passphraseChangeWarning')}</Alert>

      {diff.destructive && (
        <Alert kind="error">{t('backupTransfer.destructiveWarning', { count: String(diff.totals.keysRemoved) })}</Alert>
      )}

      <div className="space-y-1.5">
        <Label>{t('backupTransfer.applyPassphraseLabel')}</Label>
        <PasswordInput
          value={pass}
          onChange={(e) => onPassChange(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {needsTypedConfirm && (
        <div className="space-y-1.5">
          <Label>{t('backupTransfer.typeToConfirmLabel', { word: OVERWRITE_CONFIRM_WORD })}</Label>
          <Input
            value={confirmWord}
            onChange={(e) => onConfirmWordChange(e.target.value)}
            placeholder={OVERWRITE_CONFIRM_WORD}
            aria-label={t('backupTransfer.typeToConfirmLabel', { word: OVERWRITE_CONFIRM_WORD })}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      )}

      {error && <Alert kind="error">{error}</Alert>}

      {/* Reverse order on sm+ puts the destructive action on the right (platform convention);
          on a phone the primary sits on top where the thumb lands. */}
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button
          variant={diff.destructive ? 'danger' : 'primary'}
          className="w-full sm:w-auto"
          disabled={!pass || !confirmOk || busy}
          onClick={onApply}
        >
          {busy ? t('backupTransfer.applying') : t('backupTransfer.applyAction')}
        </Button>
        <Button variant="secondary" className="w-full sm:w-auto" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </Card>
  )
}

/*
  The LAST stop before anything is written.

  Everything before this point is reversible: picking a file, decrypting it, reading the diff,
  even typing OVERWRITE. Pressing Confirm here is the first irreversible act, so it gets its own
  deliberate surface rather than sharing the card the user was just filling in — warnings read
  while completing a form get skimmed; a modal has to be dismissed on purpose.

  The wording is the plainest true statement of the stakes: seeds that exist only on this device
  and are not written down are destroyed, and the funds those keys control become unspendable.
  Not "data may be lost" — the specific, unrecoverable consequence.

  Deliberately NOT a second type-to-confirm: OVERWRITE is already typed in the card above when
  the import is destructive, and stacking two identical friction gates trains people to clear
  both without reading either.
*/
function FinalConfirmModal({
  open,
  diff,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean
  diff: BackupDiff
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  return (
    <Modal open={open} onClose={busy ? () => {} : onCancel} title={t('backupTransfer.finalConfirmTitle')}>
      <div className="space-y-4">
        <Alert kind="error">{t('backupTransfer.finalConfirmSeedWarning')}</Alert>

        {/* Name the keys that are about to stop existing. A count is abstract; a label the user
            recognises is what makes someone stop and check their seed card. */}
        {diff.destructive && (
          <div className="space-y-2 border border-red-500/40 bg-red-500/5 p-3">
            <div className="text-xs font-medium text-red-700 dark:text-red-300">
              {t('backupTransfer.finalConfirmKeysHeading', { count: String(diff.totals.keysRemoved) })}
            </div>
            <ul className="space-y-1">
              {diff.keys
                .filter((k) => k.status === 'removed')
                .map((k, i) => (
                  <li key={k.fingerprint ?? `lost-${i}`} className="min-w-0">
                    <div className="truncate text-sm text-ink">{k.deviceLabel}</div>
                    {k.fingerprint && <Mono className="text-[11px] text-ink-muted">{k.fingerprint}</Mono>}
                  </li>
                ))}
            </ul>
          </div>
        )}

        <p className="text-sm text-ink-muted">{t('backupTransfer.finalConfirmBody')}</p>

        {error && <Alert kind="error">{error}</Alert>}

        {/* Cancel FIRST in DOM order on mobile (top of the stack, where a thumb rests) and on
            the left at sm+ — the destructive action should never be the easiest thing to hit. */}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button variant="danger" className="w-full sm:w-auto" disabled={busy} onClick={onConfirm}>
            {busy ? t('backupTransfer.applying') : t('backupTransfer.finalConfirmAction')}
          </Button>
          <Button variant="secondary" className="w-full sm:w-auto" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Done({ onBack, title, body }: { onBack: () => void; title: string; body: string }) {
  const { t } = useI18n()
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Card className="space-y-4">
        <Alert kind="ok">{title}</Alert>
        <p className="text-sm text-ink-muted">{body}</p>
        <Button className="w-full sm:w-auto" onClick={onBack}>
          {t('backupTransfer.back')}
        </Button>
      </Card>
    </div>
  )
}

function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  )
}
