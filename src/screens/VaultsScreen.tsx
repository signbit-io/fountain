import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Card, Input, Label, Textarea, Alert, Mono, CopyButton, CopyInline, Modal } from '../components/ui'
import { useI18n } from '../i18n'
import {
  readVaultBackups,
  addVaultBackup,
  addMissingChangeDescriptor,
  removeVaultBackup,
  parseDescriptorSummary,
  sniffDescriptorNetwork,
  saveLastDerived,
  readVaultDraft,
  writeVaultDraft,
  clearVaultDraft,
  findVaultBackupByDescriptor,
  isDraftWorthKeeping,
  renameVaultBackup,
  setVaultKeyLabel,
  draftRowInUse,
  fitRowsToSize,
  fitDraftToVaultSize,
  formatVaultBackupFile,
  vaultBackupFileName,
  type ParsedDescriptor,
  type VaultBackup,
  type VaultDraftKey,
} from '../lib/vaults'
import {
  buildVaultDescriptor,
  canonicalKeyOrder,
  changeDescriptorFor,
  duplicateKey,
  normalizeXpub,
  normalizeFingerprint,
  deriveAddress,
  keyInputProblem,
  VAULT_SIZES,
  BuildDescriptorError,
  type KeyInputProblem,
} from '../lib/build-descriptor'
import { readVaultInput, type VaultInput, type VaultInputProblem, type VaultInputResult } from '../lib/vault-input'
import type { NetworkName } from '../lib/bitcoin-network'
import { readTextFile, saveTextFile } from '../lib/download'
import { parseKeyFile, type KeyFileErrorCode } from '../lib/key-file'
import { useKeystore } from '../lib/keystore'
import { accountKey, networkOf } from '../lib/key'
import type { KeyEntry } from '../lib/crypto'

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/* The fintech pass's small square tag (no pills, no tinted fill). */
const TAG = 'inline-flex h-5 shrink-0 items-center gap-1.5 border border-line px-1.5 text-xs font-semibold leading-none'

/* A statement panel nested inside the vault row's tinted body: solid card surface, ruled
   header bar, rows edge to edge. */
const PANEL = 'border border-line bg-surface-2'
const PANEL_HEAD = 'flex min-h-11 items-center justify-between gap-2 border-b border-line px-4 py-2'
const PANEL_TITLE = 'text-[15px] font-semibold tracking-[-0.01em] text-ink'

/* A raw descriptor/address block inside a panel. Panels are bg-surface-2, so the inner fill
   is bg-surface (a surface-2 fill would be invisible there). */
const RAW_BLOCK = 'block break-all border border-line bg-surface p-2'

/* A text-style action (show/hide, add) sized for a finger. */
const TEXT_ACTION =
  'inline-flex min-h-11 items-center text-[13px] text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink'

/*
  Vault backups — a local, offline cache of vault DESCRIPTORS (public data: xpubs +
  derivation paths + checksum, no secrets). If the platform is ever unreachable, a keyholder
  who saved their vault's descriptor here can still reconstruct addresses / verify a PSBT's
  outputs in a third-party tool (e.g. Sparrow) using only this descriptor + their own key.

  Two ways to get a descriptor into this cache: PASTE one the platform's vault page already
  makes downloadable (AddVaultForm — the original, simpler path), or BUILD one from scratch offline
  (BuildVaultForm — the "coparties in a room together, platform unreachable or not involved
  at all" scenario, lib/build-descriptor.ts). Building needs every keyholder's public key
  (xpub + fingerprint, INCLUDING the platform's if this vault will ever sync to the platform — but
  nothing requires that). The result drops straight into the same cache either way and can be
  used standalone in a third-party multisig tool (Sparrow, etc.).

  ⚠️ SUBPAGES, NOT DROPDOWNS (user, 2026-11-11: "not a fan of these multi dropdown layouts ...
  what ends up happening is just a long scrolling and messy vertical"). The screen used to be
  one column of collapsibles: the add form, then every vault as an expandable row with more
  expandable sections inside. It is now one page at a time:
  - the LIST (each vault one row that opens it; the two ways to add as buttons at the top);
  - one VAULT, its sections as tabs (Keys, Addresses, Descriptor);
  - PASTE, and BUILD (a stepped page of its own).
  `page` is plain component state: `main` is keyed by tab in App.tsx, so leaving the Vaults tab
  and coming back always lands on the list.
*/
type VaultsPage =
  | { kind: 'list' }
  | { kind: 'paste' }
  | { kind: 'build' }
  | { kind: 'vault'; id: string; notice?: string }

export function VaultsScreen({ network }: { network: NetworkName }) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<VaultBackup[]>(() => readVaultBackups())
  const [removing, setRemoving] = useState<VaultBackup | null>(null)
  const [page, setPage] = useState<VaultsPage>({ kind: 'list' })
  const { entries: keyEntries } = useKeystore()
  const ownKeys = useOwnKeys(keyEntries)
  const ownFingerprints = useMemo(() => new Set(ownKeys.map((k) => k.fingerprint)), [ownKeys])

  // Each page starts at the top, not wherever the last one was scrolled to.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [page])

  const toList = () => setPage({ kind: 'list' })
  const open = page.kind === 'vault' ? entries.find((e) => e.id === page.id) ?? null : null

  if (page.kind === 'paste') {
    return (
      <div className="space-y-5 animate-fade-in">
        <BackLink label={t('vaults.backToList')} onClick={toList} />
        <PageHeading title={t('vaults.addTitle')} subtitle={t('vaults.pasteIntro')} />
        <Card>
          <AddVaultForm
            network={network}
            ownFingerprints={ownFingerprints}
            onAdded={(entry, notice) => {
              setEntries((prev) => [...prev, entry])
              setPage({ kind: 'vault', id: entry.id, notice })
            }}
          />
        </Card>
      </div>
    )
  }

  if (page.kind === 'build') {
    return (
      <div className="space-y-5 animate-fade-in">
        <BackLink label={t('vaults.backToList')} onClick={toList} />
        <BuildVaultForm
          network={network}
          ownKeys={ownKeys}
          onAdded={(entry) => setEntries((prev) => [...prev, entry])}
          onOpenVault={(id) => setPage({ kind: 'vault', id })}
        />
      </div>
    )
  }

  if (open) {
    return (
      <div className="space-y-5 animate-fade-in">
        <BackLink label={t('vaults.backToList')} onClick={toList} />
        <VaultPage
          key={open.id}
          entry={open}
          notice={page.kind === 'vault' ? page.notice : undefined}
          ownFingerprints={ownFingerprints}
          onRemove={() => setRemoving(open)}
          onUpdated={(updated) => setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))}
        />
        {removing && (
          <RemoveVaultModal
            entry={removing}
            onConfirm={() => {
              removeVaultBackup(removing.id, removing.descriptor)
              setEntries((prev) => prev.filter((e) => e.id !== removing.id))
              setRemoving(null)
              toList()
            }}
            onClose={() => setRemoving(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-[-0.03em] text-ink">{t('vaults.title')}</h2>
            <span className={cx(TAG, 'tabular-nums text-ink-muted')}>{entries.length}</span>
          </div>
          <p className="mt-1 text-sm text-ink-muted">{t('vaults.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setPage({ kind: 'paste' })}>
            <PasteIcon className="h-4 w-4" />
            {t('vaults.modePaste')}
          </Button>
          <Button onClick={() => setPage({ kind: 'build' })}>
            <PlusIcon className="h-4 w-4" />
            {t('vaults.modeBuild')}
          </Button>
        </div>
      </div>

      {entries.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center border border-line text-ink-muted">
            <VaultGlyph className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{t('vaults.emptyTitle')}</p>
          <p className="max-w-xs text-sm text-ink-muted">{t('vaults.emptySubtitle')}</p>
        </Card>
      ) : (
        /*
          ⚠️ ONE RULED LEDGER, a row per vault (fintech pass, 2026-11-08), not a grid of cards.
          A row spans the full width at every size, so there is no column count to cap and
          nothing to shrink on the narrowest phones. Since 2026-11-11 a row only OPENS its vault
          (a page of its own); nothing expands in place.
        */
        <section className="card overflow-hidden animate-fade-in-up">
          <div className="border-b border-line px-4 py-3 sm:px-5">
            <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{t('backupTransfer.sectionVaults')}</h3>
          </div>
          <ul className="divide-y divide-line">
            {entries.map((v, i) => (
              <VaultRow
                key={v.id}
                delayMs={i * 60}
                entry={v}
                ownFingerprints={ownFingerprints}
                onOpen={() => setPage({ kind: 'vault', id: v.id })}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/* "← All vaults": the way back from every subpage. */
function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <ChevronLeftIcon className="h-4 w-4" />
      {label}
    </button>
  )
}

function PageHeading({ title, subtitle, aside }: { title: string; subtitle?: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 max-w-2xl">
        <h2 className="text-2xl font-semibold tracking-[-0.03em] text-ink">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {aside}
    </div>
  )
}

/*
  An underlined tab row (selected = orange underline, never an orange fill), the look the old
  paste/build switch and the address branch picker already used. Real tabs for assistive tech.
*/
function TabRow<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex overflow-x-auto border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cx(
            '-mb-px min-h-11 shrink-0 border-b-2 px-4 text-sm font-semibold transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
            value === tab.id ? 'border-brand-500 text-ink' : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function PasteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="6" y="4" width="12" height="17" rx="1.5" />
      <path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" />
    </svg>
  )
}

function VaultGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3.5" y="7" width="17" height="13" rx="1.5" />
      <path d="M7 7V5.5A2.5 2.5 0 0 1 9.5 3h5A2.5 2.5 0 0 1 17 5.5V7" />
      <circle cx="12" cy="13" r="1.75" />
      <path d="M12 14.75V17" />
    </svg>
  )
}

/* A small pencil glyph for the inline rename triggers (vault label + cosigner names).
   Mirrors the Keys screen's, which is where this rename pattern already lives. */
function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      <path d="M14.5 5.5l3 3" />
    </svg>
  )
}

/* A key held in this device's keystore, as the builder and the vault list need it: PUBLIC
   parts only, derived once at the screen (BIP-32 per key) and passed down. */
type OwnKey = { id: string; label: string; xpub: string; fingerprint: string; network: NetworkName }

/* The facts strip of a vault (the account header pattern): labelled cells, two per line on a
   phone, four across from sm up. Shared by a saved vault's row and the paste form's preview, so
   "what Fountain found" reads exactly like what it will save. */
function FactsStrip({ facts }: { facts: { label: string; value: string; cls?: string }[] }) {
  const borders = ['', 'border-l border-line', 'border-t border-line sm:border-l sm:border-t-0', 'border-l border-t border-line sm:border-t-0']
  return (
    <dl className="grid grid-cols-2 border-t border-line sm:grid-cols-4">
      {facts.map((f, i) => (
        <div key={f.label} className={cx('min-w-0 px-4 py-3 sm:px-5', borders[i])}>
          <dt className="text-[13px] text-ink-muted">{f.label}</dt>
          <dd className={cx('mt-0.5 text-[15px] font-semibold text-ink', f.cls)}>{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function useSummaryFacts(summary: ParsedDescriptor | null, descriptor: string) {
  const { t } = useI18n()
  return summary
    ? [
        { label: t('vaults.summaryRequired'), value: String(summary.threshold), cls: 'tabular-nums' },
        { label: t('backupTransfer.sectionKeys'), value: String(summary.total), cls: 'tabular-nums' },
        { label: t('settings.network.label'), value: sniffDescriptorNetwork(descriptor), cls: 'capitalize' },
        { label: t('vaults.summaryChecksum'), value: summary.checksum, cls: 'break-all font-mono' },
      ]
    : []
}

/* The localized sentence for a paste-form problem code. */
function useInputProblemText() {
  const { t } = useI18n()
  return (p: VaultInputProblem) =>
    p === 'empty' ? t('vaults.errorRequired') : t(`vaults.inputProblem.${p}` as `vaults.inputProblem.${Exclude<VaultInputProblem, 'empty'>}`)
}

/*
  Save a vault backup as a `.txt` file in the platform's own layout (lib/vaults.ts
  formatVaultBackupFile), through the same native Save-As every other export uses. Public data,
  so not passphrase-gated, like the public key export.
*/
function SaveFileButton({
  entry,
  look = 'button',
}: {
  entry: Pick<VaultBackup, 'label' | 'descriptor' | 'changeDescriptor'>
  look?: 'button' | 'link'
}) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'saved' | 'error'>('idle')
  async function save() {
    setState('idle')
    try {
      const res = await saveTextFile(vaultBackupFileName(entry.label), formatVaultBackupFile(entry), [
        { name: 'Text', extensions: ['txt'] },
      ])
      if (res.status === 'saved') setState('saved')
    } catch {
      setState('error')
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {look === 'button' ? (
        <Button variant="secondary" onClick={() => void save()}>
          <FileIcon className="h-4 w-4" />
          {t('vaults.saveFile')}
        </Button>
      ) : (
        <button type="button" onClick={() => void save()} className={TEXT_ACTION}>
          {t('vaults.saveFile')}
        </button>
      )}
      {state === 'saved' && (
        <span role="status" className="text-[13px] text-emerald-700 animate-scale-in dark:text-emerald-300">
          {t('vaults.fileSaved')}
        </span>
      )}
      {state === 'error' && (
        <span role="alert" className="text-[13px] text-red-600 dark:text-red-400">
          {t('vaults.fileSaveError')}
        </span>
      )}
    </span>
  )
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8Z" />
      <path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

/*
  Save a vault someone already has: paste the descriptor (or a whole backup file), or import the
  file. ⚠️ READ FIRST, THEN SAVE (2026-11-11). The text is read on every edit by
  lib/vault-input.ts and the panel below says what it found (size, keys and which one is this
  device, network, checksum, the first address) or what is wrong, in the user's language. Save
  is enabled only for a reading that checks out, so a changed character, a change descriptor
  from another vault, or a private key never reaches the cache the recovery path depends on.
  The change descriptor is worked out from the receive one when none is given.

  Importing a file still SAVES at once when the file reads cleanly — picking the file is the
  intent, and the old two-step import had a dead-click window (docs/vault-cache.md §8). A file
  that does not read cleanly is refused with the same message the paste would show.
*/
function AddVaultForm({
  network,
  ownFingerprints,
  onAdded,
}: {
  network: NetworkName
  ownFingerprints: Set<string>
  /** Saved: the screen opens the new vault's page and shows `notice` there. */
  onAdded: (entry: VaultBackup, notice: string) => void
}) {
  const { t } = useI18n()
  const problemText = useInputProblemText()
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  const [changeText, setChangeText] = useState('')
  const [showChange, setShowChange] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pure and cheap (a checksum or two and one address), so it runs on every edit.
  const reading = useMemo(() => (text.trim() ? readVaultInput(text, showChange ? changeText : '') : null), [text, changeText, showChange])
  const ready = reading?.ok ? reading.value : null

  function save(input: VaultInput, labelOverride: string) {
    // A repeat save DOES add a second copy (see addVaultBackup). Say so plainly, and name the
    // entry, since the label may have been suffixed to keep the two apart.
    const duplicate = findVaultBackupByDescriptor(input.descriptor) != null
    const entry = addVaultBackup(labelOverride || input.label, input.descriptor, input.changeDescriptor)
    onAdded(entry, duplicate ? t('vaults.importSavedCopy', { label: entry.label }) : t('vaults.importSaved', { label: entry.label }))
  }

  function submit() {
    setError(null)
    if (!reading) {
      setError(t('vaults.errorRequired'))
      return
    }
    if (!reading.ok) {
      setError(problemText(reading.problem))
      return
    }
    try {
      save(reading.value, label.trim())
    } catch (e) {
      // The vault cap (lib/limits.ts) throws here.
      setError(e instanceof Error ? e.message : t('vaults.buildErrorGeneric'))
      return
    }
    setLabel('')
    setText('')
    setChangeText('')
    setShowChange(false)
  }

  async function importFile() {
    setError(null)
    const res = await readTextFile({
      accept: '.txt,text/plain',
      tooLargeMessage: t('vaults.errorFileTooLarge'),
      readErrorMessage: t('vaults.errorReadFile'),
    })
    if (res.status === 'rejected') {
      setError(res.reason)
      return
    }
    if (res.status !== 'ok') return // 'cancelled' → the user closed the picker
    const read = readVaultInput(res.text)
    if (!read.ok) {
      setError(problemText(read.problem))
      return
    }
    try {
      save(read.value, label.trim())
      setLabel('')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('vaults.errorReadFile'))
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-end justify-between gap-2">
          <Label>{t('vaults.pasteLabel')}</Label>
          <Button variant="secondary" className="mb-1.5 min-h-11 shrink-0 px-3 py-0 text-xs sm:min-h-9" onClick={() => void importFile()}>
            <FileIcon className="h-4 w-4" />
            {t('vaults.importFile')}
          </Button>
        </div>
        <Textarea
          rows={4}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
                    setError(null)
          }}
          placeholder={t('vaults.descriptorPlaceholder')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div>
        <button type="button" onClick={() => setShowChange((v) => !v)} aria-expanded={showChange} className={TEXT_ACTION}>
          {showChange ? t('vaults.changeToggleHide') : t('vaults.changeToggleShow')}
        </button>
        {showChange && (
          <div className="mt-1 animate-fade-in">
            <Label>{t('vaults.changeDescriptorLabel')}</Label>
            <Textarea
              rows={3}
              value={changeText}
              onChange={(e) => setChangeText(e.target.value)}
              placeholder={t('vaults.changeDescriptorPlaceholder')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        )}
      </div>

      {reading && <VaultPreview reading={reading} network={network} ownFingerprints={ownFingerprints} />}

      <div>
        <Label>{t('vaults.label')}</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={ready?.label || t('vaults.labelPlaceholder')}
        />
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <Button onClick={submit} disabled={!ready}>
        {t('vaults.save')}
      </Button>
    </div>
  )
}

/* "What Fountain found": the paste form's live reading, laid out like the saved vault's row. */
function VaultPreview({
  reading,
  network,
  ownFingerprints,
}: {
  reading: VaultInputResult
  network: NetworkName
  ownFingerprints: Set<string>
}) {
  const { t } = useI18n()
  const problemText = useInputProblemText()
  const value = reading.ok ? reading.value : null
  const facts = useSummaryFacts(value?.summary ?? null, value?.descriptor ?? '')
  const existing = value ? findVaultBackupByDescriptor(value.descriptor) : undefined
  // The app's toggle may name signet, which shares testnet's keys; only a real difference counts.
  const appNet = network === 'mainnet' ? 'mainnet' : 'testnet'

  return (
    <section className={cx(PANEL, 'animate-fade-in')} aria-live="polite">
      <div className={PANEL_HEAD}>
        <h4 className={PANEL_TITLE}>{t('vaults.preview.title')}</h4>
        {value ? (
          <span className={cx(TAG, 'text-ink animate-scale-in')}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {value.summary ? t('vaults.sizeShort', { m: value.summary.threshold, n: value.summary.total }) : t('vaults.slotReady')}
          </span>
        ) : (
          <span className={cx(TAG, 'text-red-700 dark:text-red-300')}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {t('vaults.slotCheck')}
          </span>
        )}
      </div>
      {!reading.ok ? (
        <div className="p-3">
          <Alert kind="error">{problemText(reading.problem)}</Alert>
        </div>
      ) : (
        <>
          {facts.length > 0 && <FactsStrip facts={facts} />}
          {value!.summary ? (
            <ul className="divide-y divide-line border-t border-line">
              {value!.summary.keys.map((k, i) => (
                <li key={k.fingerprint + i} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm">
                  <span className="font-medium text-ink-muted">{t('vaults.summarySigner', { index: i + 1 })}</span>
                  {ownFingerprints.has(k.fingerprint) && (
                    <span className={cx(TAG, 'text-ink')}>
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                      {t('vaults.summaryThisDevice')}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-xs uppercase tabular-nums text-ink-muted">{k.fingerprint}</span>
                  <Mono className="text-ink-muted">{k.xpubShort}</Mono>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-line px-4 py-3 text-[13px] text-ink-muted">{t('vaults.preview.unknownShape')}</p>
          )}
          <div className="space-y-2 border-t border-line px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <Label>{t('vaults.preview.firstAddress')}</Label>
              <CopyButton value={value!.firstAddress} />
            </div>
            <Mono className={RAW_BLOCK}>{value!.firstAddress}</Mono>
            <p className="text-[13px] text-ink-muted">{t('vaults.preview.firstAddressHint')}</p>
          </div>
          <div className="space-y-2 border-t border-line p-3">
            <Alert kind="ok">{t('vaults.preview.ready')}</Alert>
            <p className="flex gap-2 px-1 text-[13px] text-ink-muted">
              <CheckIcon className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', value!.changeSource === 'none' ? 'text-ink-muted/50' : 'text-emerald-600')} />
              {value!.changeSource === 'derived'
                ? t('vaults.preview.changeDerived')
                : value!.changeSource === 'given'
                  ? t('vaults.preview.changeGiven')
                  : t('vaults.preview.changeNone')}
            </p>
            {value!.checksumAdded && <Alert kind="warn">{t('vaults.preview.checksumAdded')}</Alert>}
            {value!.network !== appNet && (
              <Alert kind="info">{t('vaults.preview.otherNetwork', { vaultNetwork: value!.network, appNetwork: appNet })}</Alert>
            )}
            {existing && <Alert kind="info">{t('vaults.preview.alreadySaved', { label: existing.label })}</Alert>}
          </div>
        </>
      )}
    </section>
  )
}

/* A builder row IS a draft row: same shape, persisted as typed. New rows get lib/vaults.ts's
   random id (fitRowsToSize), which only has to be unique within the form. */
type BuildKeyRow = VaultDraftKey

/* What a key starts with on each network, for the slot messages. Display only. */
const EXPECTED_PREFIXES: Record<NetworkName, string> = {
  mainnet: 'xpub / Zpub',
  testnet: 'tpub / Vpub',
  signet: 'tpub / Vpub',
}

type SlotInfo = {
  state: 'empty' | 'ready' | 'problem'
  problem: KeyInputProblem | null
  /** 1-based number of the EARLIER slot this one repeats, and how. */
  duplicateOf: number | null
  duplicateKind: 'xpub' | 'fingerprint' | null
  isMine: boolean
  noFingerprint: boolean
  canonical: string | null
}

/*
  Read every slot the way the build will: the row's own problem (keyInputProblem runs the
  build's checks in the build's order), then a repeat of an earlier slot, compared on the
  CANONICAL key so a tpub and its Vpub count as the same key (duplicateKey's rule). The first
  slot holding a key keeps it; the later one is the one marked, so the message can name which.
*/
function readSlots(rows: BuildKeyRow[], network: NetworkName, ownKeys: OwnKey[]): SlotInfo[] {
  const seenKey = new Map<string, number>()
  const seenFp = new Map<string, number>()
  return rows.map((row, i) => {
    const xpub = row.xpub.trim()
    const problem = keyInputProblem(row.xpub, row.fingerprint, network)
    let canonical: string | null = null
    if (xpub && !problem) {
      try {
        canonical = normalizeXpub(xpub, network)
      } catch {
        /* keyInputProblem has already named it */
      }
    }
    let duplicateOf: number | null = null
    let duplicateKind: SlotInfo['duplicateKind'] = null
    if (canonical) {
      const earlier = seenKey.get(canonical)
      if (earlier !== undefined) {
        duplicateOf = earlier + 1
        duplicateKind = 'xpub'
      } else seenKey.set(canonical, i)
    }
    const fp = row.fingerprint.trim().toLowerCase()
    if (canonical && !duplicateKind && /^[0-9a-f]{8}$/.test(fp) && fp !== '00000000') {
      const earlier = seenFp.get(fp)
      if (earlier !== undefined) {
        duplicateOf = earlier + 1
        duplicateKind = 'fingerprint'
      } else seenFp.set(fp, i)
    }
    const state: SlotInfo['state'] = problem || duplicateKind ? 'problem' : xpub ? 'ready' : 'empty'
    return {
      state,
      problem,
      duplicateOf,
      duplicateKind,
      isMine: !!canonical && ownKeys.some((k) => k.network === network && k.xpub === canonical),
      noFingerprint: state === 'ready' && !fp,
      canonical,
    }
  })
}

/*
  Builds a vault descriptor from scratch, entirely offline — the "coparties in a room
  together" scenario.

  ⚠️ FIXED SIZES (user, 2026-11-11: "we only have our fixed quorum sizes"). The form starts
  with the vault SIZE, picked from VAULT_SIZES (the same list SignBit offers), and that size IS
  the slot count and the threshold. There is no threshold spinner and no add/remove row any
  more: the old free-form version let two keys entered toward an intended three build a valid
  2-of-2, and let the threshold drift from what the room meant. A size smaller than the slots
  already in use is disabled rather than silently dropping someone's key.

  Each slot fills by typing, by importing a key file, or by picking a key already on this
  device, and says live whether it is ready, wrong (in the user's language, the same checks the
  build makes) or a repeat of another slot. "Build and save" is enabled only when every slot is
  ready. The result leads with the CHECKSUM, large, because comparing those 8 characters out
  loud is how a room confirms it built one vault.

  Keys are run through canonicalKeyOrder() (sort by fingerprint, then xpub) before building,
  so any group converges on the identical descriptor regardless of entry order
  (lib/build-descriptor.ts explains why the text, and so the checksum, depends on order).

  ⚠️ EVERY EDIT IS PERSISTED AS A DRAFT (lib/vaults.ts), and the draft is never auto-promoted
  into the saved cache. A draft from before the fixed sizes is fitted to the smallest listed
  size with room for every row in use (fitDraftToVaultSize), and says so.
*/
function BuildVaultForm({
  network,
  ownKeys,
  onAdded,
  onOpenVault,
}: {
  network: NetworkName
  ownKeys: OwnKey[]
  onAdded: (entry: VaultBackup) => void
  /** Open a just-saved vault's own page. */
  onOpenVault: (id: string) => void
}) {
  const { t } = useI18n()
  // Restored ONCE on mount (lazy initializers) rather than in an effect — an effect would
  // render the empty form first and overwrite the draft with it on the very next save.
  const [restored] = useState(() => readVaultDraft())
  const [fitted] = useState(() => (restored ? fitDraftToVaultSize(restored) : null))
  const [label, setLabel] = useState(restored?.label ?? '')
  const [size, setSize] = useState<{ m: number; n: number }>(fitted ? { m: fitted.m, n: fitted.n } : { m: 2, n: 3 })
  const [rows, setRows] = useState<BuildKeyRow[]>(() => fitted?.keys ?? fitRowsToSize([], 3))
  const [error, setError] = useState<string | null>(null)
  // A resized draft's old descriptor no longer matches its size, so it is not shown.
  const [built, setBuilt] = useState<{ receive: string; change: string } | null>(fitted && !fitted.resized ? restored?.built ?? null : null)
  const [restoredNotice, setRestoredNotice] = useState(restored != null)
  // True when the just-saved descriptor was ALREADY in the cache, so the result can say it is
  // a second copy — it is still saved either way, just under a suffixed label.
  const [savedExisting, setSavedExisting] = useState(false)
  const [savedLabel, setSavedLabel] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)
  // A restored draft opens where it left off: on the result if it was built, on the keys if
  // any were entered, otherwise on the size.
  const [step, setStep] = useState<BuildStep>(() => (built ? 3 : fitted?.keys.some(draftRowInUse) ? 2 : 1))

  function goTo(next: BuildStep) {
    setStep(next)
    window.scrollTo({ top: 0 })
  }

  // Persist on every change. writeVaultDraft clears itself when nothing is worth keeping, so
  // emptying the form is a genuine discard rather than a draft that reappears tomorrow.
  useEffect(() => {
    writeVaultDraft({ label, threshold: size.m, keys: rows, built: built ?? undefined })
  }, [label, size, rows, built])

  // Same predicate the storage layer uses, so "there is a draft to discard" on screen can
  // never disagree with what is actually stored.
  const hasDraftContent = isDraftWorthKeeping({ label, threshold: size.m, keys: rows, savedAt: '' })

  const slots = useMemo(() => readSlots(rows, network, ownKeys), [rows, network, ownKeys])
  const readyCount = slots.filter((s) => s.state === 'ready').length
  const problemCount = slots.filter((s) => s.state === 'problem').length
  const emptyCount = slots.filter((s) => s.state === 'empty').length
  const rowsInUse = rows.filter(draftRowInUse).length
  const canBuild = readyCount === size.n
  // Keys on this device that could fill a slot: same network, not already in another slot.
  const usedKeys = new Set(slots.map((s) => s.canonical).filter(Boolean))
  const deviceKeys = ownKeys.filter((k) => k.network === network && !usedKeys.has(k.xpub))

  function updateRow(id: string, patch: Partial<BuildKeyRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setBuilt(null)
    setSavedExisting(false)
    setSavedId(null)
  }

  function chooseSize(next: { m: number; n: number }) {
    if (next.n < rowsInUse) return // the tile is disabled; never drop a slot in use
    setSize({ m: next.m, n: next.n })
    setRows((prev) => fitRowsToSize(prev, next.n))
    setBuilt(null)
    setSavedExisting(false)
  }

  function fillFromDeviceKey(rowId: string, keyId: string) {
    const key = ownKeys.find((k) => k.id === keyId)
    if (!key) return
    const current = rows.find((r) => r.id === rowId)
    updateRow(rowId, {
      xpub: key.xpub,
      fingerprint: key.fingerprint,
      ...(current?.label.trim() ? {} : { label: key.label }),
    })
  }

  /*
    Fill one key row from an exported `signbit-key-*.json` file instead of transcribing it.

    ⚠️ THIS IS THE STEP THE BUILDER EXISTS TO DE-RISK. Reading an extended public key out loud
    and typing it in is the highest-error action in the whole offline flow, and a single wrong
    character produces a descriptor that validates, saves, derives plausible addresses, and
    turns out at spend time to be a vault nobody can sign for. A file carries the same three
    fields exactly.

    ⚠️ A key file is refused when its network is not the one this form is building at. The
    parser re-derives that from the key's own PATH (never the file's `network` field), so this
    compares two facts rather than two claims. Mixing coin types in one descriptor is not a
    vault anyone can spend from, and the failure would surface far from here.

    ⚠️ The label only fills an EMPTY label. Someone who has already named this row ("Alice's
    laptop") means that name; the file's label is whatever the exporting device happened to
    call the key, and overwriting is a silent edit of a field the user already set.
  */
  async function importKeyFile(rowId: string) {
    setError(null)
    const res = await readTextFile({
      accept: '.json,application/json',
      tooLargeMessage: t('vaults.errorFileTooLarge'),
      readErrorMessage: t('vaults.errorReadFile'),
    })
    if (res.status === 'rejected') {
      setError(res.reason)
      return
    }
    if (res.status !== 'ok') return // 'cancelled' → the user closed the picker

    const parsed = parseKeyFile(res.text)
    if (parsed.status === 'error') {
      setError(t(`vaults.keyFileError.${parsed.code}` as `vaults.keyFileError.${KeyFileErrorCode}`))
      return
    }
    if (parsed.key.network !== network) {
      setError(t('vaults.keyFileErrorNetwork', { keyNetwork: parsed.key.network, formNetwork: network }))
      return
    }

    const current = rows.find((r) => r.id === rowId)
    updateRow(rowId, {
      xpub: parsed.key.xpub,
      fingerprint: parsed.key.fingerprint,
      ...(current?.label.trim() ? {} : { label: parsed.key.label }),
    })
  }

  /** Throw the whole draft away — the explicit user action that replaces "navigate away and
   *  hope". Resets to a clean 2 of 3 and removes the stored draft. */
  function discardDraft() {
    setLabel('')
    setSize({ m: 2, n: 3 })
    setRows(fitRowsToSize([], 3))
    setBuilt(null)
    setError(null)
    setRestoredNotice(false)
    setSavedExisting(false)
    clearVaultDraft()
  }

  /*
    ONE action: build the descriptor AND save it.

    ⚠️ The compare step is preserved, but it happens AFTER the save rather than gating it: the
    descriptor is on screen to compare either way, so gating the save on a click bought no extra
    verification — it only created a state where a correct, valuable descriptor existed and was
    not yet stored. A saved backup is a PUBLIC descriptor cache, not an authorization; a
    keyholder who finds a mismatch removes the entry.

    The slots already show every problem live; the checks below are the build's own and stay,
    because a button is not a guard (the localized messages are for this form, the library's
    English throws for every other caller).
  */
  function buildAndSave() {
    setError(null)
    setBuilt(null)
    setRestoredNotice(false)
    setSavedExisting(false)
    const filled = rows.filter((r) => r.xpub.trim())
    if (filled.length < size.n) {
      const missing = size.n - filled.length
      setError(missing === 1 ? t('vaults.buildMissingOne') : t('vaults.buildMissingMany', { count: missing }))
      return
    }
    let result: { receive: string; change: string }
    try {
      // ⚠️ Normalised BEFORE canonicalKeyOrder, which sorts on the xpub string: a Vpub and
      // its tpub would otherwise sort to different positions and print a different descriptor
      // for the same vault.
      const keys = filled.map((r) => ({
        xpub: normalizeXpub(r.xpub, network),
        fingerprint: normalizeFingerprint(r.fingerprint),
      }))
      // 🚨 A key listed twice (in any encoding) would let its holder supply two signatures.
      // The library refuses it too; checked here for the LOCALIZED message, like the majority.
      const repeated = duplicateKey(keys)
      if (repeated) {
        setError(repeated === 'xpub' ? t('vaults.buildErrorDuplicateKey') : t('vaults.buildErrorDuplicateFingerprint'))
        return
      }
      const ordered = canonicalKeyOrder(keys)
      result = buildVaultDescriptor({ m: size.m, keys: ordered, network })
    } catch (e) {
      setError(e instanceof BuildDescriptorError ? e.message : t('vaults.buildErrorGeneric'))
      return
    }
    // Show the descriptor even if the save below fails — it is the thing the room is here to
    // compare, and withholding it because the cache is full would be the wrong trade.
    setBuilt(result)

    const already = findVaultBackupByDescriptor(result.receive) != null
    let entry: VaultBackup
    try {
      entry = addVaultBackup(label, result.receive, result.change, collectKeyLabels())
    } catch (e) {
      // The vault cap (lib/limits.ts) throws here. The draft is left intact so nobody has to
      // re-enter a room's worth of keys to free a slot.
      setError(e instanceof Error ? e.message : t('vaults.buildErrorGeneric'))
      return
    }
    onAdded(entry)
    setSavedExisting(already)
    setSavedLabel(entry.label)
    setSavedId(entry.id)
    // The form is deliberately NOT reset and the draft is NOT cleared: the keys stay on screen
    // so they can be checked against the descriptor that was just saved, and the draft keeps
    // backing them until the user discards.
  }

  /*
    Cosigner names for the built vault, keyed by fingerprint — see VaultKeyLabels.
    ⚠️ Keys with an UNKNOWN fingerprint are skipped, never stored. normalizeFingerprint turns
    a blank one into the placeholder '00000000', so two unnamed-fingerprint keys would both
    claim that slot and one person's name would render against the other's key. A missing
    name falls back to "Signer N", which is honest; a wrong name is not.
  */
  function collectKeyLabels(): Record<string, string> | undefined {
    const labels: Record<string, string> = {}
    for (const row of rows) {
      const name = row.label.trim()
      const fp = row.fingerprint.trim().toLowerCase()
      if (!name || !row.xpub.trim()) continue
      if (!/^[0-9a-f]{8}$/.test(fp) || fp === '00000000') continue
      labels[fp] = name
    }
    return Object.keys(labels).length > 0 ? labels : undefined
  }

  const statusLine = canBuild
    ? null
    : problemCount > 0
      ? t('vaults.buildFixKeys')
      : emptyCount === 1
        ? t('vaults.buildMissingOne')
        : t('vaults.buildMissingMany', { count: emptyCount })

  const steps = [
    { n: 1, title: t('vaults.buildStepSize'), done: step > 1 },
    { n: 2, title: t('vaults.buildStepKeys'), done: canBuild },
    { n: 3, title: t('vaults.buildStepName'), done: !!built },
  ] as const

  return (
    <div className="space-y-5">
      <PageHeading
        title={t('vaults.buildTitle')}
        subtitle={t('vaults.buildSubtitle')}
        aside={<span className={cx(TAG, 'capitalize text-ink-muted')}>{t('vaults.buildNetwork', { network })}</span>}
      />

      {restoredNotice && (
        <Alert kind="warn">
          {t('vaults.draftRestored', { date: new Date(restored?.savedAt ?? Date.now()).toLocaleString() })}
          {fitted?.resized && <> {t('vaults.draftResized', { m: size.m, n: size.n })}</>}
        </Alert>
      )}

      <BuilderSteps steps={steps} current={step} onSelect={goTo} />

      <div key={step} className="card space-y-4 p-4 animate-fade-in sm:p-5">
        {step === 1 && (
          <div role="radiogroup" aria-label={t('vaults.buildStepSize')} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {VAULT_SIZES.map((s) => {
              const selected = s.m === size.m && s.n === size.n
              const tooSmall = s.n < rowsInUse
              return (
                <button
                  key={`${s.m}-${s.n}`}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={tooSmall}
                  title={tooSmall ? t('vaults.sizeTooSmall', { count: rowsInUse }) : undefined}
                  onClick={() => chooseSize(s)}
                  className={cx(
                    'relative flex min-h-[5.25rem] flex-col items-start justify-between gap-2 border px-3 py-2.5 text-left transition-colors duration-200',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                    selected ? 'border-brand-500 bg-surface ring-1 ring-inset ring-brand-500' : 'border-line bg-surface hover:border-ink/40',
                    tooSmall && 'cursor-not-allowed !bg-surface-2 text-ink-muted',
                  )}
                >
                  <QuorumDots m={s.m} n={s.n} active={selected} reserveCorner={s.m === 2 && s.n === 3} />
                  <span className="block">
                    <span className="block text-[15px] font-semibold tabular-nums text-ink">{t('vaults.sizeShort', { m: s.m, n: s.n })}</span>
                    <span className="block text-xs text-ink-muted">{t('vaults.sizeHint', { m: s.m, n: s.n })}</span>
                  </span>
                  {s.m === 2 && s.n === 3 && (
                    <span className="absolute right-2 top-2 text-[11px] font-semibold text-ink-muted">{t('vaults.sizeRecommended')}</span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {step === 2 && (
          <>
            <div className="flex items-center justify-between gap-2 text-[13px] text-ink-muted">
              <span>{t('vaults.sizeShort', { m: size.m, n: size.n })}</span>
              <span className="tabular-nums">{t('vaults.buildKeysProgress', { done: readyCount, total: size.n })}</span>
            </div>
            {/* Progress: one segment per slot, filled as each turns ready. */}
            <div aria-hidden="true" className="flex gap-1">
              {slots.map((s, i) => (
                <span
                  key={rows[i].id}
                  className={cx(
                    'h-1 flex-1 transition-colors duration-300',
                    s.state === 'ready' ? 'bg-emerald-500' : s.state === 'problem' ? 'bg-red-500' : 'bg-line',
                  )}
                />
              ))}
            </div>
            <div className="grid gap-2 xl:grid-cols-2">
              {rows.map((row, i) => (
                <KeySlot
                  key={row.id}
                  index={i}
                  row={row}
                  info={slots[i]}
                  network={network}
                  deviceKeys={deviceKeys}
                  onChange={(patch) => updateRow(row.id, patch)}
                  onClear={() => updateRow(row.id, { xpub: '', fingerprint: '', label: '' })}
                  onImportFile={() => void importKeyFile(row.id)}
                  onUseDeviceKey={(keyId) => fillFromDeviceKey(row.id, keyId)}
                />
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <Label>{t('vaults.label')}</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('vaults.labelPlaceholder')} />
            </div>
            <p className="text-sm text-ink">{t('vaults.buildSummary', { m: size.m, n: size.n })}</p>
            {statusLine && (
              <p className="text-[13px] text-ink-muted">
                {statusLine}{' '}
                <button type="button" onClick={() => goTo(2)} className={cx(TEXT_ACTION, 'min-h-0 font-semibold text-ink')}>
                  {t('vaults.buildStepKeys')}
                </button>
              </p>
            )}
            <div>
              <Button onClick={buildAndSave} disabled={!canBuild}>
                {t('vaults.buildAction')}
              </Button>
            </div>
            {built && (
              <BuildResult
                built={built}
                label={savedLabel || label}
                network={network}
                savedExisting={savedExisting}
                onOpenVault={savedId ? () => onOpenVault(savedId) : undefined}
              />
            )}
          </>
        )}
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {/* Back / Next, and the draft's discard, in one bar under every step. */}
      <div className="flex flex-wrap items-center gap-2">
        {step > 1 && (
          <Button variant="secondary" onClick={() => goTo((step - 1) as BuildStep)}>
            <ChevronLeftIcon className="h-4 w-4" />
            {t('vaults.buildBack')}
          </Button>
        )}
        {step < 3 && (
          <Button onClick={() => goTo((step + 1) as BuildStep)}>
            {t('vaults.buildNext')}
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        )}
        {hasDraftContent && (
          <Button variant="ghost" className="ml-auto" onClick={discardDraft}>
            {t('vaults.draftDiscard')}
          </Button>
        )}
      </div>

      {/* The draft is saved continuously, so say so plainly rather than leaving the user to
          guess whether leaving this screen costs them their transcription. */}
      {hasDraftContent && <p className="text-xs text-ink-muted">{t('vaults.draftKept')}</p>}
    </div>
  )
}

type BuildStep = 1 | 2 | 3

/*
  The builder's three steps as one numbered bar (2026-11-11, replacing three stacked sections):
  only the current step's content is on screen, so an 8 of 15 vault's fifteen key slots are the
  whole page on step 2 instead of the middle of a very long one. Every step can be opened
  directly; the bar shows a tick on each one that is done.
*/
function BuilderSteps({
  steps,
  current,
  onSelect,
}: {
  steps: readonly { n: number; title: string; done: boolean }[]
  current: number
  onSelect: (n: BuildStep) => void
}) {
  return (
    <ol className="grid grid-cols-3 border-b border-line">
      {steps.map((s) => {
        const active = s.n === current
        return (
          <li key={s.n} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(s.n as BuildStep)}
              aria-current={active ? 'step' : undefined}
              className={cx(
                '-mb-px flex min-h-12 w-full items-center gap-2 border-b-2 px-1 py-2 text-left transition-colors sm:px-2',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
                active ? 'border-brand-500 text-ink' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'flex h-6 w-6 shrink-0 items-center justify-center border text-xs font-semibold tabular-nums transition-colors duration-300',
                  s.done ? 'border-ink bg-ink text-surface' : active ? 'border-ink text-ink' : 'border-line',
                )}
              >
                {s.done ? <CheckIcon className="h-3.5 w-3.5 animate-pop" /> : s.n}
              </span>
              <span className="min-w-0 text-[13px] font-semibold leading-tight sm:text-sm">{s.title}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/* The size tile's picture: one square per key, the ones needed to sign filled. Filled squares
   light up one after another when the tile is picked (a CSS transition, so reduced motion and
   the app's own Animations: Off stop it). */
function QuorumDots({ m, n, active, reserveCorner }: { m: number; n: number; active: boolean; reserveCorner?: boolean }) {
  return (
    <span aria-hidden="true" className={cx('flex max-w-full flex-wrap gap-[3px]', reserveCorner && 'pr-20')}>
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          style={{ transitionDelay: active ? `${i * 30}ms` : '0ms' }}
          className={cx(
            'h-1.5 w-1.5 transition-colors duration-300',
            i < m ? (active ? 'bg-brand-500' : 'bg-ink/70') : 'border border-ink-muted/60',
          )}
        />
      ))}
    </span>
  )
}

/* One key slot: number and name, a live status, the three fields, and the two shortcuts (a key
   already on this device, or a key file). */
function KeySlot({
  index,
  row,
  info,
  network,
  deviceKeys,
  onChange,
  onClear,
  onImportFile,
  onUseDeviceKey,
}: {
  index: number
  row: BuildKeyRow
  info: SlotInfo
  network: NetworkName
  deviceKeys: OwnKey[]
  onChange: (patch: Partial<BuildKeyRow>) => void
  onClear: () => void
  onImportFile: () => void
  onUseDeviceKey: (keyId: string) => void
}) {
  const { t } = useI18n()
  const inUse = draftRowInUse(row)
  const expected = EXPECTED_PREFIXES[network]
  const message =
    info.problem != null
      ? t(`vaults.slotProblem.${info.problem}` as `vaults.slotProblem.${KeyInputProblem}`, { expected, network })
      : info.duplicateKind === 'xpub'
        ? t('vaults.slotDuplicate', { n: info.duplicateOf ?? 0 })
        : info.duplicateKind === 'fingerprint'
          ? t('vaults.slotDuplicateFingerprint', { n: info.duplicateOf ?? 0 })
          : null

  return (
    <div
      className={cx(
        'border border-l-2 bg-surface transition-colors duration-300',
        info.state === 'ready' ? 'border-line border-l-emerald-500' : info.state === 'problem' ? 'border-line border-l-red-500' : 'border-line',
      )}
    >
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5">
        <span className="text-[13px] font-semibold tabular-nums text-ink">{t('vaults.buildKeyN', { n: index + 1 })}</span>
        {row.label.trim() && <span className="min-w-0 truncate text-[13px] text-ink-muted">{row.label.trim()}</span>}
        {info.state === 'ready' && (
          <span className={cx(TAG, 'text-emerald-700 animate-scale-in dark:text-emerald-300')}>
            <CheckIcon className="h-3 w-3" />
            {t('vaults.slotReady')}
          </span>
        )}
        {info.state === 'problem' && (
          <span className={cx(TAG, 'text-red-700 animate-scale-in dark:text-red-300')}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {t('vaults.slotCheck')}
          </span>
        )}
        {info.isMine && (
          <span className={cx(TAG, 'text-ink')}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            {t('vaults.summaryThisDevice')}
          </span>
        )}
        {inUse && (
          <button
            type="button"
            onClick={onClear}
            className="-mr-2 ml-auto inline-flex min-h-11 items-center px-2 text-[13px] text-ink-muted transition-colors hover:text-red-600 dark:hover:text-red-400"
          >
            {t('vaults.slotClear')}
          </button>
        )}
      </div>
      <div className="space-y-2.5 p-3">
        <div>
          <Label>{t('vaults.buildKeyName')}</Label>
          <Input value={row.label} onChange={(e) => onChange({ label: e.target.value })} placeholder={t('vaults.buildKeyLabelPlaceholder')} />
        </div>
        <div>
          <Label>{t('vaults.buildKeyXpub')}</Label>
          <Input
            value={row.xpub}
            onChange={(e) => onChange({ xpub: e.target.value })}
            placeholder={t('vaults.buildKeyXpubPlaceholder')}
            aria-invalid={info.problem != null && info.problem !== 'bad_fingerprint' ? true : undefined}
            className="font-mono"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div>
          <Label>{t('vaults.summaryFingerprint')}</Label>
          <Input
            value={row.fingerprint}
            onChange={(e) => onChange({ fingerprint: e.target.value })}
            placeholder={t('vaults.buildKeyFingerprintPlaceholder')}
            aria-invalid={info.problem === 'bad_fingerprint' ? true : undefined}
            className="font-mono sm:max-w-[14rem]"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        {message && (
          <p role="alert" className="text-[13px] text-red-700 dark:text-red-300">
            {message}
          </p>
        )}
        {info.noFingerprint && <p className="text-[13px] text-ink-muted">{t('vaults.slotNoFingerprint')}</p>}
        {/* The shortcuts sit UNDER the fields: typing stays the primary path (most keyholders
            are reading a key off another person's screen). A device key is offered only while
            the slot has no key, so picking one can never overwrite a key someone typed. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {!row.xpub.trim() && deviceKeys.length > 0 && (
            <select
              value=""
              onChange={(e) => e.target.value && onUseDeviceKey(e.target.value)}
              aria-label={t('vaults.useDeviceKey')}
              className="min-h-11 max-w-full border border-line bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20 sm:min-h-9"
            >
              <option value="">{t('vaults.useDeviceKey')}</option>
              {deviceKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} ({k.fingerprint})
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={onImportFile} className={TEXT_ACTION}>
            {t('vaults.buildKeyImportFile')}
          </button>
        </div>
      </div>
    </div>
  )
}

/*
  What the room sees after "Build and save": the checksum LARGE (the one thing to read out and
  compare), the first receive address (to check against any other wallet), the backup file,
  and the full descriptors one tap away.
*/
function BuildResult({
  built,
  label,
  network,
  savedExisting,
  onOpenVault,
}: {
  built: { receive: string; change: string }
  label: string
  network: NetworkName
  savedExisting: boolean
  /** Absent when the result is a restored draft's, with no saved entry known to this page. */
  onOpenVault?: () => void
}) {
  const { t } = useI18n()
  const [showRaw, setShowRaw] = useState(false)
  const checksum = built.receive.split('#')[1] ?? ''
  let firstAddress = ''
  try {
    firstAddress = deriveAddress(built.receive, 0, network)
  } catch {
    /* the descriptor came out of buildVaultDescriptor; an address that will not derive is not
       worth blocking the rest of the result over */
  }

  return (
    <div className="space-y-3 animate-fade-in-up">
      <Alert kind="ok">{savedExisting ? t('vaults.buildSavedCopy', { label }) : t('vaults.buildSavedCompare')}</Alert>
      <section className="border border-line border-t-2 border-t-brand-500 bg-surface px-4 py-5 text-center">
        <p className="text-[13px] text-ink-muted">{t('vaults.buildChecksumLabel')}</p>
        {/* Two groups of four, letters arriving one after another: easy to read out in halves. */}
        <p className="mt-1.5 font-mono text-3xl font-semibold tracking-[0.14em] text-ink sm:text-4xl" aria-label={checksum}>
          {checksum.split('').map((ch, i) => (
            <span key={i} aria-hidden="true" style={{ animationDelay: `${120 + i * 45}ms` }} className={cx('inline-block animate-fade-in-up', i === 4 && 'ml-3')}>
              {ch}
            </span>
          ))}
        </p>
        <p className="mx-auto mt-2 max-w-sm text-[13px] text-ink-muted">{t('vaults.buildChecksumHint')}</p>
      </section>
      {firstAddress && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <Label>{t('vaults.preview.firstAddress')}</Label>
            <CopyButton value={firstAddress} />
          </div>
          <Mono className={RAW_BLOCK}>{firstAddress}</Mono>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SaveFileButton entry={{ label, descriptor: built.receive, changeDescriptor: built.change }} />
        {onOpenVault && (
          <Button variant="secondary" onClick={onOpenVault}>
            {t('vaults.openSaved')}
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        )}
        <button type="button" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw} className={TEXT_ACTION}>
          {showRaw ? t('vaults.hideRawDescriptor') : t('vaults.showRawDescriptor')}
        </button>
      </div>
      {showRaw && (
        <div className="space-y-3 animate-fade-in">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Label>{t('vaults.summaryReceiveBranch')}</Label>
              <CopyButton value={built.receive} />
            </div>
            <Mono className={RAW_BLOCK}>{built.receive}</Mono>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Label>{t('vaults.summaryChangeBranch')}</Label>
              <CopyButton value={built.change} />
            </div>
            <Mono className={RAW_BLOCK}>{built.change}</Mono>
          </div>
        </div>
      )}
    </div>
  )
}

/*
  The keys held on THIS device, public parts only, so the builder can offer them and a vault
  can mark which cosigner is you. Derived from the unlocked keystore the same way
  backup-diff.ts does it (accountKey → masterFingerprint), lowercased to match
  parseDescriptorSummary's output, at each key's OWN network (networkOf), never the toggle.

  ⚠️ A master fingerprint is IDENTICAL across networks for the same seed, so a key stamped
  testnet still matches a mainnet descriptor's fingerprint. That is fine for the "this device"
  HINT, but it is exactly why identity matching must never use the fingerprint to tell networks
  apart — and why the builder matches on the full extended key AND the network.

  BIP-32 per key, so this is memoized once at the screen and passed down.
*/
function useOwnKeys(entries: KeyEntry[]): OwnKey[] {
  return useMemo(() => {
    const out: OwnKey[] = []
    for (const e of entries) {
      try {
        const net = networkOf(e)
        const pub = accountKey(e.mnemonic, net)
        out.push({ id: e.id, label: e.label, xpub: pub.tpub, fingerprint: pub.masterFingerprint.toLowerCase(), network: net })
      } catch {
        // A key we can't derive simply goes unoffered and unmarked — never break the screen.
      }
    }
    return out
  }, [entries])
}

/*
  One cosigner row on a vault card: their name (editable), whether the key is this device's,
  the fingerprint, and the truncated xpub — the last two both copyable.

  ⚠️ The name is looked up and written BY FINGERPRINT, never by row position:
  canonicalKeyOrder sorts keys before the descriptor is built, so descriptor order is not the
  order anyone typed them in. Naming by index would attach one person's name to another's key.

  Editing is deliberately allowed even though addVaultBackup's automatic path is add-only —
  that rule stops a repeat SAVE silently rewriting names; this is a person correcting a typo,
  which is the whole reason the field is worth having. Clearing the name falls back to
  "Signer N" rather than rendering an empty row.
*/
function SignerRow({
  entryId,
  sk,
  index,
  name,
  isMine,
  onUpdated,
}: {
  entryId: string
  sk: NonNullable<ReturnType<typeof parseDescriptorSummary>>['keys'][number]
  index: number
  name?: string
  isMine: boolean
  onUpdated: (updated: VaultBackup) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name ?? '')
  const [err, setErr] = useState<string | null>(null)

  function start() {
    setDraft(name ?? '')
    setErr(null)
    setEditing(true)
  }
  function save() {
    try {
      onUpdated(setVaultKeyLabel(entryId, sk.fingerprint, draft))
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-1.5">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') setEditing(false)
              }}
              placeholder={t('vaults.buildKeyLabelPlaceholder')}
              className="py-1.5 text-sm"
            />
            {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
            <div className="flex gap-2">
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={save}>
                {t('vaults.renameSave')}
              </Button>
              <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setEditing(false)}>
                {t('vaults.renameCancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cx('break-words font-medium', name ? 'text-ink' : 'text-ink-muted')}>
              {name || t('vaults.summarySigner', { index: index + 1 })}
            </span>
            {/* A square neutral tag with an orange dot: the device's own key is the one thing on
                this list worth marking, but not with a tinted fill. */}
            {isMine && (
              <span className={cx(TAG, 'text-ink')}>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                {t('vaults.summaryThisDevice')}
              </span>
            )}
            <button
              type="button"
              onClick={start}
              aria-label={t('vaults.nameSigner')}
              title={t('vaults.nameSigner')}
              className="-m-2 shrink-0 p-2 text-ink-muted transition-colors hover:text-ink"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* Both values are copyable: a truncated xpub is useless to paste into another tool,
            and re-typing a fingerprint by eye is how a wrong key gets enrolled. Public data,
            so there is nothing to withhold. */}
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="font-mono text-xs uppercase tracking-wide tabular-nums text-ink-muted">
            {t('vaults.summaryFingerprint')}: {sk.fingerprint}
          </span>
          <CopyInline value={sk.fingerprint} label={t('vaults.copyFingerprint')} />
        </div>
      </div>
      <div className="flex items-center gap-1.5 sm:shrink-0">
        <Mono className="text-ink-muted">{sk.xpubShort}</Mono>
        <CopyInline value={sk.xpub} label={t('vaults.copyXpub')} />
      </div>
    </li>
  )
}

function VaultRow({
  entry,
  ownFingerprints,
  onOpen,
  delayMs = 0,
}: {
  entry: VaultBackup
  ownFingerprints: Set<string>
  onOpen: () => void
  /** Stagger for the row's entrance fade (the list passes 60ms per row). */
  delayMs?: number
}) {
  const { t } = useI18n()
  const summary = parseDescriptorSummary(entry.descriptor)
  const mine = summary?.keys.some((k) => ownFingerprints.has(k.fingerprint)) ?? false
  return (
    <li style={{ animationDelay: `${delayMs}ms` }} className="animate-fade-in-up">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 sm:px-5"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-line text-ink-muted">
          <VaultGlyph className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          {/* Full label, wrapped (not truncated): the name is the whole point of the row. */}
          <span className="block break-words text-[15px] font-semibold tracking-[-0.01em] text-ink">{entry.label}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-muted">
            <span>{t('vaults.savedOn', { date: new Date(entry.savedAt).toLocaleDateString() })}</span>
            {summary && (
              <span className={cx(TAG, 'tabular-nums text-ink')}>
                {t('vaults.summaryQuorum', { threshold: summary.threshold, total: summary.total })}
              </span>
            )}
            {mine && <span className={cx(TAG, 'text-ink-muted')}>{t('vaults.summaryThisDevice')}</span>}
          </span>
        </span>
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-muted" />
      </button>
    </li>
  )
}

type VaultTab = 'keys' | 'addresses' | 'descriptor'

/*
  One saved vault, as a page of its own (2026-11-11): the account header (name, rename, size,
  Remove), the facts strip, then its sections as TABS instead of panels stacked one under
  another, each of which used to open and close on its own.
  - Keys: the cosigners, named and copyable.
  - Addresses: derive any receive or change address, open straight away (it used to sit
    behind a toggle).
  - Descriptor: both descriptors in full, copyable, the backup file, and the change-descriptor
    fill when it is missing.
  A descriptor that does not parse into the platform's shape has no key list, so it opens on
  Descriptor and has no Keys tab.
*/
function VaultPage({
  entry,
  notice,
  ownFingerprints,
  onRemove,
  onUpdated,
}: {
  entry: VaultBackup
  /** A one-time "saved" message from the paste page that opened this one. */
  notice?: string
  ownFingerprints: Set<string>
  onRemove: () => void
  /** This entry changed in storage — rename, a cosigner name, or a filled-in change
   *  descriptor. One callback for all of them: the screen just swaps the entry it holds. */
  onUpdated: (updated: VaultBackup) => void
}) {
  const { t } = useI18n()
  const [renaming, setRenaming] = useState(false)
  const [labelDraft, setLabelDraft] = useState(entry.label)
  const summary = parseDescriptorSummary(entry.descriptor)
  const [tab, setTab] = useState<VaultTab>(summary ? 'keys' : 'descriptor')
  // Display only, all derived from the descriptor; the network comes from the descriptor's
  // own key prefix, not the app's current toggle.
  const facts = useSummaryFacts(summary, entry.descriptor)

  function startRename() {
    setLabelDraft(entry.label)
    setRenaming(true)
  }
  function saveRename() {
    onUpdated(renameVaultBackup(entry.id, labelDraft))
    setRenaming(false)
  }

  const tabs: { id: VaultTab; label: string }[] = [
    ...(summary ? [{ id: 'keys' as const, label: t('vaults.tabKeys') }] : []),
    { id: 'addresses', label: t('vaults.tabAddresses') },
    { id: 'descriptor', label: t('vaults.tabDescriptor') },
  ]

  return (
    <div className="space-y-4">
      {notice && <Alert kind="ok">{notice}</Alert>}

      <section className="card relative overflow-hidden">
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-brand-500" />
        <div className="flex items-start gap-3 px-4 py-4 sm:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-line text-ink-muted">
            <VaultGlyph className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            {/* The label is a local nickname with no cryptographic meaning, so it is freely
                editable. The DESCRIPTOR is the vault's identity and is not editable anywhere. */}
            {renaming ? (
              <div className="space-y-1.5">
                <Input
                  autoFocus
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveRename()
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                  className="py-1.5 text-sm"
                />
                <div className="flex gap-2">
                  <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={saveRename}>
                    {t('vaults.renameSave')}
                  </Button>
                  <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setRenaming(false)}>
                    {t('vaults.renameCancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <h2 className="break-words text-xl font-semibold tracking-[-0.02em] text-ink">{entry.label}</h2>
                <button
                  type="button"
                  onClick={startRename}
                  aria-label={t('vaults.rename')}
                  title={t('vaults.rename')}
                  className="-m-2 shrink-0 p-2 text-ink-muted transition-colors hover:text-ink"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-muted">
              <span>{t('vaults.savedOn', { date: new Date(entry.savedAt).toLocaleDateString() })}</span>
              {summary && (
                <span className={cx(TAG, 'tabular-nums text-ink')}>
                  {t('vaults.summaryQuorum', { threshold: summary.threshold, total: summary.total })}
                </span>
              )}
            </div>
          </div>
          <Button variant="ghost" className="-my-1 -mr-2 min-h-11 shrink-0 px-3 py-0 text-[13px]" onClick={onRemove}>
            {t('vaults.remove')}
          </Button>
        </div>
        {summary && <FactsStrip facts={facts} />}
      </section>

      <TabRow tabs={tabs} value={tab} onChange={setTab} label={entry.label} />

      <div key={tab} className="animate-fade-in">
        {tab === 'keys' && summary && (
          <section className="card overflow-hidden">
            <ul className="divide-y divide-line">
              {summary.keys.map((k, i) => (
                <SignerRow
                  key={k.fingerprint + i}
                  entryId={entry.id}
                  sk={k}
                  index={i}
                  name={entry.keyLabels?.[k.fingerprint]}
                  isMine={ownFingerprints.has(k.fingerprint)}
                  onUpdated={onUpdated}
                />
              ))}
            </ul>
          </section>
        )}

        {tab === 'addresses' && (
          <section className="card overflow-hidden">
            <DeriveAddressForm entry={entry} />
          </section>
        )}

        {tab === 'descriptor' && (
          <section className="card divide-y divide-line overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
              <p className="min-w-0 flex-1 text-[13px] text-ink-muted">{t('vaults.rawDescriptorNote')}</p>
              {/* The whole vault as a file, in the platform's own backup layout, for a USB stick
                  or the other keyholders. */}
              <SaveFileButton entry={entry} />
            </div>
            <div className="px-4 py-3 sm:px-5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <Label>{t('vaults.summaryReceiveBranch')}</Label>
                <CopyButton value={entry.descriptor} />
              </div>
              {summary ? (
                <Mono className={RAW_BLOCK}>{entry.descriptor}</Mono>
              ) : (
                <Alert kind="warn">
                  <Mono className="block break-all">{entry.descriptor}</Mono>
                </Alert>
              )}
            </div>
            <div className="px-4 py-3 sm:px-5">
              {entry.changeDescriptor ? (
                <>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <Label>{t('vaults.summaryChangeBranch')}</Label>
                    <CopyButton value={entry.changeDescriptor} />
                  </div>
                  <Mono className={RAW_BLOCK}>{entry.changeDescriptor}</Mono>
                </>
              ) : (
                <>
                  <Label>{t('vaults.summaryChangeBranch')}</Label>
                  <AddChangeDescriptorForm entry={entry} onAdded={onUpdated} />
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/*
  Derive the actual receive/change address at a chosen index from this saved descriptor —
  entirely offline, public data only. Lets a keyholder independently verify an address the
  platform shows them (compare the same index side-by-side) or reconstruct one for a third-party tool,
  without any network call — the "verify, don't trust" property this whole cache exists for.
  Network is sniffed from the descriptor's own xpub/tpub prefix (lib/vaults.ts
  sniffDescriptorNetwork), not the app's current global network toggle, since a saved backup
  may be from a different network than whatever the app happens to be set to right now.

  LIVE (no button): derivation is pure/instant, so recomputing on every branch/index change
  is free — a manual "Derive" click only added friction for no benefit. The last-viewed
  branch/index is persisted per vault (lib/vaults.ts saveLastDerived) so reopening the app
  resumes where you left off instead of resetting to #0 every time.
*/
function DeriveAddressForm({ entry }: { entry: VaultBackup }) {
  const { t } = useI18n()
  const [branch, setBranch] = useState<'receive' | 'change'>(entry.lastDerived?.branch ?? 'receive')
  const [index, setIndex] = useState(entry.lastDerived?.index ?? 0)

  const descriptor = branch === 'change' ? entry.changeDescriptor : entry.descriptor
  let address: string | null = null
  let error: string | null = null
  if (!descriptor) {
    error = t('vaults.deriveErrorNoChangeDescriptor')
  } else {
    try {
      address = deriveAddress(descriptor, index, sniffDescriptorNetwork(entry.descriptor))
    } catch {
      error = t('vaults.deriveErrorGeneric')
    }
  }

  function setBranchAndPersist(b: 'receive' | 'change') {
    setBranch(b)
    saveLastDerived(entry.id, b, index)
  }
  function setIndexAndPersist(i: number) {
    const clamped = Math.max(0, i)
    setIndex(clamped)
    saveLastDerived(entry.id, branch, clamped)
  }

  return (
    <div className="space-y-3 px-4 py-4 sm:px-5">
      <p className="text-[13px] text-ink-muted">{t('vaults.deriveSubtitle')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex border-b border-line">
          {(['receive', 'change'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBranchAndPersist(b)}
              className={cx(
                '-mb-px min-h-11 border-b-2 px-3 text-[13px] font-semibold transition-colors sm:min-h-9',
                branch === b ? 'border-brand-500 text-ink' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {b === 'receive' ? t('vaults.deriveBranchReceive') : t('vaults.deriveBranchChange')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIndexAndPersist(index - 1)}
            disabled={index <= 0}
            aria-label={t('vaults.derivePrevIndex')}
            className="flex h-11 w-11 items-center justify-center border border-line bg-surface-2 text-ink-muted transition-colors hover:border-ink/40 hover:text-ink active:translate-y-px disabled:pointer-events-none disabled:opacity-40 sm:h-9 sm:w-9"
          >
            ‹
          </button>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={index}
            onChange={(e) => setIndexAndPersist(Number(e.target.value) || 0)}
            className="w-16 text-center tabular-nums"
            aria-label={t('vaults.deriveIndexLabel')}
          />
          <button
            type="button"
            onClick={() => setIndexAndPersist(index + 1)}
            aria-label={t('vaults.deriveNextIndex')}
            className="flex h-11 w-11 items-center justify-center border border-line bg-surface-2 text-ink-muted transition-colors hover:border-ink/40 hover:text-ink active:translate-y-px sm:h-9 sm:w-9"
          >
            ›
          </button>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {address && (
        <div className="animate-fade-in">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <Label>
              {t('vaults.deriveResultLabel', {
                branch: branch === 'receive' ? t('vaults.deriveBranchReceive') : t('vaults.deriveBranchChange'),
                index,
              })}
            </Label>
            <CopyButton value={address} />
          </div>
          <Mono className={RAW_BLOCK}>{address}</Mono>
          <p className="mt-1.5 text-[13px] text-ink-muted">{t('vaults.deriveCompareHint')}</p>
        </div>
      )}
    </div>
  )
}

/*
  Shown on a saved vault backup that has no change descriptor yet — the common case for any
  backup saved before the platform's vault page exposed one to copy (or where the user only pasted
  the receive descriptor). ADD-ONLY: lib/vaults.ts's addMissingChangeDescriptor refuses to
  overwrite an existing one, so there's no "edit" path here — a wrong/replacement descriptor
  means removing this backup and adding it again from scratch.
*/
function AddChangeDescriptorForm({ entry, onAdded }: { entry: VaultBackup; onAdded: (updated: VaultBackup) => void }) {
  const { t } = useI18n()
  const problemText = useInputProblemText()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  /*
    The change descriptor this vault's receive descriptor implies (same keys, branch /1/*),
    when its shape allows it. Offered as ONE TAP (2026-11-11): every backup saved before the
    platform exposed the change line used to need a trip back to the platform for it, which is
    the one place a keyholder who can't reach us cannot go.
  */
  const derived = useMemo(() => {
    try {
      return changeDescriptorFor(entry.descriptor)
    } catch {
      return null
    }
  }, [entry.descriptor])

  function store(changeDescriptor: string) {
    try {
      onAdded(addMissingChangeDescriptor(entry.id, changeDescriptor))
      setOpen(false)
      setValue('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function submit() {
    setError(null)
    if (!value.trim()) {
      setError(t('vaults.errorRequired'))
      return
    }
    /*
      ⚠️ A pasted change descriptor must belong to THIS vault. It decides which outputs the Sign
      screen calls "change", and the old form stored whatever was pasted. readVaultInput checks
      the pair; only when the saved RECEIVE descriptor itself will not read (a row from an old
      build) is the paste kept as given, as before, and the Sign screen's own check still fails
      closed on it.
    */
    const check = readVaultInput(entry.descriptor, value)
    if (!check.ok && (check.problem === 'change_mismatch' || check.problem === 'change_invalid' || check.problem === 'private_key')) {
      setError(problemText(check.problem))
      return
    }
    store(check.ok && check.value.changeDescriptor ? check.value.changeDescriptor : value.trim())
  }

  if (!open) {
    return (
      <div className="space-y-1 py-2">
        {derived && <p className="text-[13px] text-ink-muted">{t('vaults.addChangeDescriptorHint')}</p>}
        <div className="flex flex-wrap items-center gap-x-4">
          {derived && (
            <button type="button" onClick={() => store(derived)} className={cx(TEXT_ACTION, 'font-semibold text-ink')}>
              {t('vaults.changeAutoFill')}
            </button>
          )}
          <button type="button" onClick={() => setOpen(true)} className={TEXT_ACTION}>
            {t('vaults.addChangeDescriptor')}
          </button>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
      </div>
    )
  }

  return (
    <div className="space-y-2 py-2 animate-fade-in">
      <p className="text-[13px] text-ink-muted">{t('vaults.addChangeDescriptorPasteHint')}</p>
      <Textarea
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('vaults.changeDescriptorPlaceholder')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <Button className="px-2.5 py-1.5 text-xs" onClick={submit} disabled={!value.trim()}>
          {t('vaults.addChangeDescriptorSave')}
        </Button>
        <Button
          variant="ghost"
          className="px-2.5 py-1.5 text-xs"
          onClick={() => {
            setOpen(false)
            setValue('')
            setError(null)
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}

// 10s cool-off + type-to-confirm before a backup can be removed — guards a host-level
// attacker at an unattended unlocked device from clearing a backup in one reflexive click.
// Mirrors KeysScreen's RemoveKeyModal (30s there, since a key removal is higher-stakes).
const REMOVE_VAULT_COUNTDOWN_SECS = 10

function RemoveVaultModal({
  entry,
  onConfirm,
  onClose,
}: {
  entry: VaultBackup
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [typed, setTyped] = useState('')
  const matches = typed.trim().toLowerCase() === entry.label.trim().toLowerCase()
  const removeSummary = parseDescriptorSummary(entry.descriptor)

  const [countdown, setCountdown] = useState(REMOVE_VAULT_COUNTDOWN_SECS)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setCountdown((s) => {
        if (s <= 1) {
          if (timerRef.current) clearInterval(timerRef.current)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])
  const armed = matches && countdown === 0

  function submit(e: FormEvent) {
    e.preventDefault()
    if (armed) onConfirm()
  }

  return (
    <Modal open onClose={onClose} title={t('vaults.removeModalTitle')}>
      <form onSubmit={submit} className="space-y-4">
        <Alert kind="warn">{t('vaults.removeWarning', { label: entry.label })}</Alert>
        {/* ⚠️ The LABEL does not identify a vault — it is a local nickname, and two vaults may
            share one. The quorum + descriptor checksum are what distinguish them, so they are
            shown here: this is the last screen before an irreversible delete, and "am I
            removing the right one?" must be answerable without cancelling out to check. */}
        {removeSummary && (
          <div className="flex flex-wrap items-center gap-2 border border-line bg-surface px-3 py-2">
            <span className={cx(TAG, 'tabular-nums text-ink')}>
              {t('vaults.summaryQuorum', { threshold: removeSummary.threshold, total: removeSummary.total })}
            </span>
            <span className="font-mono text-xs text-ink-muted">
              {t('vaults.summaryChecksum')}: {removeSummary.checksum}
            </span>
          </div>
        )}
        <div>
          <Label>{t('vaults.removeConfirmLabel')}</Label>
          {/* Echo the exact string to type in its TRUE case (matching is case-insensitive, but an
              uppercased echo next to the natural-case placeholder read as two different values). */}
          <div className="mb-1.5 font-mono text-xs text-ink">
            {entry.label}
          </div>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={entry.label}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="danger" disabled={!armed}>
            {countdown > 0 ? t('vaults.removeConfirmCountdown', { seconds: countdown }) : t('vaults.removeConfirm')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('vaults.cancel')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
