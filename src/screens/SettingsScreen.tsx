import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { NetworkName } from '../lib/key'
import { Button, Card, Label, Alert, Mono, Modal } from '../components/ui'
import { storageInfo, type StorageInfo } from '../lib/storage'
import { version } from '../../package.json'
import {
  readSettings,
  writeSettings,
  type AutoLockMinutes,
  type ThemePref,
} from '../lib/activity'
import { useI18n } from '../i18n'
import { LocaleSwitcher } from '../components/LocaleSwitcher'
import { BackupCard } from '../components/BackupCard'
import { ChangePassphraseCard } from '../components/ChangePassphraseCard'

/*
  Settings — network toggle, auto-lock, air-gap check, and version.

  Mainnet is LIVE here. Switching TO it is confirmed (real funds, and the keys are held in a
  software keystore on this device — not dedicated signing hardware); switching back to testnet
  is free, since that direction can only reduce what is at stake.
*/
export function SettingsScreen({
  network,
  onNetworkChange,
  settingsCorrupted,
  autoLockMinutes,
  onAutoLockChange,
  theme,
  onThemeChange,
  onOpenBackupTransfer,
}: {
  network: NetworkName
  onNetworkChange: (n: NetworkName) => void
  /** Stored settings were unreadable and the network fell back to testnet — say so. */
  settingsCorrupted?: boolean
  autoLockMinutes: AutoLockMinutes
  onAutoLockChange: (m: AutoLockMinutes) => void
  theme: ThemePref
  onThemeChange: (t: ThemePref) => void
  /** Open the full-screen import/compare view (owned by App, so it replaces the whole tab). */
  onOpenBackupTransfer: (mode: 'import' | 'compare') => void
}) {
  const { t } = useI18n()
  const [confirmingMainnet, setConfirmingMainnet] = useState(false)
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('settings.title')}</h2>
        <p className="text-sm text-ink-muted">{t('settings.subtitle')}</p>
      </div>

      {/* Phone/tablet: one column of cards. lg+: multi-column so a wide screen isn't a single
          narrow strip (the widescreen rule).

          ⚠️ CSS COLUMNS, not grid, on purpose. These cards have very different natural heights
          (a one-line version row vs. the Backup card's warning + button + hint). A grid fills
          ROW BY ROW, so every card in a row is pinned to the tallest one's row height and the
          shorter ones leave dead space beneath them — which is what made this look broken on a
          wide screen. Columns flow MASONRY-style: each card takes only the height it needs and
          the next one packs directly under it. `break-inside-avoid` stops a card being split
          across a column boundary, and the wrapper's own `space-y` is replaced by a per-child
          bottom margin (columns don't participate in flex/grid gap).

          TWO columns is the ceiling, deliberately — NOT three at 2xl. These are short controls,
          so more columns just makes each one wider and emptier while pushing the last cards far
          from the heading. The width cap does the rest of the work: the page container grows to
          110rem at 2xl, which is far wider than settings content deserves. */}
      <div className="mx-auto w-full max-w-6xl gap-6 lg:columns-2 [&>*]:mb-6 [&>*]:break-inside-avoid [&>*:last-child]:mb-0">
      <Card className="space-y-3">
        <Label>{t('settings.network.label')}</Label>
        <div className="inline-flex border border-line">
          {/* Mainnet first: it is the default for a fresh install (§7) and what almost every
              user is on, so it reads as the primary choice rather than the afterthought. The
              confirm gate below keys off the NAME, not the position — reordering these is
              safe and does not change which direction is guarded. */}
          {(['mainnet', 'testnet'] as NetworkName[]).map((n) => {
            const active = network === n
            return (
              <button
                key={n}
                onClick={() => {
                  if (active) return
                  // Only the direction that RAISES the stakes is confirmed.
                  if (n === 'mainnet') setConfirmingMainnet(true)
                  else onNetworkChange(n)
                }}
                className={[
                  'min-h-11 px-4 py-2 text-sm capitalize transition-colors sm:min-h-0',
                  active ? 'is-active' : 'is-idle',
                ].join(' ')}
              >
                {n}
              </button>
            )
          })}
        </div>
        {settingsCorrupted && <Alert kind="warn">{t('settings.network.corrupted')}</Alert>}
        {/* Both states are `info`: this states which network is selected, which the user chose
            and already knows. The CAUTION about mainnet belongs at the moment of switching (the
            confirm modal below), not as a banner that sits here forever — a warning the user
            has already accepted and cannot act on stops being read. */}
        <Alert kind="info">
          {network === 'mainnet' ? t('settings.network.onMainnet') : t('settings.network.onTestnet')}
        </Alert>
        {/* Existing keys are unaffected by this switch — they derive at their own stamp. Said
            here because the opposite is the intuitive assumption, and acting on it (expecting a
            key's xpub to follow the toggle) is how someone enrolls the wrong key. */}
        <p className="text-xs text-ink-muted">{t('settings.network.keysUnaffected')}</p>
      </Card>

      {confirmingMainnet && (
        <MainnetConfirmModal
          onConfirm={() => {
            onNetworkChange('mainnet')
            setConfirmingMainnet(false)
          }}
          onClose={() => setConfirmingMainnet(false)}
        />
      )}

      <Appearance theme={theme} onChange={onThemeChange} />

      <Language />

      <AutoLock minutes={autoLockMinutes} onChange={onAutoLockChange} />


      <Storage />

      <BackupCard onOpenTransfer={onOpenBackupTransfer} />

      {/* Sits directly after Backup on purpose: changing the passphrase leaves every existing
          backup file on the OLD one, so the two belong next to each other in the reading order. */}
      <ChangePassphraseCard />

      {/* No `space-y-3`: the card is a SINGLE row now, so there are no siblings to space. */}
      <Card>
        {/*
          WHO MADE THIS. Fountain carried NO reference to signbit.io anywhere (verified by
          grep, 2026-08-16), so someone handed the exe on a USB stick had nothing in the app
          tying it back to us.

          🚨 NOW CLICKABLE (user, 2026-08-19) — and the AIR GAP IS STILL INTACT, but ONLY
          because of HOW. Read this before changing it to a plain <a href>.
          · `openUrl()` hands the URL to the OS default browser, in a SEPARATE PROCESS.
            Fountain itself opens no socket, and its WebView never navigates.
          · A bare <a href="https://signbit.io"> is the WRONG implementation: the WebView
            would try to navigate ITSELF to a remote origin, which is exactly the thing this
            app must never do. `opener:default` is already in capabilities/, so no new
            permission was granted for this.
          · Therefore: it is a <button>, not an anchor. It only LOOKS like a link. Do not
            "tidy" it into an <a> — that silently converts a safe out-of-process handoff
            into in-app remote navigation.

          ⚠️ The checksum/verify hint was REMOVED in the same change (user). What remains is
          attribution, not a provenance claim — which is honest, since on-screen text never
          could verify provenance anyway (a fake prints the same string). Real verification is
          a published SHA-256 + a signed binary (LAUNCH #14).

          ⚠️ The domain is still NOT in the wordmark — considered and rejected, see
          docs/internal/roadmap.md. A domain baked into the icon and exe metadata rots in
          every copy already shipped and cannot be recalled from a USB stick. Being clickable
          HERE does not reopen that question.
        */}
        {/* ⚠️ TWO ROWS, not a left column with a right-hand value (user, 2026-08-19):
            row 1 = the credit, CENTERED on its own full width;
            row 2 = signbit.io left, v0.5.7 right, at the SAME text size.
            ⚠️ The centering only works because row 1 is its own block — putting the credit in
            a flex row beside anything makes `text-center` centre it within its own box, not
            on the card, which reads as slightly-off-left rather than centered.
            ⚠️ Row 2's two items must stay the same size (`text-[11px]` on both). They read as
            a matched pair — a subtle footer line — and bumping either one alone turns it back
            into a label-and-value row, which is what this replaced. */}
        <div className="space-y-1.5">
          <div className="text-center text-sm text-ink">{t('settings.version.publisher')}</div>
          <div className="flex items-baseline justify-between gap-3">
            <button
              type="button"
              onClick={() => { void openUrl('https://signbit.io') }}
              className="font-mono text-[11px] text-brand underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {t('settings.version.domain')}
            </button>
            {/* `items-baseline` on the row + matching size sits the version on the same
                typographic line as the domain, rather than optically half a pixel high. */}
            <span className="shrink-0 font-mono text-[11px] text-ink-muted">v{version}</span>
          </div>
        </div>
      </Card>
      </div>
    </div>
  )
}

/*
  The one gate on the way to real money.

  Deliberately a single Continue, NOT a type-to-confirm: this is reversible (switch back any
  time), it destroys nothing, and stacking the same ceremony used for RESET/OVERWRITE on a
  reversible preference is how people learn to clear those gates unread. What it must do is
  state the two things a user cannot infer from a toggle labelled "mainnet" — that keys here
  live in a software keystore rather than dedicated hardware, and that a key made from now on
  is stamped mainnet for good.
*/
function MainnetConfirmModal({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Modal open onClose={onClose} title={t('settings.network.confirmTitle')}>
      <div className="space-y-4">
        <Alert kind="warn">{t('settings.network.confirmReal')}</Alert>
        <p className="text-sm text-ink-muted">{t('settings.network.confirmKeystore')}</p>
        <p className="text-sm text-ink-muted">{t('settings.network.confirmStamp')}</p>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button className="w-full sm:w-auto" onClick={onConfirm}>
            {t('settings.network.confirmAction')}
          </Button>
          <Button variant="secondary" className="w-full sm:w-auto" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Language() {
  const { t } = useI18n()
  return (
    <Card className="space-y-3">
      <div>
        <Label>{t('settings.language.label')}</Label>
        <p className="text-xs text-ink-muted">{t('settings.language.hint')}</p>
      </div>
      <LocaleSwitcher />
    </Card>
  )
}

/*
  Appearance — light / dark / system theme. 'System' follows the OS preference. The choice is
  applied to <html> in App's `useTheme` (Tailwind darkMode:'class'); here we pick + persist it.
*/
const THEME_OPTION_KEYS: { value: ThemePref; labelKey: string }[] = [
  { value: 'light', labelKey: 'settings.appearance.light' },
  { value: 'dark', labelKey: 'settings.appearance.dark' },
  { value: 'system', labelKey: 'settings.appearance.system' },
]

function Appearance({ theme, onChange }: { theme: ThemePref; onChange: (t: ThemePref) => void }) {
  const { t } = useI18n()
  return (
    <Card className="space-y-3">
      <div>
        <Label>{t('settings.appearance.label')}</Label>
        <p className="text-xs text-ink-muted">{t('settings.appearance.hint')}</p>
      </div>
      <div className="inline-flex flex-wrap border border-line">
        {THEME_OPTION_KEYS.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              onChange(o.value)
              writeSettings({ ...readSettings(), theme: o.value })
            }}
            className={['min-h-11 px-4 py-2 text-sm transition-colors sm:min-h-0', theme === o.value ? 'is-active' : 'is-idle'].join(' ')}
          >
            {t(o.labelKey)}
          </button>
        ))}
      </div>
    </Card>
  )
}

/*
  Auto-lock on inactivity — locks the keystore after N idle minutes, shrinking the window
  where an unlocked host is exposed. The timer itself lives in App's `useAutoLock`; here we
  just pick + persist the preference (non-secret).
*/
const AUTO_LOCK_OPTION_KEYS: { value: AutoLockMinutes; labelKey: string }[] = [
  { value: 1, labelKey: 'settings.autoLock.min1' },
  { value: 5, labelKey: 'settings.autoLock.min5' },
  { value: 15, labelKey: 'settings.autoLock.min15' },
  { value: 30, labelKey: 'settings.autoLock.min30' },
  { value: 0, labelKey: 'settings.autoLock.never' },
]

function AutoLock({ minutes, onChange }: { minutes: AutoLockMinutes; onChange: (m: AutoLockMinutes) => void }) {
  const { t } = useI18n()
  return (
    <Card className="space-y-3">
      <div>
        <Label>{t('settings.autoLock.label')}</Label>
        <p className="text-xs text-ink-muted">{t('settings.autoLock.hint')}</p>
      </div>
      <div className="inline-flex flex-wrap border border-line">
        {AUTO_LOCK_OPTION_KEYS.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              onChange(o.value)
              writeSettings({ ...readSettings(), autoLockMinutes: o.value })
            }}
            className={[
              'min-h-11 px-3 py-2 text-sm transition-colors sm:min-h-0',
              minutes === o.value ? 'is-active' : 'is-idle',
            ].join(' ')}
          >
            {t(o.labelKey)}
          </button>
        ))}
      </div>
      {minutes === 0 && <Alert kind="warn">{t('settings.autoLock.offWarning')}</Alert>}
    </Card>
  )
}

/*
  Storage location — shows WHERE the encrypted keystore lives so a portable (USB) build can be
  confirmed at a glance. PORTABLE = a `data/` folder next to the app (keys travel with it);
  otherwise the per-user OS config dir. Resolved in Rust (portable-if-writable, else default).
  In a plain browser tab (`npm run dev`) there's no Tauri shell, so we say so instead.
*/
function Storage() {
  const { t } = useI18n()
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    storageInfo()
      .then(setInfo)
      .catch(() => setUnavailable(true)) // no Tauri shell (browser dev) — nothing to report
  }, [])

  return (
    <Card className="space-y-3">
      <div>
        <Label>{t('settings.storage.label')}</Label>
        <p className="text-xs text-ink-muted">{t('settings.storage.hint')}</p>
      </div>
      {unavailable ? (
        <Alert kind="warn">
          {t('settings.storage.unavailablePrefix')} <Mono>npm run tauri dev</Mono>{t('settings.storage.unavailableSuffix')}
        </Alert>
      ) : !info ? (
        <p className="text-sm text-ink-muted">{t('settings.storage.checking')}</p>
      ) : (
        <div className="space-y-2">
          {/* Stack the badge above its note on a phone (they cram side-by-side below sm);
              align them on one row from sm up. */}
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span
              className={[
                'inline-flex w-fit items-center border px-2 py-0.5 text-xs font-medium',
                info.portable
                  ? 'border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400'
                  : 'border-line text-ink-muted',
              ].join(' ')}
            >
              {info.portable ? t('settings.storage.portable') : t('settings.storage.default')}
            </span>
            <span className="text-xs text-ink-muted">
              {info.portable ? t('settings.storage.portableNote') : t('settings.storage.defaultNote')}
            </span>
          </div>
          {/* The path can be long; give it its own bordered, scroll-safe block so it never
              pushes the card wider than the phone screen. */}
          <Mono className="block break-all border border-line/60 bg-surface-2 px-2 py-1.5 text-xs text-ink-muted">
            {info.dir}
          </Mono>
          {info.portable && (
            <Alert kind="warn">
              {t('settings.storage.portableWarningPrefix')} <strong>{t('settings.storage.portableWarningStrong')}</strong>{' '}
              {t('settings.storage.portableWarningSuffix')}
            </Alert>
          )}
        </div>
      )}
    </Card>
  )
}

/*
  THERE IS NO AIR-GAP "CHECK" BUTTON, AND ADDING ONE BACK WOULD BE A MISTAKE.

  🚨 This screen used to offer one. It worked by making a real outbound request (a HEAD to a
  neutral host) and treating a FAILURE as proof of an air gap — which inverts the moment the
  app stops being able to make requests at all. It cannot any more: `connect-src 'self'` in the
  CSP blocks the fetch, and the Android release manifest removes the INTERNET permission
  outright. The probe therefore threw every time, the catch returned "offline", and the card
  cheerfully reported "Offline confirmed. This device is fully air-gapped" to someone sitting
  on Wi-Fi.

  ⚠️ A FALSE REASSURANCE ON A SECURITY SCREEN IS WORSE THAN NO REASSURANCE. The user asked the
  one question the app had just stopped being able to answer, and got a confident wrong answer.

  ⚠️ IT CANNOT BE REPAIRED, ONLY REINSTATED BY WEAKENING THE APP. A probe that works needs the
  app to be able to reach the network — the exact capability that was removed to make the air
  gap real. An app that CANNOT talk to the network is a stronger guarantee than one that can
  and reports that it didn't, so the guarantee replaces the check rather than losing to it.
  Whether the MACHINE is offline is the operating system's question, and the user answers it by
  turning networking off, which is what an air gap always actually was.
*/
