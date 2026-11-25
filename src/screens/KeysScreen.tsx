import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useKeystore } from '../lib/keystore'
import type { NetworkName } from '../lib/key'
import { Button, Card, Input, PasswordInput, Label, Alert, Mono, CopyButton, CopyInline, Modal, SeedPhraseInput } from '../components/ui'
import { analyzeMnemonic, networkOf } from '../lib/key'
import type { KeyEntry } from '../lib/crypto'
import { saveTextFile, saveTextFilesToDir, planKeyExports, defaultKeyExportFilename } from '../lib/download'
import { IS_MOBILE } from '../lib/platform'
import type { AccountKey } from '../lib/key'
import { multisigAccountPath, coinTypeOfPath, xpubPrefix } from '../lib/bitcoin-network'
import { toMultisigSlip132 } from '../lib/build-descriptor'
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
  /*
    Which key the account header card shows. Display state only: nothing here signs, and the
    Sign screen keeps its own deliberate picker. Falls back to the first key, so a removed or
    not-yet-chosen selection never leaves the card empty.
  */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = entries.find((e) => e.id === selectedId) ?? entries[0]

  useEffect(() => {
    if (openGuideOnMount) onGuideOpened?.()
    // Only meant to run once on mount (see openGuideOnMount's own doc) — the effect's
    // dependency array is deliberately empty-equivalent here, not tracking these props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-6">
      {/* Screen header = title + count + the setup-guide trigger. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-[-0.03em] text-ink">{t('keys.title')}</h2>
          <span className="inline-flex h-5 items-center border border-line px-1.5 font-mono text-xs font-semibold leading-none tabular-nums text-ink-muted">
            {entries.length}
          </span>
          {/* A neutral square chip, not an orange one: orange on this screen is Create key. */}
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            aria-label={t('keys.guideTitle')}
            title={t('keys.guideTitle')}
            className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center border border-line text-ink-muted transition-colors hover:border-ink/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:h-8 sm:w-8"
          >
            <HelpIcon className="h-4 w-4" />
          </button>
        </div>
        {/* The prefix follows the network (tpub on testnet, xpub on mainnet) — naming a
            prefix the user won't see on their own key card is worse than saying nothing. */}
        <p className="text-sm text-ink-muted">{t('keys.subtitle', { prefix: xpubPrefix(network) })}</p>
      </div>

      {/* Create panel = the primary create/import actions, with the bulk export as its ruled footer. */}
      <div className="card overflow-hidden animate-fade-in-up">
        <div className="p-4 sm:p-5">
          <CreateBar
            onCreate={async (label) => {
              setError(null)
              try {
                // New keys are stamped with the network the app is CURRENTLY on — the one moment
                // the global setting is the right source. From here on the key carries its own.
                const created = await createKey(label, network)
                setReveal(created)
                setSelectedId(created.id)
              } catch (e) {
                setError((e as Error).message)
              }
            }}
            onImport={async (label, mnemonic) => {
              const imported = await importKey(label, mnemonic, network)
              setSelectedId(imported.id)
              return imported
            }}
            network={network}
          />
        </div>
        {/* Export ALL public keys — one .json per key, into a folder the user picks once.
            Only offered once there is more than one key: with a single key the per-key
            "Export file" already IS this, and a second route to it is just a second button.
            No hint text under the button — the modal it opens says the same thing at the
            moment it matters, with the real file count. */}
        {/* ⚠️ Not on a phone: it needs a FOLDER picker, which the dialog plugin does not have
            on Android or iOS (it fails with "folder picker not implemented"). Each key's own
            Export file still works there (iOS readiness, 2026-11-12). */}
        {entries.length > 1 && !IS_MOBILE && (
          <div className="border-t border-line px-4 py-3 sm:px-5">
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
      </div>

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
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center border border-line text-ink-muted">
            <KeyGlyph className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{t('keys.emptyTitle')}</p>
          <p className="max-w-xs text-sm text-ink-muted">{t('keys.emptySubtitle')}</p>
        </Card>
      ) : (
        /*
          The keys as ONE ruled ledger (a row per key), and the selected key's identity as the
          account header card beside it. Stacked on a phone, ledger first: with the handful of
          keys a vault needs the rows are short, so the card a tap selects sits right below
          them rather than off screen.
        */
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
          <ul className="card divide-y divide-line overflow-hidden animate-fade-in-up">
            {entries.map((e) => (
              <KeyRow
                key={e.id}
                entry={e}
                network={network}
                selected={e.id === selected?.id}
                onSelect={() => setSelectedId(e.id)}
              />
            ))}
          </ul>
          {/* `key` remounts the card per key, so a half-typed rename or an open modal for one
              key can never carry over onto another. */}
          {selected && (
            <KeyCard key={selected.id} entry={selected} onRemove={() => removeKey(selected.id)} />
          )}
        </div>
      )}
    </div>
  )
}

/*
  One row of the key ledger: label, fingerprint, and the mainnet mark. Selecting it fills the
  account header card; the row itself changes nothing.

  Only MAINNET is marked: it is the exception, and the one where being wrong costs money.
  Giving testnet an equal-weight tag made the ordinary case shout as loudly as the notable one
  and crowded the fingerprint, which is the real identity here. A key that isn't on the app's
  current network is dimmed rather than captioned — it still works (it derives at its own
  stamp); it just isn't the current context.
*/
function KeyRow({
  entry,
  network,
  selected,
  onSelect,
}: {
  entry: KeyEntry
  /** The app's CURRENT network — used only to dim a key that doesn't match it. */
  network: NetworkName
  selected: boolean
  onSelect: () => void
}) {
  const { exportPublic } = useKeystore()
  const { t } = useI18n()
  const keyNetwork = networkOf(entry)
  const offNetwork = keyNetwork !== network
  let fingerprint: string | null = null
  try {
    fingerprint = exportPublic(entry.id).masterFingerprint
  } catch {
    fingerprint = null
  }
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'relative flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.025] sm:px-5',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
          selected && 'bg-ink/[0.025]',
        )}
      >
        {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-brand-500" />}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-line text-ink-muted">
          <KeyGlyph className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cx(
              'block truncate text-sm',
              selected ? 'font-semibold' : 'font-medium',
              offNetwork ? 'text-ink-muted' : 'text-ink',
            )}
          >
            {entry.label || t('keys.keyFallbackName')}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {fingerprint && (
              <span className="font-mono text-xs uppercase tracking-wide tabular-nums text-ink-muted">{fingerprint}</span>
            )}
            {keyNetwork === 'mainnet' && (
              <span className="inline-flex h-5 shrink-0 items-center border border-ink/40 px-1.5 text-xs font-semibold leading-none text-ink">
                {keyNetwork}
              </span>
            )}
          </span>
        </span>
        <span className="hidden shrink-0 text-xs tabular-nums text-ink-muted sm:block">
          {new Date(entry.createdAt).toLocaleDateString()}
        </span>
      </button>
    </li>
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
      {/* A ruled list on the page surface: the modal is itself a card, so a card-coloured
          fill on these rows would not show. */}
      <ul className="mt-3 divide-y divide-line border border-line bg-surface text-sm">
        <li className="flex items-start gap-2 px-3 py-2.5">
          <span aria-hidden="true" className="mt-px text-ink-muted">✓</span>
          <span className="text-ink">{t('keys.guideScript')}</span>
        </li>
        <li className="flex items-start gap-2 px-3 py-2.5">
          <span aria-hidden="true" className="mt-px text-ink-muted">✓</span>
          <span className="text-ink">{t('keys.guidePath', { path: multisigAccountPath(network) })}</span>
        </li>
        <li className="flex items-start gap-2 px-3 py-2.5">
          <span aria-hidden="true" className="mt-px text-ink-muted">✓</span>
          <span className="text-ink">{t('keys.guideNetwork', { network, prefix: xpubPrefix(network) })}</span>
        </li>
        <li className="flex items-start gap-2 px-3 py-2.5">
          <span aria-hidden="true" className="mt-px text-ink-muted">✓</span>
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* The network the new key will be stamped with, attached to the field it applies to.
            A solid square tag joined to the input: full ink for mainnet (the default, real
            money), muted for test networks. No orange fill, since orange on this screen is the
            Create action. No banner: it would be noise. */}
        <div className="flex w-full sm:w-72">
          <span
            className={[
              'inline-flex shrink-0 items-center border border-r-0 border-line bg-surface px-2.5 text-xs font-semibold',
              network === 'mainnet' ? 'text-ink' : 'text-ink-muted',
            ].join(' ')}
          >
            {network}
          </span>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('keys.newKeyLabelPlaceholder')}
            className="min-w-0"
          />
        </div>
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

/* Seed-phrase word grid — shared by the post-create backup + the reveal-again modals.
   Numbered DOWN each column, then across, in THREE columns at every width (user, 2026-10-03):
   a 24-word phrase reads 1–8, 9–16, 17–24, the way most wallets and paper backup cards lay it
   out; a 12-word one reads 1–4, 5–8, 9–12. */
/* How long the words stay on screen before the modal closes itself (user, 2026-10-03), so a
   phrase is never left showing on an unattended screen. The first backup gets longer because
   24 words are being written on paper; closing early loses nothing, since "Reveal seed"
   shows them again behind the passphrase. */
const SEED_AUTO_CLOSE_MS = { backup: 5 * 60_000, reveal: 2 * 60_000 }

function SeedWords({ mnemonic, entry, closeAfterMs, onExpire }: {
  mnemonic: string
  entry: KeyEntry
  closeAfterMs: number
  onExpire: () => void
}) {
  const { t } = useI18n()
  const [left, setLeft] = useState(closeAfterMs)
  const expire = useRef(onExpire)
  expire.current = onExpire
  useEffect(() => {
    const end = Date.now() + closeAfterMs
    const id = setInterval(() => {
      const ms = end - Date.now()
      if (ms <= 0) {
        clearInterval(id)
        expire.current()
      } else setLeft(ms)
    }, 1000)
    return () => clearInterval(id)
  }, [closeAfterMs])
  const secs = Math.ceil(left / 1000)
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  const words = mnemonic.split(' ')
  const rows = { gridTemplateRows: `repeat(${Math.ceil(words.length / 3)}, auto)` } as CSSProperties
  return (
    <div className="space-y-2">
      <div
        style={rows}
        className="grid grid-flow-col grid-cols-3 gap-2"
      >
        {/* flex-wrap: on the narrowest phones the number moves above its word rather than
            the word breaking, since a seed word must be copied down whole. */}
        {words.map((w, i) => (
          <div key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 border border-line bg-surface px-2 py-1.5">
            <span className="font-mono text-xs tabular-nums text-ink-muted">{i + 1}</span>
            <span className="font-mono text-xs font-medium text-ink">{w}</span>
          </div>
        ))}
      </div>
      {/* The path goes WITH the words (user, 2026-10-03): restoring this key in another wallet
          needs both, and a backup that records only the words leaves the user to guess. */}
      <p className="font-mono text-xs text-ink-muted">
        {t('keys.guidePath', { path: multisigAccountPath(networkOf(entry)) })}
      </p>
      <p className="text-xs text-ink-muted">{t('keys.seedAutoHide', { time })}</p>
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
        <SeedWords mnemonic={entry.mnemonic} entry={entry} closeAfterMs={SEED_AUTO_CLOSE_MS.backup} onExpire={onDone} />
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

/*
  The selected key's identity as an ACCOUNT HEADER CARD: the label, then a strip of labelled
  cells (fingerprint, network, added, public key), then the per-key actions.
*/
function KeyCard({
  entry,
  onRemove,
}: {
  entry: KeyEntry
  onRemove: () => void
}) {
  // What this key actually derives at, for good. Everything key-specific reads this.
  const keyNetwork = networkOf(entry)
  const { exportPublic, renameKey } = useKeystore()
  const { t } = useI18n()
  const [showingPub, setShowingPub] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [labelDraft, setLabelDraft] = useState(entry.label)
  const [renameErr, setRenameErr] = useState<string | null>(null)

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
  // derive + show it eagerly (we're unlocked). The public key is shown here too, read-only,
  // as part of that identity; copying and exporting it stay behind "Show public key", whose
  // modal carries the "this is a key, not an address" note a first-timer needs at that moment.
  let pub: AccountKey | null = null
  try {
    pub = exportPublic(entry.id)
  } catch {
    pub = null
  }
  const fingerprint = pub ? pub.masterFingerprint : null
  const added = new Date(entry.createdAt).toLocaleDateString()
  const addedLabel = t('keys.added')

  return (
    <section className="card overflow-hidden border-t-2 border-t-brand-500 animate-fade-in-up">
      {/* Identity row: neutral glyph chip + label, with Remove tucked to the side.
          The label swaps to an inline edit (Input + Save/Cancel) via the pencil trigger —
          renaming only changes the label; id/mnemonic/derivation are untouched. */}
      <div className="flex items-start justify-between gap-2 px-4 pb-4 pt-5 sm:px-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-line text-ink-muted">
            <KeyGlyph className="h-5 w-5" />
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
                  <Button variant="secondary" className="min-h-9 px-2.5 py-1 text-xs" onClick={saveRename}>
                    {t('keys.renameSave')}
                  </Button>
                  <Button variant="ghost" className="min-h-9 px-2.5 py-1 text-xs" onClick={() => setRenaming(false)}>
                    {t('keys.renameCancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-10 items-center gap-1.5">
                <h3 className="truncate text-lg font-semibold tracking-[-0.02em] text-ink">{entry.label}</h3>
                <button
                  type="button"
                  onClick={startRename}
                  aria-label={t('keys.rename')}
                  title={t('keys.rename')}
                  className="-m-2 shrink-0 p-2 text-ink-muted transition-colors hover:text-ink"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
        <Button variant="ghost" className="min-h-9 shrink-0 px-2 py-1 text-xs" onClick={() => setRemoving(true)}>
          {t('keys.remove')}
        </Button>
      </div>

      {/* The labelled cells. Network is the KEY'S stamp, never the app's toggle. Fixed
          placement, so the hairlines between cells are drawn per cell: two columns on a phone
          (the date and the public key each take a full row), three from `sm`. */}
      <dl className="grid grid-cols-2 border-t border-line sm:grid-cols-3">
        {fingerprint && (
          <div className="min-w-0 px-4 py-3 sm:px-5">
            <dt className="text-[13px] text-ink-muted">{t('keys.fingerprint')}</dt>
            <dd className="mt-0.5 flex items-center gap-2">
              <span className="font-mono text-[15px] font-semibold uppercase tabular-nums tracking-wide text-ink">
                {fingerprint}
              </span>
              <CopyInline value={fingerprint} label={t('common.copy')} />
            </dd>
          </div>
        )}
        <div className={cx('min-w-0 px-4 py-3 sm:px-5', fingerprint && 'border-l border-line')}>
          <dt className="text-[13px] text-ink-muted">{t('settings.network.label')}</dt>
          <dd className="mt-0.5 text-[15px] font-semibold text-ink">{keyNetwork}</dd>
        </div>
        <div
          className={cx(
            'min-w-0 px-4 py-3 sm:px-5',
            fingerprint
              ? 'col-span-2 border-t border-line sm:col-span-1 sm:border-l sm:border-t-0'
              : 'border-l border-line sm:col-span-2',
          )}
        >
          <dt className="text-[13px] text-ink-muted">{addedLabel}</dt>
          <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">{added}</dd>
        </div>
        {pub && (
          <div className="col-span-2 min-w-0 border-t border-line px-4 py-3 sm:col-span-3 sm:px-5">
            {/* The same small copy control as the fingerprint's, beside the label: the key is
                too long to sit next to, and it is the one string a vault builder needs. */}
            <dt className="flex items-center gap-2 text-[13px] text-ink-muted">
              {t('keys.accountTpub')}
              <CopyInline value={pub.tpub} label={t('common.copy')} />
            </dt>
            <dd className="mt-0.5">
              <Mono className="block leading-relaxed">{pub.tpub}</Mono>
            </dd>
          </div>
        )}
      </dl>

      {/* The KEY'S network, not the app's — a testnet key must not advertise "mainnet" just
          because the toggle happens to sit there. */}
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <Button variant="secondary" className="w-full sm:w-auto" onClick={() => setShowingPub(true)}>
          {t('keys.showPublicKey', { network: keyNetwork })}
        </Button>
        <Button variant="ghost" className="w-full sm:w-auto" onClick={() => setRevealing(true)}>
          {t('keys.revealSeed')}
        </Button>
      </div>

      {showingPub && (
        <PublicKeyModal entry={entry} exportPublic={exportPublic} onClose={() => setShowingPub(false)} />
      )}
      {revealing && <RevealSeedModal entry={entry} onClose={() => setRevealing(false)} />}
      {removing && (
        <RemoveKeyModal
          entry={entry}
          fingerprint={fingerprint}
          onConfirm={onRemove}
          onClose={() => setRemoving(false)}
        />
      )}
    </section>
  )
}

/*
  Public-key reveal — a Modal rather than expanding the card in place. The fingerprint/tpub/
  export-actions block used to grow the card inline, which desynced card heights within the
  old grid of key cards (one taller card, several short neighbors — a jumbled-looking grid).
  The account header card now shows the public key read-only; this modal stays the one place
  it is copied or exported, beside the note that it is not an address — same pattern as every
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
  const [showOther, setShowOther] = useState(false)

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
            {/* 🔰 For beginners (user, 2026-09-27): this is a KEY, not an ADDRESS. No wallet will
                actually send to an xpub (it isn't an address format), but someone new can still
                mistake it for "where my bitcoin goes" and hand it to a payer. Inline, not a hover:
                a hover is exactly what a first-timer never finds. */}
            <Alert kind="info">{t('keys.publicKeyNotAddress')}</Alert>
            {/* One ruled panel of fields, on the page surface (the modal is itself a card). */}
            <div className="divide-y divide-line border border-line bg-surface">
              <Field label={t('keys.fingerprint')} value={pub.masterFingerprint} />
              <Field label={t('keys.accountTpub')} value={pub.tpub} />
              <Field label={t('settings.network.label')} value={networkOf(entry)} />
              {/* ⚠️ Shown WITH `m/`, the form Electrum and Sparrow ask for (user, 2026-09-25). Out of
                  the disclosure by default (user, 2026-10-03): the path is part of the key. */}
              <Field label={t('keys.derivationPath')} value={`m/${pub.derivationPath.replace(/^m\//, '')}`} />
            </div>
            {/* 🔰 The other-wallet forms sit behind a CLOSED disclosure (user, 2026-09-30: jargon
                hidden from the average user, mirroring the platform's create-vault guide). SignBit
                needs only the key file below; these exist for Electrum/Sparrow cosigner steps. */}
            <button
              type="button"
              onClick={() => setShowOther((v) => !v)}
              aria-expanded={showOther}
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-ink underline-offset-2 hover:underline sm:min-h-0"
            >
              <span aria-hidden="true" className="text-ink-muted">{showOther ? '▾' : '▸'}</span> {t('keys.otherWalletsToggle')}
            </button>
            {showOther && (
              <div className="divide-y divide-line border border-line bg-surface">
                {/* The same key in the SLIP-132 multisig encoding (Vpub/Zpub) — what Electrum's
                    cosigner step asks for. Display only; the enrollment file keeps the canonical key. */}
                <Field
                  label={t('keys.accountSlip132', { prefix: networkOf(entry) === 'mainnet' ? 'Zpub' : 'Vpub' })}
                  value={toMultisigSlip132(pub.tpub, networkOf(entry))}
                />
                <Field label={t('keys.scriptType')} value={t('keys.scriptTypeP2wsh')} />
              </div>
            )}
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
          <SeedWords mnemonic={seed} entry={entry} closeAfterMs={SEED_AUTO_CLOSE_MS.reveal} onExpire={onClose} />
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
            <Button variant="secondary" onClick={onClose}>
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

/* One row of a ruled field panel: label above, the value in mono with its copy action. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5">
      <Label>{label}</Label>
      <div className="flex items-start gap-2">
        <Mono className="min-w-0 flex-1 leading-relaxed">{value}</Mono>
        <CopyButton value={value} />
      </div>
    </div>
  )
}
