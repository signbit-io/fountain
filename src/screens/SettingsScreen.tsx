import { useEffect, useState, type ReactNode } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { NetworkName } from '../lib/key'
import { Button, Card, Alert, Mono, Modal, SegmentedGroup, segmentClass, Switch } from '../components/ui'
import { storageInfo, type StorageInfo } from '../lib/storage'
import { version } from '../../package.json'
import {
  readSettings,
  readMotion,
  writeMotion,
  applyMotion,
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
        <h2 className="text-2xl font-semibold tracking-[-0.03em] text-ink">{t('settings.title')}</h2>
        <p className="mt-1 text-sm text-ink-muted">{t('settings.subtitle')}</p>
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

          Two columns up to xl, capped at max-w-6xl; at 2xl the cap lifts and a THIRD column
          appears, so settings grow with the widescreen container instead of sitting in a narrow
          strip in the middle of it (the container's own note in index.css says the same). */}
      <div className="mx-auto w-full max-w-6xl gap-6 lg:columns-2 2xl:max-w-none 2xl:columns-3 [&>*]:mb-6 [&>*]:break-inside-avoid [&>*:last-child]:mb-0">
      <Panel title={t('settings.network.label')}>
        {/* The unreadable-settings warning sits ABOVE the switch, so its "pick a network below"
            points at something that is actually below it. */}
        {settingsCorrupted && (
          <div className="px-5 py-4 sm:px-6">
            <Alert kind="warn">{t('settings.network.corrupted')}</Alert>
          </div>
        )}
        {/* Both states are a plain NEUTRAL statement (the row's text, in ink, no warning
            edge): this states which network is selected, which the user chose and already
            knows. The CAUTION about mainnet belongs at the moment of switching (the confirm
            modal below), not as a banner that sits here forever — a warning the user has
            already accepted and cannot act on stops being read. */}
        <Row
          control={
            <SegmentedGroup ariaLabel={t('settings.network.label')}>
              {/* Mainnet first: it is the default for a fresh install (§7) and what almost every
                  user is on, so it reads as the primary choice rather than the afterthought. The
                  confirm gate below keys off the NAME, not the position — reordering these is
                  safe and does not change which direction is guarded. */}
              {(['mainnet', 'testnet'] as NetworkName[]).map((n, i) => {
                const active = network === n
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      if (active) return
                      // Only the direction that RAISES the stakes is confirmed.
                      if (n === 'mainnet') setConfirmingMainnet(true)
                      else onNetworkChange(n)
                    }}
                    className={cx(segmentClass(active, i), 'capitalize')}
                  >
                    {n}
                  </button>
                )
              })}
            </SegmentedGroup>
          }
        >
          <span className="text-sm text-ink">
            {network === 'mainnet' ? t('settings.network.onMainnet') : t('settings.network.onTestnet')}
          </span>
        </Row>
        {/* Existing keys are unaffected by this switch — they derive at their own stamp. Said
            here because the opposite is the intuitive assumption, and acting on it (expecting a
            key's xpub to follow the toggle) is how someone enrolls the wrong key. */}
        <p className="bg-ink/[0.02] px-5 py-3 text-xs text-ink-muted sm:px-6">{t('settings.network.keysUnaffected')}</p>
      </Panel>

      <Appearance theme={theme} onChange={onThemeChange} />
      <Motion />

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
            ⚠️ Row 2's two items must stay the same size (`text-xs` on both; 11px until the
            fintech pass set 12px as the floor). They read as a matched pair — a subtle footer
            line — and bumping either one alone turns it back into a label-and-value row, which
            is what this replaced. */}
        <div className="space-y-1.5">
          <div className="text-center text-sm text-ink">{t('settings.version.publisher')}</div>
          <div className="flex items-baseline justify-between gap-3">
            <button
              type="button"
              onClick={() => { void openUrl('https://signbit.io') }}
              className="font-mono text-xs text-brand-700 underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-400"
            >
              {t('settings.version.domain')}
            </button>
            {/* `items-baseline` on the row + matching size sits the version on the same
                typographic line as the domain, rather than optically half a pixel high. */}
            <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">v{version}</span>
          </div>
        </div>
      </Card>
      </div>

      {confirmingMainnet && (
        <MainnetConfirmModal
          onConfirm={() => {
            onNetworkChange('mainnet')
            setConfirmingMainnet(false)
          }}
          onClose={() => setConfirmingMainnet(false)}
        />
      )}
    </div>
  )
}

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/*
  A SETTINGS PANEL (the fintech pass, matching the platform's settings page): the title in a
  ruled header bar, the body flush, rows ruled edge to edge. Rows bring their own padding.
  `tag` sits beside the title (Storage shows portable/default there).
*/
function Panel({ title, tag, children }: { title: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <section className="card overflow-hidden animate-fade-in-up">
      <div className="flex min-h-[3.25rem] flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 sm:px-6">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
        {tag}
      </div>
      <div className="divide-y divide-line">{children}</div>
    </section>
  )
}

/*
  One ruled row: what the setting does on the left, its control on the right. On a phone the
  control drops under the text at full width. `stack` keeps it under the text at every width,
  for a control too wide to share a half-width column (auto-lock's five options).
*/
function Row({ children, control, stack }: { children: ReactNode; control: ReactNode; stack?: boolean }) {
  return (
    <div className={cx('flex flex-col gap-3 px-5 py-4 sm:px-6', !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-6')}>
      <div className="min-w-0 text-[13px] text-ink-muted">{children}</div>
      <div className={cx(!stack && 'sm:shrink-0')}>{control}</div>
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
    <Panel title={t('settings.language.label')}>
      <Row control={<LocaleSwitcher className="w-full sm:w-auto" />}>{t('settings.language.hint')}</Row>
    </Panel>
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
    <Panel title={t('settings.appearance.label')}>
      <Row
        control={
          <SegmentedGroup ariaLabel={t('settings.appearance.label')}>
            {THEME_OPTION_KEYS.map((o, i) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={theme === o.value}
                onClick={() => {
                  onChange(o.value)
                  writeSettings({ ...readSettings(), theme: o.value })
                }}
                className={segmentClass(theme === o.value, i)}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </SegmentedGroup>
        }
      >
        {t('settings.appearance.hint')}
      </Row>
    </Panel>
  )
}

/*
  Animations — on by default; off makes every screen and dialog change instantly (user,
  2026-10-28). Applied to <html> at once and before the first paint on launch (main.tsx).
*/
function Motion() {
  const { t } = useI18n()
  const [on, setOn] = useState(readMotion)
  return (
    <Panel title={t('settings.motion.label')}>
      <Row
        control={
          // On/off is a switch now (the platform's square one); the state word beside it keeps
          // the value readable as text, not only as a knob position.
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-semibold text-ink-muted">
              {t(on ? 'settings.motion.on' : 'settings.motion.off')}
            </span>
            <Switch
              checked={on}
              label={t('settings.motion.label')}
              onChange={(value) => {
                setOn(value)
                writeMotion(value)
                applyMotion(value)
              }}
            />
          </div>
        }
      >
        {t('settings.motion.hint')}
      </Row>
    </Panel>
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
    <Panel title={t('settings.autoLock.label')}>
      <Row
        stack
        control={
          <SegmentedGroup ariaLabel={t('settings.autoLock.label')}>
            {AUTO_LOCK_OPTION_KEYS.map((o, i) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={minutes === o.value}
                onClick={() => {
                  onChange(o.value)
                  writeSettings({ ...readSettings(), autoLockMinutes: o.value })
                }}
                className={cx(segmentClass(minutes === o.value, i), 'tabular-nums')}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </SegmentedGroup>
        }
      >
        {t('settings.autoLock.hint')}
      </Row>
      {minutes === 0 && (
        <div className="px-5 py-4 sm:px-6">
          <Alert kind="warn">{t('settings.autoLock.offWarning')}</Alert>
        </div>
      )}
    </Panel>
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
    <Panel
      title={t('settings.storage.label')}
      tag={
        info && !unavailable ? (
          // The portable/default verdict rides in the header bar as a small square tag; orange
          // edge + text for portable (keys travel with this folder), neutral for default.
          <span
            className={cx(
              'inline-flex h-5 items-center border px-1.5 text-xs font-semibold leading-none',
              info.portable ? 'border-brand-500 text-brand-700 dark:text-brand-400' : 'border-line text-ink-muted',
            )}
          >
            {info.portable ? t('settings.storage.portable') : t('settings.storage.default')}
          </span>
        ) : undefined
      }
    >
      <p className="px-5 py-4 text-[13px] text-ink-muted sm:px-6">{t('settings.storage.hint')}</p>
      {unavailable ? (
        <div className="px-5 py-4 sm:px-6">
          <Alert kind="warn">
            {t('settings.storage.unavailablePrefix')} <Mono>npm run tauri dev</Mono>{t('settings.storage.unavailableSuffix')}
          </Alert>
        </div>
      ) : !info ? (
        <p className="px-5 py-4 text-sm text-ink-muted sm:px-6">{t('settings.storage.checking')}</p>
      ) : (
        <div className="space-y-2 px-5 py-4 sm:px-6">
          <p className="text-[13px] text-ink">
            {info.portable ? t('settings.storage.portableNote') : t('settings.storage.defaultNote')}
          </p>
          {/* The path can be long; give it its own bordered, scroll-safe block so it never
              pushes the card wider than the phone screen. Inner fill is `bg-surface`: a
              `bg-surface-2` box inside a card is the card's own colour and vanishes. */}
          <Mono className="block break-all border border-line bg-surface px-2.5 py-2 text-xs text-ink-muted">
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
    </Panel>
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
