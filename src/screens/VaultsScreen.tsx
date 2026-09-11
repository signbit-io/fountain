import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Card, CollapsibleCard, Input, Label, Textarea, Alert, Mono, CopyButton, CopyInline, Modal } from '../components/ui'
import { useI18n } from '../i18n'
import {
  readVaultBackups,
  addVaultBackup,
  addMissingChangeDescriptor,
  removeVaultBackup,
  parseVaultBackupFile,
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
  type VaultBackup,
} from '../lib/vaults'
import { buildVaultDescriptor, canonicalKeyOrder, validateXpub, normalizeFingerprint, deriveAddress, defaultThreshold, minMajorityThreshold, isNoRedundancyQuorum, BuildDescriptorError } from '../lib/build-descriptor'
import type { NetworkName } from '../lib/bitcoin-network'
import { readTextFile } from '../lib/download'
import { parseKeyFile, type KeyFileErrorCode } from '../lib/key-file'
import { useKeystore } from '../lib/keystore'
import { accountKey, networkOf } from '../lib/key'
import type { KeyEntry } from '../lib/crypto'

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

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
*/
export function VaultsScreen({ network }: { network: NetworkName }) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<VaultBackup[]>(() => readVaultBackups())
  const [removing, setRemoving] = useState<VaultBackup | null>(null)
  const [addMode, setAddMode] = useState<'paste' | 'build'>('paste')
  const { entries: keyEntries } = useKeystore()
  const ownFingerprints = useOwnFingerprints(keyEntries)

  return (
    <div className="space-y-6">
      <CollapsibleCard
        storageKey="vaults.add"
        title={
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{t('vaults.title')}</h2>
            <span className="border border-line px-1.5 py-0.5 font-mono text-xs text-ink-muted">
              {entries.length}
            </span>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{t('vaults.subtitle')}</p>

          <div className="flex border-b border-line">
            {(['paste', 'build'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setAddMode(mode)}
                className={cx(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  addMode === mode ? 'border-brand-500 text-ink' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {mode === 'paste' ? t('vaults.modePaste') : t('vaults.modeBuild')}
              </button>
            ))}
          </div>

          {addMode === 'paste' ? (
            <AddVaultForm onAdded={(entry) => setEntries((prev) => [...prev, entry])} />
          ) : (
            <BuildVaultForm network={network} onAdded={(entry) => setEntries((prev) => [...prev, entry])} />
          )}
        </div>
      </CollapsibleCard>

      {entries.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <VaultGlyph className="h-8 w-8 text-ink-muted/50" />
          <p className="text-sm font-medium text-ink">{t('vaults.emptyTitle')}</p>
          <p className="max-w-xs text-sm text-ink-muted">{t('vaults.emptySubtitle')}</p>
        </Card>
      ) : (
        // auto-fit (NOT auto-fill) + minmax: auto-fit collapses empty/unused tracks to 0
        // width so the 1fr on populated tracks absorbs the freed space — auto-fill instead
        // reserves a track for every column that WOULD fit even if nothing occupies it,
        // which is why a single card stayed a fixed ~320px box surrounded by dead space.
        // min(320px,100%): same column ladder (1 phone / 2 tablet / 3+ desktop), but a track
        // may shrink below 320px on the narrowest phones instead of overflowing the viewport.
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
          {entries.map((v, i) => (
            <div key={v.id} style={{ animationDelay: `${i * 60}ms` }} className="animate-fade-in-up">
              <VaultCard
                entry={v}
                ownFingerprints={ownFingerprints}
                onRemove={() => setRemoving(v)}
                onUpdated={(updated) =>
                  setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
                }
              />
            </div>
          ))}
        </div>
      )}

      {removing && (
        <RemoveVaultModal
          entry={removing}
          onConfirm={() => {
            removeVaultBackup(removing.id, removing.descriptor)
            setEntries((prev) => prev.filter((e) => e.id !== removing.id))
            setRemoving(null)
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
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

function AddVaultForm({ onAdded }: { onAdded: (entry: VaultBackup) => void }) {
  const { t } = useI18n()
  const [label, setLabel] = useState('')
  const [descriptor, setDescriptor] = useState('')
  const [changeDescriptor, setChangeDescriptor] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function submit() {
    setError(null)
    setNotice(null)
    if (!descriptor.trim()) {
      setError(t('vaults.errorRequired'))
      return
    }
    // A repeat save DOES add a second copy (see addVaultBackup). Say so plainly, and name the
    // entry, since the label may have been suffixed to keep the two apart.
    const duplicate = findVaultBackupByDescriptor(descriptor) != null
    let entry: VaultBackup
    try {
      entry = addVaultBackup(label, descriptor, changeDescriptor)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('vaults.buildErrorGeneric'))
      return
    }
    onAdded(entry)
    setNotice(
      duplicate ? t('vaults.importSavedCopy', { label: entry.label }) : t('vaults.importSaved', { label: entry.label }),
    )
    setLabel('')
    setDescriptor('')
    setChangeDescriptor('')
  }

  /*
    Importing a file SAVES it — there is no fill-the-form-then-click-Save step. Picking a
    vault backup file is unambiguous intent, and the file already carries everything a save
    needs, so the confirmation click added no information and only a chance to lose the work.

    ⚠️ It could also be a DEAD CLICK: Save is disabled while the descriptor field is empty,
    and this function is async, so the state it sets lands in a LATER render than a click
    following it. A click arriving in that window hit a still-disabled button and did nothing
    at all — no save, no error, no feedback.

    ⚠️ The offline BUILDER's two steps (Build descriptor → review → Add backup) are NOT the
    same thing and must stay two: there the review IS the point, because every keyholder is
    meant to compare the built descriptor against their own before it is saved.

    addVaultBackup is idempotent on the descriptor, so re-importing the same file is a no-op
    rather than a duplicate.
  */
  async function importFile() {
    setError(null)
    setNotice(null)
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

    const parsed = parseVaultBackupFile(res.text)
    if (!parsed.descriptor.trim()) {
      setError(t('vaults.errorRequired'))
      return
    }
    const duplicate = findVaultBackupByDescriptor(parsed.descriptor) != null
    try {
      const entry = addVaultBackup(parsed.label, parsed.descriptor, parsed.changeDescriptor)
      onAdded(entry)
      setNotice(
        duplicate
          ? t('vaults.importSavedCopy', { label: entry.label })
          : t('vaults.importSaved', { label: entry.label }),
      )
    } catch (e) {
      // The vault cap (lib/limits.ts) throws here.
      setError(e instanceof Error ? e.message : t('vaults.errorReadFile'))
    }
  }

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex items-center justify-between">
        <Label>{t('vaults.addTitle')}</Label>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={importFile}>
          {t('vaults.importFile')}
        </Button>
      </div>
      <div>
        <Label>{t('vaults.label')}</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('vaults.labelPlaceholder')} />
      </div>
      <div>
        <Label>{t('vaults.descriptorLabel')}</Label>
        <Textarea
          rows={3}
          value={descriptor}
          onChange={(e) => setDescriptor(e.target.value)}
          placeholder={t('vaults.descriptorPlaceholder')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div>
        <Label>{t('vaults.changeDescriptorLabel')}</Label>
        <Textarea
          rows={3}
          value={changeDescriptor}
          onChange={(e) => setChangeDescriptor(e.target.value)}
          placeholder={t('vaults.changeDescriptorPlaceholder')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}
      <Button onClick={submit} disabled={!descriptor.trim()}>
        {t('vaults.save')}
      </Button>
    </div>
  )
}

type BuildKeyRow = { id: string; xpub: string; fingerprint: string; label: string }

/* A transient React key for a builder row — never persisted as a vault identity, so unlike
   lib/vaults.ts's newId this only has to be unique within the form. The fallback is random
   (not a timestamp), so it does not carry the same-millisecond collision that bug had. */
function newRowId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/*
  Builds a vault descriptor from scratch, entirely offline — the "coparties in a room
  together" scenario: every keyholder reads out their xpub + fingerprint (from their own
  Keys screen, or a hardware wallet, or wherever), one person types them all in here, picks
  the threshold, and gets back the exact same descriptor the platform would build server-side.
  No platform involvement needed — the result can be handed to a third-party tool (Sparrow,
  etc.) to verify addresses and build/sign/broadcast spends completely standalone.

  Keys are run through canonicalKeyOrder() (sort by fingerprint, then xpub) before building
  — see lib/build-descriptor.ts's big warning comment for why: the descriptor TEXT (and its
  checksum) is NOT reordered by sortedmulti, so without a fixed canonical order, the same
  group of keyholders entering their keys in a different order would get a different-looking
  (though functionally equivalent) descriptor. Canonical order makes any group converge on
  the identical descriptor regardless of entry order.

  ⚠️ EVERY EDIT IS PERSISTED AS A DRAFT (lib/vaults.ts). Transcribing a room's worth of
  extended public keys is minutes of work that used to vanish on a tab switch (Shell remounts
  the active screen) or an app restart, with no warning and no way back but asking everyone to
  read their key out again. The draft is deliberately NOT the saved-vault cache and is never
  auto-promoted into it — see readVaultDraft's comment for why a valid descriptor is not
  evidence the user finished entering keys.
*/
const EMPTY_ROWS = (): BuildKeyRow[] => [
  { id: newRowId(), xpub: '', fingerprint: '', label: '' },
  { id: newRowId(), xpub: '', fingerprint: '', label: '' },
  { id: newRowId(), xpub: '', fingerprint: '', label: '' },
]

function BuildVaultForm({
  network,
  onAdded,
}: {
  network: NetworkName
  onAdded: (entry: VaultBackup) => void
}) {
  const { t } = useI18n()
  // Restored ONCE on mount (lazy initializers) rather than in an effect — an effect would
  // render the empty form first and overwrite the draft with it on the very next save.
  const restored = useRef(readVaultDraft()).current
  const [label, setLabel] = useState(restored?.label ?? '')
  const [threshold, setThreshold] = useState(restored?.threshold ?? 2)
  const [rows, setRows] = useState<BuildKeyRow[]>(restored?.keys ?? EMPTY_ROWS())
  /*
    Has the user TOUCHED the threshold? Until they do, it tracks `defaultThreshold(filled)`
    so adding keys moves it (3 keys → 2, 5 keys → 3).

    ⚠️ The moment they edit it, it stops moving — silently overwriting a deliberate 3-of-3
    because a sixth key was pasted would change someone's security model behind their back.
    A restored draft counts as touched: the stored number was already their decision.
  */
  const [thresholdTouched, setThresholdTouched] = useState(restored != null)
  const [error, setError] = useState<string | null>(null)
  const [built, setBuilt] = useState<{ receive: string; change: string } | null>(restored?.built ?? null)
  const [restoredNotice, setRestoredNotice] = useState(restored != null)
  // True when the just-saved descriptor was ALREADY in the cache, so the result can say it is
  // a second copy — it is still saved either way, just under a suffixed label.
  const [savedExisting, setSavedExisting] = useState(false)
  const [savedLabel, setSavedLabel] = useState('')

  // How many rows actually carry a key. ⚠️ The threshold ceiling must be THIS, not
  // rows.length — an empty row would otherwise raise the maximum above the number of keys
  // that exist, letting someone pick a threshold their own vault can never reach.
  const filledCount = rows.filter((r) => r.xpub.trim()).length

  // Untouched threshold tracks the key count (3 keys → 2, 5 keys → 3). See
  // `thresholdTouched` above for why it stops the moment the user edits it.
  useEffect(() => {
    if (thresholdTouched) return
    setThreshold(defaultThreshold(filledCount))
  }, [filledCount, thresholdTouched])

  // Persist on every change. writeVaultDraft clears itself when nothing is worth keeping, so
  // emptying the form is a genuine discard rather than a draft that reappears tomorrow.
  useEffect(() => {
    writeVaultDraft({ label, threshold, keys: rows, built: built ?? undefined })
  }, [label, threshold, rows, built])

  // Same predicate the storage layer uses, so "there is a draft to discard" on screen can
  // never disagree with what is actually stored.
  const hasDraftContent = isDraftWorthKeeping({ label, threshold, keys: rows, savedAt: '' })

  function updateRow(id: string, patch: Partial<BuildKeyRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setBuilt(null)
    setSavedExisting(false)
  }
  function addRow() {
    setRows((prev) => [...prev, { id: newRowId(), xpub: '', fingerprint: '', label: '' }])
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
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    setBuilt(null)
    setSavedExisting(false)
  }

  /** Throw the whole draft away — the explicit user action that replaces "navigate away and
   *  hope". Resets to a clean form and removes the stored draft. */
  function discardDraft() {
    setLabel('')
    setThreshold(2)
    setRows(EMPTY_ROWS())
    setBuilt(null)
    setError(null)
    setRestoredNotice(false)
    setSavedExisting(false)
    clearVaultDraft()
  }

  /*
    ONE action: build the descriptor AND save it.

    ⚠️ The compare step is preserved, but it happens AFTER the save rather than gating it. It
    was previously a second button ("Build descriptor" → review → "Add backup"), which put the
    ceremony in the wrong order: the descriptor is on screen to compare either way, so gating
    the save on a click bought no extra verification — it only created a state where a correct,
    valuable descriptor existed and was not yet stored. Saving first and asking for the
    comparison afterwards keeps the prompt and removes the way to lose the work.

    Nothing about this weakens the check itself: a saved backup is a PUBLIC descriptor cache,
    not an authorization, and a keyholder who finds a mismatch removes the entry. The build is
    still refused unless the keys are valid, so a half-entered key set is never stored.
  */
  function buildAndSave() {
    setError(null)
    setBuilt(null)
    setRestoredNotice(false)
    setSavedExisting(false)
    const filled = rows.filter((r) => r.xpub.trim())
    if (filled.length < 2) {
      setError(t('vaults.buildErrorMinKeys'))
      return
    }
    /*
      ⚠️ The floor is the MAJORITY, not 1 — buildVaultDescriptor hard-refuses a minority
      quorum. Checked here too so the user gets the LOCALIZED message; the library's throw
      is English and exists for callers that never touch this form.
    */
    const required = minMajorityThreshold(filled.length)
    if (threshold < required || threshold > filled.length) {
      setError(t('vaults.buildErrorThreshold', { min: required, max: filled.length }))
      return
    }
    let result: { receive: string; change: string }
    try {
      const keys = filled.map((r) => ({ xpub: r.xpub.trim(), fingerprint: normalizeFingerprint(r.fingerprint) }))
      keys.forEach((k) => validateXpub(k.xpub, network))
      const ordered = canonicalKeyOrder(keys)
      result = buildVaultDescriptor({ m: threshold, keys: ordered, network })
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
    // The form is deliberately NOT reset and the draft is NOT cleared: the keys stay on screen
    // so they can be checked against the descriptor that was just saved, and the draft keeps
    // backing them until the user discards. (Clearing here would be undone by the persist
    // effect on the very next render anyway, since the fields are still populated.)
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

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <Label>{t('vaults.buildTitle')}</Label>
      <p className="text-xs text-ink-muted">{t('vaults.buildSubtitle')}</p>

      {restoredNotice && (
        <Alert kind="warn">
          {t('vaults.draftRestored', { date: new Date(restored?.savedAt ?? Date.now()).toLocaleString() })}
        </Alert>
      )}

      <div>
        <Label>{t('vaults.label')}</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('vaults.labelPlaceholder')} />
      </div>

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.id} className="space-y-2 border border-line p-3">
            <div className="flex items-center justify-between">
              <Label>{t('vaults.buildKeyN', { n: i + 1 })}</Label>
              {rows.length > 2 && (
                <button type="button" onClick={() => removeRow(row.id)} className="text-xs text-ink-muted hover:text-red-600 dark:hover:text-red-400">
                  {t('vaults.remove')}
                </button>
              )}
            </div>
            <Input
              value={row.label}
              onChange={(e) => updateRow(row.id, { label: e.target.value })}
              placeholder={t('vaults.buildKeyLabelPlaceholder')}
            />
            <Input
              value={row.xpub}
              onChange={(e) => updateRow(row.id, { xpub: e.target.value })}
              placeholder={t('vaults.buildKeyXpubPlaceholder')}
              className="font-mono"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Input
              value={row.fingerprint}
              onChange={(e) => updateRow(row.id, { fingerprint: e.target.value })}
              placeholder={t('vaults.buildKeyFingerprintPlaceholder')}
              className="font-mono"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {/* Sits UNDER the fields it fills, not above them: typing stays the primary path
                (most keyholders are reading a key off another person's screen), and the file
                is the shortcut for whoever happens to have one on a USB stick. */}
            <button
              type="button"
              onClick={() => void importKeyFile(row.id)}
              className="min-h-11 text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              {t('vaults.buildKeyImportFile')}
            </button>
          </div>
        ))}
      </div>
      <Button variant="secondary" onClick={addRow}>
        {t('vaults.buildAddKey')}
      </Button>

      <div>
        <Label>{t('vaults.buildThreshold')}</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="number"
            inputMode="numeric"
            // ⚠️ Floor is the MAJORITY, not 1 — a reachable sub-majority value would be a
            // spinner step straight into a refusal. Note min/max on a number input are only
            // advisory (typing is not blocked), so buildAndSave still checks.
            min={minMajorityThreshold(Math.max(1, filledCount))}
            // ⚠️ Bounded by FILLED keys, not row count — an empty row must not raise the
            // ceiling above the number of keys that actually exist.
            max={Math.max(1, filledCount)}
            value={threshold}
            onChange={(e) => {
              setThresholdTouched(true)
              setThreshold(Number(e.target.value) || 1)
            }}
            className="w-24"
          />
          {filledCount > 0 && (
            <p className="text-sm text-ink-muted">
              {t('vaults.buildThresholdSummary', { m: threshold, n: filledCount })}
            </p>
          )}
        </div>
        {/*
          ⚠️ WARN, never block. m === n is a valid vault and occasionally what someone
          genuinely wants, but losing ANY single key makes the funds permanently
          unspendable — the property people most often do not realise they picked.
        */}
        {isNoRedundancyQuorum(threshold, filledCount) && (
          <div className="mt-2">
            <Alert kind="warn">{t('vaults.buildThresholdNoRedundancy', { n: filledCount })}</Alert>
          </div>
        )}
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={buildAndSave}>{t('vaults.buildAction')}</Button>
        {hasDraftContent && (
          <Button variant="ghost" onClick={discardDraft}>
            {t('vaults.draftDiscard')}
          </Button>
        )}
      </div>

      {built && (
        <div className="space-y-3 animate-fade-in">
          {/* Already SAVED at this point. The comparison prompt is the subtle part — it asks
              for the check without standing between the user and their saved work. */}
          <Alert kind="ok">
            {savedExisting ? t('vaults.buildSavedCopy', { label: savedLabel }) : t('vaults.buildSavedCompare')}
          </Alert>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Label>{t('vaults.summaryReceiveBranch')}</Label>
              <CopyButton value={built.receive} />
            </div>
            <Mono className="block break-all border border-line p-2 text-xs">{built.receive}</Mono>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Label>{t('vaults.summaryChangeBranch')}</Label>
              <CopyButton value={built.change} />
            </div>
            <Mono className="block break-all border border-line p-2 text-xs">{built.change}</Mono>
          </div>
        </div>
      )}

      {/* The draft is saved continuously, so say so plainly rather than leaving the user to
          guess whether leaving this screen costs them their transcription. */}
      {hasDraftContent && <p className="text-xs text-ink-muted">{t('vaults.draftKept')}</p>}
    </div>
  )
}

/*
  Master fingerprints of the keys held on THIS device, so a vault card can mark which
  cosigner is you. Derived from the unlocked keystore the same way backup-diff.ts does it
  (accountKey → masterFingerprint), and lowercased to match parseDescriptorSummary's output.

  ⚠️ A master fingerprint is IDENTICAL across networks for the same seed (see §9's note on
  per-network derivation), so a key stamped testnet still matches a mainnet descriptor's
  fingerprint. That is fine HERE — this is a display hint about whose key it is, not a
  signing decision — but it is exactly why identity matching must never use the fingerprint
  to tell networks apart.

  BIP-32 per key, so this is memoized once at the screen and passed down rather than
  recomputed inside every card.
*/
function useOwnFingerprints(entries: KeyEntry[]): Set<string> {
  return useMemo(() => {
    const out = new Set<string>()
    for (const e of entries) {
      try {
        out.add(accountKey(e.mnemonic, networkOf(e)).masterFingerprint.toLowerCase())
      } catch {
        // A key we can't derive simply goes unmarked — never break the card over a hint.
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
    <li className="flex flex-col gap-1.5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
            <span className={cx('break-words', name ? 'text-ink' : 'text-ink-muted')}>
              {name || t('vaults.summarySigner', { index: index + 1 })}
            </span>
            {isMine && (
              <span className="shrink-0 border border-brand-500/30 bg-brand-500/10 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-400">
                {t('vaults.summaryThisDevice')}
              </span>
            )}
            <button
              type="button"
              onClick={start}
              aria-label={t('vaults.nameSigner')}
              title={t('vaults.nameSigner')}
              className="-m-2 shrink-0 p-2 text-ink-muted transition-colors hover:text-brand-600 dark:hover:text-brand-400"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* Both values are copyable: a truncated xpub is useless to paste into another tool,
            and re-typing a fingerprint by eye is how a wrong key gets enrolled. Public data,
            so there is nothing to withhold. */}
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="font-mono text-xs uppercase tracking-wide text-ink-muted">
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

function VaultCard({
  entry,
  ownFingerprints,
  onRemove,
  onUpdated,
}: {
  entry: VaultBackup
  ownFingerprints: Set<string>
  onRemove: () => void
  /** This entry changed in storage — rename, a cosigner name, or a filled-in change
   *  descriptor. One callback for all of them: the screen just swaps the entry it holds. */
  onUpdated: (updated: VaultBackup) => void
}) {
  const { t } = useI18n()
  const [showRaw, setShowRaw] = useState(false)
  const [showDerive, setShowDerive] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [labelDraft, setLabelDraft] = useState(entry.label)
  const summary = parseDescriptorSummary(entry.descriptor)

  function startRename() {
    setLabelDraft(entry.label)
    setRenaming(true)
  }
  function saveRename() {
    onUpdated(renameVaultBackup(entry.id, labelDraft))
    setRenaming(false)
  }

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center border border-line bg-surface">
            <VaultGlyph className="h-4 w-4 text-brand-600 dark:text-brand-400" />
          </span>
          <div className="min-w-0 flex-1">
            {/* The label is a local nickname with no cryptographic meaning, so it is freely
                editable — inline, mirroring the Keys screen's rename. The DESCRIPTOR is the
                vault's identity and is deliberately not editable anywhere. */}
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
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={saveRename}>
                    {t('vaults.renameSave')}
                  </Button>
                  <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setRenaming(false)}>
                    {t('vaults.renameCancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                {/* Full label, wrapped (not truncated) — the name is the whole point of the card. */}
                <div className="break-words font-medium text-ink">{entry.label}</div>
                <button
                  type="button"
                  onClick={startRename}
                  aria-label={t('vaults.rename')}
                  title={t('vaults.rename')}
                  className="-m-2 shrink-0 p-2 text-ink-muted transition-colors hover:text-brand-600 dark:hover:text-brand-400"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="text-xs text-ink-muted">{t('vaults.savedOn', { date: new Date(entry.savedAt).toLocaleDateString() })}</div>
          </div>
        </div>
        <Button variant="ghost" className="shrink-0 px-2 py-1 text-xs" onClick={onRemove}>
          {t('vaults.remove')}
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {summary ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="border border-brand-500/30 bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-400">
                {t('vaults.summaryQuorum', { threshold: summary.threshold, total: summary.total })}
              </span>
            </div>
            <ul className="divide-y divide-line border border-line">
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
          </div>
        ) : (
          <Alert kind="warn">
            <Mono className="block break-all">{entry.descriptor}</Mono>
          </Alert>
        )}

        {summary && (
          <div>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="text-xs text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
            >
              {showRaw ? t('vaults.hideRawDescriptor') : t('vaults.showRawDescriptor')}
            </button>
            {showRaw && (
              <div className="mt-3 space-y-3 animate-fade-in">
                <p className="text-xs text-ink-muted">{t('vaults.rawDescriptorNote')}</p>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <Label>{t('vaults.summaryReceiveBranch')}</Label>
                    <CopyButton value={entry.descriptor} />
                  </div>
                  <Mono className="block break-all">{entry.descriptor}</Mono>
                </div>
                {entry.changeDescriptor && (
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <Label>{t('vaults.summaryChangeBranch')}</Label>
                      <CopyButton value={entry.changeDescriptor} />
                    </div>
                    <Mono className="block break-all">{entry.changeDescriptor}</Mono>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!summary && entry.changeDescriptor && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>{t('vaults.changeDescriptor')}</Label>
              <CopyButton value={entry.changeDescriptor} />
            </div>
            <Mono className="block break-all">{entry.changeDescriptor}</Mono>
          </div>
        )}

        {!entry.changeDescriptor && (
          <AddChangeDescriptorForm entry={entry} onAdded={onUpdated} />
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowDerive((v) => !v)}
            className="text-xs text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
          >
            {showDerive ? t('vaults.hideDerive') : t('vaults.showDerive')}
          </button>
          {showDerive && <DeriveAddressForm entry={entry} />}
        </div>
      </div>
    </Card>
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
    <div className="mt-3 space-y-2 animate-fade-in border-t border-line pt-3">
      <p className="text-xs text-ink-muted">{t('vaults.deriveSubtitle')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex border-b border-line">
          {(['receive', 'change'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBranchAndPersist(b)}
              className={cx(
                '-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors',
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
            className="flex h-10 w-10 items-center justify-center border border-line text-ink-muted transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-40 sm:h-8 sm:w-8"
          >
            ‹
          </button>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={index}
            onChange={(e) => setIndexAndPersist(Number(e.target.value) || 0)}
            className="w-16 text-center"
            aria-label={t('vaults.deriveIndexLabel')}
          />
          <button
            type="button"
            onClick={() => setIndexAndPersist(index + 1)}
            aria-label={t('vaults.deriveNextIndex')}
            className="flex h-10 w-10 items-center justify-center border border-line text-ink-muted transition-colors hover:text-ink sm:h-8 sm:w-8"
          >
            ›
          </button>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {address && (
        <div className="animate-fade-in">
          <div className="mb-1.5 flex items-center justify-between">
            <Label>
              {t('vaults.deriveResultLabel', {
                branch: branch === 'receive' ? t('vaults.deriveBranchReceive') : t('vaults.deriveBranchChange'),
                index,
              })}
            </Label>
            <CopyButton value={address} />
          </div>
          <Mono className="block break-all">{address}</Mono>
          <p className="mt-1.5 text-xs text-ink-muted">{t('vaults.deriveCompareHint')}</p>
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
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    setError(null)
    if (!value.trim()) {
      setError(t('vaults.errorRequired'))
      return
    }
    try {
      const updated = addMissingChangeDescriptor(entry.id, value.trim())
      onAdded(updated)
      setOpen(false)
      setValue('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
      >
        {t('vaults.addChangeDescriptor')}
      </button>
    )
  }

  return (
    <div className="space-y-2 animate-fade-in border-t border-line pt-3">
      <p className="text-xs text-ink-muted">{t('vaults.addChangeDescriptorHint')}</p>
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
          <div className="flex flex-wrap items-center gap-2 border border-line px-3 py-2">
            <span className="border border-brand-500/30 bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-400">
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
