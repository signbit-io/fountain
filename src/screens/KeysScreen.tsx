import { useEffect, useRef, useState } from 'react'
import { useKeystore } from '../lib/keystore'
import type { NetworkName } from '../lib/key'
import { Button, Card, Input, PasswordInput, Label, Alert, Mono, CopyButton, Modal, copyToClipboard, SeedPhraseInput } from '../components/ui'
import { analyzeMnemonic, networkOf } from '../lib/key'
import type { KeyEntry } from '../lib/crypto'
import { saveTextFile, saveTextFilesToDir, planKeyExports, defaultKeyExportFilename } from '../lib/download'
import type { AccountKey } from '../lib/key'
import { multisigAccountPath, coinTypeOfPath, xpubPrefix } from '../lib/bitcoin-network'
import { useI18n } from '../i18n'

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/*
  Keys screen — create / import / list / export the user's keys. The MVP target is "create
  2 keys" to enroll in a 3-of-5 platform vault. A freshly created key shows its 24-word
  mnemonic ONCE (back it up now) — it's never shown again unless re-derived.
*/
export function KeysScreen({
  network,
  openGuideOnMount,
  onGuideOpened,
}: {
  network: NetworkName
  /** Open the setup-guide modal immediately on mount — set by the Help tab's Keys
   *  section cross-reference (see App.tsx), which navigates here then flips this. */
  openGuideOnMount?: boolean
  /** Called once the initial openGuideOnMount request has been honored, so the
   *  caller can clear its one-shot flag. */
  onGuideOpened?: () => void
}) {
  const { entries, createKey, importKey, removeKey, exportPublic } = useKeystore()
  const { t } = useI18n()
  const [reveal, setReveal] = useState<KeyEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(!!openGuideOnMount)
  const [exportAllOpen, setExportAllOpen] = useState(false)
  const [exportAllDone, setExportAllDone] = useState<string | null>(null)

  useEffect(() => {
    if (openGuideOnMount) onGuideOpened?.()
    // Only meant to run once on mount (see openGuideOnMount's own doc) — the effect's
    // dependency array is deliberately empty-equivalent here, not tracking these props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-6">
      {/* Header card = section title + count + the primary create/import actions. */}
      <Card className="space-y-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{t('keys.title')}</h2>
            <span className="border border-line px-1.5 py-0.5 font-mono text-xs text-ink-muted">
              {entries.length}
            </span>
            <button
              type="button"
              onClick={() => setGuideOpen(true)}
              aria-label={t('keys.guideTitle')}
              title={t('keys.guideTitle')}
              className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-ink-muted transition-colors hover:border-brand-400/60 hover:text-brand-600 dark:hover:text-brand-400 sm:h-6 sm:w-6"
            >
              <HelpIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* The prefix follows the network (tpub on testnet, xpub on mainnet) — naming a
              prefix the user won't see on their own key card is worse than saying nothing. */}
          <p className="text-sm text-ink-muted">{t('keys.subtitle', { prefix: xpubPrefix(network) })}</p>
        </div>
        <CreateBar
          onCreate={async (label) => {
            setError(null)
            try {
              // New keys are stamped with the network the app is CURRENTLY on — the one moment
              // the global setting is the right source. From here on the key carries its own.
              setReveal(await createKey(label, network))
            } catch (e) {
              setError((e as Error).message)
            }
          }}
          onImport={(label, mnemonic) => importKey(label, mnemonic, network)}
          network={network}
        />
        {/* Export ALL public keys — one .json per key, into a folder the user picks once.
            Only offered once there is more than one key: with a single key the per-card
            "Export file" already IS this, and a second route to it is just a second button.
            No hint text under the button — the modal it opens says the same thing at the
            moment it matters, with the real file count. */}
        {entries.length > 1 && (
          <div className="border-t border-line pt-4">
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={() => {
                setExportAllDone(null)
                setExportAllOpen(true)
              }}
            >
              {t('keys.exportAllAction', { count: String(entries.length) })}
            </Button>
          </div>
        )}
      </Card>

      {guideOpen && <KeySetupGuideModal network={network} onClose={() => setGuideOpen(false)} />}

      {exportAllOpen && (
        <ExportAllModal
          entries={entries}
          exportPublic={exportPublic}
          onClose={() => setExportAllOpen(false)}
          onDone={(msg) => {
            setExportAllOpen(false)
            setExportAllDone(msg)
          }}
        />
      )}

      {exportAllDone && <Alert kind="ok">{exportAllDone}</Alert>}

      {error && <Alert kind="error">{error}</Alert>}

      {reveal && <RevealMnemonic entry={reveal} onDone={() => setReveal(null)} />}

      {entries.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <KeyGlyph className="h-8 w-8 text-ink-muted/50" />
          <p className="text-sm font-medium text-ink">{t('keys.emptyTitle')}</p>
          <p className="max-w-xs text-sm text-ink-muted">{t('keys.emptySubtitle')}</p>
        </Card>
      ) : (
        // auto-fit (NOT auto-fill) + minmax: auto-fit collapses empty/unused tracks to 0
        // width so the 1fr on populated tracks absorbs the freed space. min(320px,100%) keeps
        // the phone→tablet→desktop column count (1 → 2 → 3+) while letting a single track
        // shrink below 320px on the narrowest phones instead of overflowing the viewport.
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
          {entries.map((e, i) => (
            <div key={e.id} style={{ animationDelay: `${i * 60}ms` }} className="animate-fade-in-up">
              <KeyCard entry={e} network={network} onRemove={() => removeKey(e.id)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* A simple key glyph — gives each key card a visual identity + the empty state an anchor. */
function KeyGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="4.5" />
      <path d="M11.2 11.2 20 20" />
      <path d="M16.5 16.5 18.5 14.5" />
      <path d="M14 14l2.5 2.5" />
    </svg>
  )
}

/* A plain "?" help glyph for the guide trigger — matches KeyGlyph's stroke weight/style. */
function HelpIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.2a2.5 2.5 0 1 1 3.5 2.3c-.9.5-1.5 1-1.5 2" />
      <circle cx="12" cy="16.5" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

/* A small pencil glyph for the inline rename trigger. */
function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      <path d="M14.5 5.5l3 3" />
    </svg>
  )
}

/* Small copy/check glyphs for the compact inline fingerprint-copy trigger. */
function CopyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="1.5" />
      <path d="M5 15V4.5A1.5 1.5 0 0 1 6.5 3H15" />
    </svg>
  )
}
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/*
  Key setup guide — mirrors the platform's vault-create guide, but scoped
  to THIS app's actual current settings (network-driven path, script type, and what to export)
  rather than restating the platform's own copy. Read-only info modal, opened from the header
  help icon — no persisted "seen" state, since it's a reference the user may reopen anytime.
*/
function KeySetupGuideModal({ network, onClose }: { network: NetworkName; onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Modal open onClose={onClose} title={t('keys.guideTitle')}>
      <p className="text-sm text-ink-muted">{t('keys.guideIntro')}</p>
      <ul className="mt-3 space-y-2 text-sm">
        <li className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <span className="mt-0.5 text-brand-500">✓</span>
          <span className="text-ink">{t('keys.guideScript')}</span>
        </li>
        <li className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <span className="mt-0.5 text-brand-500">✓</span>
          <span className="text-ink">{t('keys.guidePath', { path: multisigAccountPath(network) })}</span>
        </li>
        <li className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <span className="mt-0.5 text-brand-500">✓</span>
          <span className="text-ink">{t('keys.guideNetwork', { network, prefix: xpubPrefix(network) })}</span>
        </li>
        <li className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <span className="mt-0.5 text-brand-500">✓</span>
          <span className="text-ink">{t('keys.guideExport', { prefix: xpubPrefix(network) })}</span>
        </li>
      </ul>
    </Modal>
  )
}

function CreateBar({
  onCreate,
  onImport,
  network,
}: {
  onCreate: (label: string) => void
  onImport: (label: string, mnemonic: string) => Promise<KeyEntry>
  /** The network a key made here will be STAMPED with — stated up front, not after the fact. */
  network: NetworkName
}) {
  const { t } = useI18n()
  const [importing, setImporting] = useState(false)
  const [label, setLabel] = useState('')

  return (
    <>
      {/* A key is stamped with the current network at birth and derives there for good, so the
          user has to know which one they're about to get BEFORE they press the button — after
          the fact it's just a fact they can't act on. */}
      {/* One quiet line, not a warning banner. The fact worth stating is that the choice is
          permanent for this key — the user already knows what mainnet means, and a full-width
          alert above every key they make would be noise they learn to skip past. */}
      {network === 'mainnet' && (
        <p className="mb-2 text-xs text-ink-muted">{t('keys.createOnMainnet')}</p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('keys.newKeyLabelPlaceholder')}
          className="w-full sm:w-44"
        />
        <div className="flex gap-2">
          <Button
            className="flex-1 sm:flex-none"
            onClick={() => {
              onCreate(label)
              setLabel('')
            }}
          >
            {t('keys.createKey')}
          </Button>
          <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => setImporting(true)}>
            {t('keys.import')}
          </Button>
        </div>
      </div>
      {importing && <ImportKeyModal onImport={onImport} onClose={() => setImporting(false)} />}
    </>
  )
}

/*
  Import is a deliberate, focused action (pasting/verifying a 12-24 word seed phrase), so it
  gets its own Modal rather than swapping the header card in place — same pattern as reveal/
  remove elsewhere on this screen. Errors (invalid phrase, duplicate import) surface INSIDE the
  modal so a mistyped/duplicate phrase can be corrected without losing what was typed or having
  to reopen the flow.
*/
function ImportKeyModal({
  onImport,
  onClose,
}: {
  onImport: (label: string, mnemonic: string) => Promise<KeyEntry>
  onClose: () => void
}) {
  const { t } = useI18n()
  const [label, setLabel] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const valid = analyzeMnemonic(mnemonic).ok

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      await onImport(label, mnemonic)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('keys.import')}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label>{t('keys.label')}</Label>
          <Input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('keys.labelPlaceholder')}
          />
        </div>
        <div>
          <Label>{t('keys.seedPhraseLabel')}</Label>
          <SeedPhraseInput value={mnemonic} onChange={setMnemonic} />
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!valid || busy}>
            {busy ? t('keys.checking') : t('keys.import')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/* Seed-phrase word grid — shared by the post-create backup + the reveal-again modals. */
function SeedWords({ mnemonic }: { mnemonic: string }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {mnemonic.split(' ').map((w, i) => (
        <div key={i} className="border border-line bg-surface px-2 py-1.5">
          <span className="mr-1.5 font-mono text-[10px] text-ink-muted">{i + 1}</span>
          <span className="font-mono text-xs text-ink">{w}</span>
        </div>
      ))}
    </div>
  )
}

function RevealMnemonic({ entry, onDone }: { entry: KeyEntry; onDone: () => void }) {
  const { t } = useI18n()
  return (
    <Modal open onClose={onDone} title={t('keys.backupTitle', { label: entry.label })}>
      <div className="space-y-4">
        <Alert kind="warn">
          <strong>{t('keys.backupWarningStrong')}</strong> {t('keys.backupWarningRest')}
        </Alert>
        <SeedWords mnemonic={entry.mnemonic} />
        {/*
          🚨 **NO COPY BUTTON HERE, AND NONE MAY BE ADDED.** See the note above RevealSeed —
          the system clipboard is not local, so copying a mnemonic is how the air gap gets
          bypassed by a single tap. The numbered grid above is the capture path.
        */}
        <div className="flex gap-2">
          <Button onClick={onDone}>{t('keys.backedUp')}</Button>
        </div>
      </div>
    </Modal>
  )
}

function KeyCard({
  entry,
  network,
  onRemove,
}: {
  entry: KeyEntry
  /** The app's CURRENT network — used only to flag a key that doesn't match it. */
  network: NetworkName
  onRemove: () => void
}) {
  // What this key actually derives at, for good. Everything key-specific reads this.
  const keyNetwork = networkOf(entry)
  const offNetwork = keyNetwork !== network
  const { exportPublic, renameKey } = useKeystore()
  const { t } = useI18n()
  const [showingPub, setShowingPub] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [labelDraft, setLabelDraft] = useState(entry.label)
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [fpCopyState, setFpCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyFingerprint(value: string) {
    const ok = await copyToClipboard(value)
    setFpCopyState(ok ? 'copied' : 'failed')
    setTimeout(() => setFpCopyState('idle'), 1500)
  }

  function startRename() {
    setLabelDraft(entry.label)
    setRenameErr(null)
    setRenaming(true)
  }
  async function saveRename() {
    try {
      await renameKey(entry.id, labelDraft)
      setRenaming(false)
    } catch (e) {
      setRenameErr((e as Error).message)
    }
  }

  // The master fingerprint is public data and is the key's at-a-glance IDENTITY, so we
  // derive + show it eagerly (we're unlocked). `tpub` stays behind "Show public key" —
  // it's long and only needed at enrollment time.
  let fingerprint: string | null = null
  try {
    fingerprint = exportPublic(entry.id).masterFingerprint
  } catch {
    fingerprint = null
  }

  return (
    <Card className="flex flex-col">
      {/* Identity row: glyph avatar + label + fingerprint, with Remove tucked to the side.
          The label swaps to an inline edit (Input + Save/Cancel) via the pencil trigger —
          renaming only changes the label; id/mnemonic/derivation are untouched. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center border border-line bg-surface">
            <KeyGlyph className="h-4 w-4 text-brand-600 dark:text-brand-400" />
          </span>
          <div className="min-w-0 flex-1">
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
                {renameErr && <p className="text-xs text-red-600 dark:text-red-400">{renameErr}</p>}
                <div className="flex gap-2">
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={saveRename}>
                    {t('keys.renameSave')}
                  </Button>
                  <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setRenaming(false)}>
                    {t('keys.renameCancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <div className="truncate font-medium text-ink">{entry.label}</div>
                <button
                  type="button"
                  onClick={startRename}
                  aria-label={t('keys.rename')}
                  title={t('keys.rename')}
                  className="-m-2 shrink-0 p-2 text-ink-muted transition-colors hover:text-brand-600 dark:hover:text-brand-400"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {/* Network sits on the fingerprint line, not in a badge of its own.

                Only MAINNET is marked: it is the exception, and the one where being wrong costs
                money. Giving testnet an equal-weight pill made the ordinary case shout as loudly
                as the notable one and crowded the fingerprint, which is the real identity here.
                A key that isn't on the app's current network is dimmed rather than captioned —
                it still works (it derives at its own stamp); it just isn't the current context. */}
            {fingerprint && (
              <div className="flex items-center gap-1.5">
                <span
                  className={cx(
                    'font-mono text-xs uppercase tracking-wide',
                    offNetwork ? 'text-ink-muted/60' : 'text-ink-muted',
                  )}
                >
                  {fingerprint}
                </span>
                {keyNetwork === 'mainnet' && (
                  <span className="shrink-0 border border-brand-500/50 px-1 text-[10px] font-medium uppercase tracking-wide text-brand-700 dark:text-brand-400">
                    {keyNetwork}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => copyFingerprint(fingerprint!)}
                  aria-label={t('common.copy')}
                  title={t('common.copy')}
                  className={cx(
                    // -m-2 p-2: invisible ~40px touch hit area around the small glyph.
                    '-m-2 p-2 shrink-0 flex items-center gap-1 text-xs font-medium transition-colors',
                    fpCopyState === 'copied' && 'text-emerald-600 dark:text-emerald-400',
                    fpCopyState === 'failed' && 'text-red-600 dark:text-red-400',
                    fpCopyState === 'idle' && 'text-ink-muted hover:text-brand-600 dark:hover:text-brand-400',
                  )}
                >
                  {fpCopyState === 'copied' ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
                  {fpCopyState === 'copied' && t('common.copied')}
                  {fpCopyState === 'failed' && t('common.copyFailed')}
                </button>
              </div>
            )}
          </div>
        </div>
        <Button variant="ghost" className="shrink-0 px-2 py-1 text-xs" onClick={() => setRemoving(true)}>
          {t('keys.remove')}
        </Button>
      </div>

      {/* The KEY'S network, not the app's — a testnet key must not advertise "mainnet" just
          because the toggle happens to sit there. */}
      <Button variant="secondary" className="mt-4 w-full" onClick={() => setShowingPub(true)}>
        {t('keys.showPublicKey', { network: keyNetwork })}
      </Button>

      {showingPub && (
        <PublicKeyModal entry={entry} exportPublic={exportPublic} onClose={() => setShowingPub(false)} />
      )}

      {/* Footer: created date + reveal-seed action, pinned to the bottom of the card. */}
      <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
        <span className="text-xs text-ink-muted">
          {t('keys.addedOn', { date: new Date(entry.createdAt).toLocaleDateString() })}
        </span>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setRevealing(true)}>
          {t('keys.revealSeed')}
        </Button>
      </div>

      {revealing && <RevealSeedModal entry={entry} onClose={() => setRevealing(false)} />}
      {removing && (
        <RemoveKeyModal
          entry={entry}
          fingerprint={fingerprint}
          onConfirm={onRemove}
          onClose={() => setRemoving(false)}
        />
      )}
    </Card>
  )
}

/*
  Public-key reveal — a Modal rather than expanding the card in place. The fingerprint/tpub/
  export-actions block used to grow the card inline, which desynced card heights within the
  same CSS grid row (one taller card, several short neighbors — a jumbled-looking grid). A
  modal gives the tpub full width to breathe and keeps every card in the grid a fixed height
  regardless of how many keys have their public key "open" at once — same pattern as every
  other deliberate-reveal surface on this screen (seed reveal, remove, import).
*/
function PublicKeyModal({
  entry,
  exportPublic,
  onClose,
}: {
  entry: KeyEntry
  // No `network` prop on purpose: everything here comes from the key itself, so there is no
  // second source that could disagree with what exportPublic derives.
  exportPublic: (id: string) => AccountKey
  onClose: () => void
}) {
  const { t } = useI18n()
  const [exporting, setExporting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  let pub: AccountKey | null = null
  let loadErr: string | null = null
  try {
    // Derives at the KEY's stamp. This is the enrollment export — the xpub pasted into a vault
    // on the platform — so a wrong network here produces a vault the user cannot ever sign for.
    pub = exportPublic(entry.id)
  } catch (e) {
    loadErr = (e as Error).message
  }

  return (
    <Modal open onClose={onClose} title={t('keys.publicKeyModalTitle', { label: entry.label })}>
      {loadErr ? (
        <Alert kind="error">{loadErr}</Alert>
      ) : (
        pub && (
          <div className="space-y-4">
            {/* This is the enrollment surface — the values here get pasted into a vault on the
                platform. The network belongs beside them: an xpub enrolled in the wrong-network
                vault produces one nobody can ever sign for. */}
            <Field label={t('keys.fingerprint')} value={pub.masterFingerprint} />
            <Field label={t('keys.accountTpub')} value={pub.tpub} />
            <Field label={t('settings.network.label')} value={networkOf(entry)} />
            <Field label={t('keys.derivationPath')} value={pub.derivationPath} />
            {err && <Alert kind="error">{err}</Alert>}
            <div className="space-y-2 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton value={enrollmentJson(entry, pub)} />
                {/* Native Save-As dialog in the app (blob download in a browser tab). Saves
                    the public-key envelope — the artifact the platform's vault-create imports. */}
                <Button
                  variant="secondary"
                  className="px-2.5 py-1.5 text-xs"
                  disabled={exporting}
                  onClick={async () => {
                    setErr(null)
                    setExporting(true)
                    try {
                      const name = defaultKeyExportFilename(entry.label, pub.masterFingerprint)
                      await saveTextFile(name, enrollmentJson(entry, pub), [
                        { name: 'SignBit companion key', extensions: ['json'] },
                      ])
                    } catch (e) {
                      setErr((e as Error).message || t('keys.errorSaveFile'))
                    } finally {
                      setExporting(false)
                    }
                  }}
                >
                  {exporting ? t('keys.exportFileSaving') : t('keys.exportFileJson')}
                </Button>
              </div>
              <p className="text-xs text-ink-muted">{t('keys.exportFilePublicNote')}</p>
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        )
      )}
    </Modal>
  )
}

/*
  Export ALL public keys — one `signbit-key-<label>-<fp>.json` per key, written into ONE folder
  the user picks. The same envelope `PublicKeyModal` writes for a single key, so a bulk export
  and fifteen one-at-a-time exports produce byte-identical files.

  ⚠️ NO passphrase gate, deliberately — unlike the app backup, which is the SEEDS and therefore
  re-asks for the passphrase before writing. These are PUBLIC keys (xpub + fingerprint); the
  per-key export beside them has never been gated either, and gating the bulk path alone would
  imply the single path leaks something it does not.

  ⚠️ A key whose stamp cannot be derived is SKIPPED, not fatal. exportPublic throws per key, and
  aborting the whole run over one bad entry would deny the user the fourteen keys that are fine —
  so the skipped ones are counted and NAMED in the result rather than swallowed.
*/
function ExportAllModal({
  entries,
  exportPublic,
  onClose,
  onDone,
}: {
  entries: KeyEntry[]
  exportPublic: (id: string) => AccountKey
  onClose: () => void
  onDone: (message: string) => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Derive up front, so the modal can state the real count it is about to write (and name any
  // key it cannot export) BEFORE the user picks a folder — not after, when the number is a
  // surprise. Cheap: this is BIP-32 neutered-node derivation, already done per card.
  const { plannable, skipped } = (() => {
    const plannable: { label: string; masterFingerprint: string; json: string }[] = []
    const skipped: string[] = []
    for (const e of entries) {
      try {
        const pub = exportPublic(e.id)
        plannable.push({ label: e.label, masterFingerprint: pub.masterFingerprint, json: enrollmentJson(e, pub) })
      } catch {
        skipped.push(e.label || t('keys.keyFallbackName'))
      }
    }
    return { plannable, skipped }
  })()

  return (
    <Modal open onClose={onClose} title={t('keys.exportAllTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {t('keys.exportAllBody', { count: String(plannable.length) })}
        </p>
        {/* Its OWN note, not the single-key modal's `exportFilePublicNote` — that one is
            singular ("enroll THIS as your Fountain key"), which reads wrong over a folder of
            fifteen. Same fact, said in the plural. */}
        <p className="text-xs text-ink-muted">{t('keys.exportAllPublicNote')}</p>

        {skipped.length > 0 && (
          <Alert kind="warn">{t('keys.exportAllSkipped', { names: skipped.join(', ') })}</Alert>
        )}
        {err && <Alert kind="error">{err}</Alert>}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            className="w-full sm:w-auto"
            disabled={busy || plannable.length === 0}
            onClick={async () => {
              setErr(null)
              setBusy(true)
              try {
                const res = await saveTextFilesToDir(planKeyExports(plannable))
                if (res.status === 'cancelled') return setBusy(false)
                onDone(t('keys.exportAllSaved', { count: String(res.written) }))
              } catch (e) {
                // Includes the partial-write abort, which names how many landed — surfaced
                // verbatim because "9 of 15" is the only useful thing to tell the user.
                setErr((e as Error).message || t('keys.errorSaveFile'))
                setBusy(false)
              }
            }}
          >
            {busy ? t('keys.exportFileSaving') : t('keys.exportAllConfirm')}
          </Button>
          <Button variant="secondary" className="w-full sm:w-auto" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/*
  Seed reveal is passphrase-gated: even though the app is unlocked, showing the 24 words —
  the single most dangerous action — requires RE-TYPING the passphrase. This guards an
  already-unlocked, unattended device. After MAX_ATTEMPTS wrong tries the app LOCKS (a
  brute-force backstop). The passphrase is verified against the on-disk envelope
  (verifyPassphrase); the words come from the in-memory keystore only once verified.
*/
const MAX_REVEAL_ATTEMPTS = 3

function RevealSeedModal({ entry, onClose }: { entry: KeyEntry; onClose: () => void }) {
  const { verifyPassphrase, mnemonicFor, lock } = useKeystore()
  const { t } = useI18n()
  const [pass, setPass] = useState('')
  const [seed, setSeed] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const remaining = MAX_REVEAL_ATTEMPTS - attempts

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const ok = await verifyPassphrase(pass)
    setBusy(false)
    if (ok) {
      setSeed(mnemonicFor(entry.id))
      return
    }
    const next = attempts + 1
    setAttempts(next)
    setPass('')
    if (next >= MAX_REVEAL_ATTEMPTS) {
      // Too many wrong tries — lock the whole app as a brute-force backstop.
      lock()
      return
    }
    const remainingAfter = remaining - 1
    setError(
      t(remainingAfter === 1 ? 'keys.revealIncorrectPassphrase' : 'keys.revealIncorrectPassphrasePlural', {
        count: remainingAfter,
      }),
    )
  }

  return (
    <Modal open onClose={onClose} title={t('keys.revealModalTitle', { label: entry.label })}>
      {seed ? (
        <div className="space-y-4">
          <Alert kind="warn">{t('keys.revealWarningShown')}</Alert>
          <SeedWords mnemonic={seed} />
          {/*
            🚨 **A MNEMONIC MUST NEVER REACH THE SYSTEM CLIPBOARD, SO THERE IS NO COPY BUTTON.**
            Both seed screens used to offer one. The modern clipboard is not a local buffer:
            Apple's Universal Clipboard syncs it to every device on the iCloud account (Handoff
            is on by default), Gboard keeps clipboard history by default on Android, Windows
            persists it in Win+V and can sync it to a Microsoft account, and Phone Link mirrors
            Android's clipboard to a PC. On an air-gapped signer that is not a weakened control
            — it is the air gap being bypassed by one tap, to a cloud account, instantly and
            irreversibly. A local clipboard manager or (pre-Android-10) any installed app reads
            it too.

            ⚠️ ChangePassphraseCard already argued that walking a mnemonic "through the screen
            and the clipboard" is "the single most dangerous thing this app can ask anyone to
            do" — that reasoning simply had not been applied to the two screens that did it.
            Found by the 2026-09-18 adversarial pass; pinned by
            malware-on-device.adversarial.test.ts so it cannot come back as a convenience.

            The numbered `SeedWords` grid above IS the capture path: a seed is meant to be
            written down, and transcription is the point rather than a worse alternative.
          */}
          <div className="flex gap-2">
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose}>
              {t('keys.done')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Alert kind="warn">{t('keys.revealWarningPrompt')}</Alert>
          <div>
            <Label>{t('unlock.passphrase')}</Label>
            <PasswordInput
              autoFocus
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error && <Alert kind="error">{error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !pass}>
              {busy ? t('keys.checking') : t('keys.revealSeedButton')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/*
  Removing a key is irreversible on THIS device (though not destructive to funds if its seed
  is backed up — the key still exists in any vault it's enrolled in, and the seed re-imports
  it). To prevent an accidental/autopilot delete of the WRONG key, we require the user to type
  the key's exact identifier — its label, or its fingerprint if the label is blank. Reproducing
  the identifier = deliberate confirmation of *which* key. Case-insensitive, trimmed.
*/
// Cool-off before the destructive button arms — even with the right label typed, a
// host-level attacker at an unattended unlocked device shouldn't be able to remove a
// key in one reflexive click.
//
// ⚠️ 15s, lowered from 30 (user, 2026-08-22). The type-to-confirm above is what identifies
// WHICH key; this timer only has to outlast a reflex, and removing a key is recoverable from
// the seed — unlike the device reset, whose 30s stands because nothing survives it.
const REMOVE_COUNTDOWN_SECS = 15

function RemoveKeyModal({
  entry,
  fingerprint,
  onConfirm,
  onClose,
}: {
  entry: KeyEntry
  fingerprint: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  // Prefer the human label; fall back to the fingerprint for unlabeled keys.
  const target = entry.label.trim() || fingerprint || t('keys.keyFallbackName')
  const usingFingerprint = !entry.label.trim() && !!fingerprint
  const [typed, setTyped] = useState('')
  const matches = typed.trim().toLowerCase() === target.toLowerCase()

  const [countdown, setCountdown] = useState(REMOVE_COUNTDOWN_SECS)
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

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (armed) onConfirm() // parent unmounts the card → modal on remove
  }

  return (
    <Modal open onClose={onClose} title={t('keys.removeModalTitle')}>
      <form onSubmit={submit} className="space-y-4">
        <Alert kind="warn">
          {t('keys.removeWarningPrefix')} <strong>{target}</strong> {t('keys.removeWarningMiddle')}{' '}
          <strong>{t('keys.removeWarningStrong')}</strong> {t('keys.removeWarningSuffix')}
        </Alert>
        <div>
          <Label>
            {usingFingerprint ? t('keys.removeConfirmLabelFingerprint') : t('keys.removeConfirmLabelName')}
          </Label>
          {/* Echo the exact string to type, in its TRUE case — no `uppercase` here (matching is
              case-insensitive, but showing it uppercased next to the natural-case placeholder read
              as two different values). The <Label> above is the app-wide uppercase heading style. */}
          <div className="mb-1.5 font-mono text-xs text-ink">
            {target}
          </div>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={target}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="danger" disabled={!armed}>
            {countdown > 0 ? t('keys.removeKeyButtonCountdown', { seconds: countdown }) : t('keys.removeKeyButton')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/*
  The enrollment export — PUBLIC key material only. The `xpub`/`fingerprint`/`path` trio is
  exactly what the platform's vault-create expects (same fields the copy button already used);
  we wrap it in a small self-describing envelope (type marker + label + network) so the saved
  file is clearly a SignBit companion key. UI-only for now — no platform change; the .json is
  the artifact a future "import your companion key" step in vault creation would read.
*/
function enrollmentJson(entry: KeyEntry, pub: AccountKey): string {
  return JSON.stringify(
    {
      type: 'signbit-companion-key',
      version: 1,
      label: entry.label,
      /*
        Derived from the EXPORTED ARTIFACT (its coin type), not from entry.network — so the
        label and the xpub in this file can never disagree. If the stamp were ever wrong, using
        it here would produce a file that confidently mislabels a mainnet xpub as testnet;
        reading it off the path makes the file internally consistent by construction.

        Read from the path rather than the key prefix: `tpub` is not the only testnet prefix
        (Vpub/Upub exist), so a prefix test would call those mainnet.
      */
      network: coinTypeOfPath(pub.derivationPath) === 0 ? 'mainnet' : 'testnet',
      xpub: pub.tpub,
      fingerprint: pub.masterFingerprint,
      path: pub.derivationPath,
    },
    null,
    2,
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Mono className="flex-1">{value}</Mono>
        <CopyButton value={value} />
      </div>
    </div>
  )
}
