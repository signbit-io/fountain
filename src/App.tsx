import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { KeystoreProvider, useKeystore } from './lib/keystore'
import type { NetworkName } from './lib/key'
import { UnlockScreen } from './screens/UnlockScreen'
import { KeysScreen } from './screens/KeysScreen'
import { SignScreen, initialSignScreenState, type SignScreenState } from './screens/SignScreen'
import { VaultsScreen } from './screens/VaultsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { BackupTransferScreen, type TransferMode } from './screens/BackupTransferScreen'
import { HelpScreen } from './screens/HelpScreen'
import { readSettings, readSettingsResult, writeSettings, applyTheme, type ThemePref } from './lib/activity'
import { shouldAutoLock, msUntilAutoLock, isAutoLockEnabled } from './lib/auto-lock'
import { I18nProvider, useI18n } from './i18n'
import { LocaleSwitcher } from './components/LocaleSwitcher'
import { BrandLockup } from './components/Wordmark'
import { LiveClock } from './components/LiveClock'

// The tab order for the subnav. Help renders inline only on lg+ (desktop); below lg it moves
// into the header ⋯ overflow menu, so phone/tablet show the first four here as a full-width row.
const TABS = ['keys', 'sign', 'vaults', 'settings', 'help'] as const
type Tab = (typeof TABS)[number]

export default function App() {
  return (
    <I18nProvider>
      <KeystoreProvider>
        <Shell />
      </KeystoreProvider>
    </I18nProvider>
  )
}

function Shell() {
  const { status, lock } = useKeystore()
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('keys')
  // The sliding underline under the active tab: measured from the tab button, re-measured on a
  // tab change, a locale change (label widths differ) and a resize.
  const tabRowRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const el = tabRefs.current[tab]
      // offsetParent is null when the tab is display:none (Help below lg)
      setIndicator(el && el.offsetParent ? { left: el.offsetLeft, width: el.offsetWidth } : null)
    }
    measure()
    document.fonts?.ready.then(measure) // Epilogue arriving after the first measure changes widths
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [tab, t, status])
  // One-shot flag: the Help tab's Keys section can jump straight to the Keys screen AND
  // open its setup-guide modal in one action (cross-reference instead of duplicating that
  // content). <main key={tab}> remounts KeysScreen on every tab switch, so this only needs
  // to be true for the mount that follows — KeysScreen reads it once as its initial state.
  const [openKeysGuideOnMount, setOpenKeysGuideOnMount] = useState(false)
  /*
    The network the app is WORKING ON — persisted, and mainnet-capable.

    ⚠️ This decides what NEW keys are stamped with and what the UI shows. It is NOT how an
    existing key derives: that is the key's own KeyEntry.network stamp (see lib/key.ts
    networkOf). Deriving a stored key against this value would silently produce a different
    xpub than the one enrolled in the user's vault.

    `settingsRead` also reports whether a stored settings blob was unreadable — in which case
    the network fell back to testnet (the safe direction) and the user is told, because
    otherwise the app would silently look like it changed its own mind.
  */
  const [settingsRead] = useState(readSettingsResult)
  const [network, setNetwork] = useState<NetworkName>(settingsRead.settings.network)
  const [settingsCorrupted, setSettingsCorrupted] = useState(settingsRead.corrupted)
  // Auto-lock preference (minutes; 0 = never). Held in state so a change in Settings
  // re-arms the idle timer immediately.
  const [autoLockMinutes, setAutoLockMinutes] = useState(settingsRead.settings.autoLockMinutes)
  // Theme preference (light/dark/system). Applied to <html> so the whole app — including the
  // lock screen, before any keystore is unlocked — respects it.
  const [theme, setTheme] = useState<ThemePref>(settingsRead.settings.theme)

  /*
    Persist the network alongside the in-memory switch. Writing it clears the corruption
    warning too: the user has just stated their intent explicitly, so the blob is now good and
    a stale "we couldn't read your settings" banner would be noise.
  */
  const changeNetwork = useCallback((next: NetworkName) => {
    setNetwork(next)
    setSettingsCorrupted(false)
    writeSettings({ ...readSettings(), network: next })
  }, [])
  // The Sign screen's in-progress work (mode/key/PSBT text/output), lifted here so switching
  // to another tab and back doesn't wipe out a pasted PSBT or a just-produced signature —
  // <main key={tab}> below remounts the active screen on every tab switch (kept for its
  // fade-in animation), so anything SignScreen needs to survive that has to live above it.
  const [signState, setSignState] = useState<SignScreenState>(initialSignScreenState)
  // Backup import/compare takes over the whole content area (it isn't a tab — Settings is still
  // its only entry point). Null = show the normal tab content. Lives here rather than inside
  // SettingsScreen because <main key={tab}> would remount and lose it on any tab switch, and
  // because the view needs the full width, not a Settings column.
  const [backupTransfer, setBackupTransfer] = useState<TransferMode | null>(null)

  useAutoLock(status === 'unlocked', autoLockMinutes, lock)
  useTheme(theme)

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">{t('common.loading')}</div>
  }
  if (status === 'empty' || status === 'locked') {
    return <UnlockScreen />
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Sticky header + tab nav — pinned together at the top while the page scrolls, so
          network/lock/language and the active tab stay reachable on a long screen.
          pt-[env(safe-area-inset-top)] keeps the header clear of a phone's status bar /
          notch when the WebView draws edge-to-edge (viewport-fit=cover in index.html). */}
      <div className="sticky top-0 z-30 bg-surface pt-[env(safe-area-inset-top)]">
      <header className="relative border-b border-line bg-surface">
        <div className="container-page flex h-14 items-center justify-between gap-2">
          <BrandLockup size="sm" />
          {/* Header controls: min-h/w-10 (40px) on touch-first sizes, relaxing to the compact
              desktop look at sm+ — a 26px-tall lock button is fine with a mouse, hostile to a
              thumb.

              Smallest screens (below xs/475px): the full row (locale + network + theme + lock)
              crowds the logo, so the network badge + theme toggle fold into a ⋯ overflow menu —
              locale (one glyph) and LOCK (the security-critical one-tap action on a signer)
              stay always visible. xs+ shows everything inline. */}
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
            <LocaleSwitcher variant="ghost" />
            <span className="hidden xs:inline-flex"><NetworkBadge network={network} /></span>
            <span className="hidden xs:inline-flex"><ThemeToggle theme={theme} onChange={setTheme} /></span>
            <button
              type="button"
              aria-label={t('shell.lock')}
              title={t('shell.lock')}
              onClick={() => lock()}
              className="inline-flex min-h-10 min-w-10 items-center justify-center border border-line text-ink-muted transition-colors hover:border-brand-400/60 hover:text-ink sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-1"
            >
              <LockIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            </button>
            <HeaderOverflowMenu
              network={network}
              theme={theme}
              onThemeChange={setTheme}
              activeTab={tab}
              onSelectTab={(next) => {
                setBackupTransfer(null) // same rule as the subnav tabs
                setTab(next)
              }}
            />
          </div>
        </div>
      </header>

      <nav className="relative border-b border-line bg-surface">
        {/* 3-column layout so the tabs stay visually centered with the clock in the left
            slot — a plain justify-center row would get pushed off-center by the clock's
            width. Hidden below sm: the tab row is already tight on a phone.

            Mobile: the 5 tabs share the FULL row width equally (flex-1, centered labels) —
            a left-hugging strip left dead space on the right. Each tab can still shrink
            (min-w-0 + truncate) so a long translated label (de "Einstellungen") ellipsizes
            inside its fifth rather than overflowing; the row itself never scrolls. Desktop
            keeps the centered, natural-width row.

            The clock (and its 3-column layout) only appears on lg+ (desktop) — hidden on
            phone AND tablet so the tab row keeps the full width on those narrower screens. */}
        <div className="container-page grid grid-cols-[minmax(0,1fr)] items-center gap-1 lg:grid-cols-[1fr_auto_1fr]">
          <LiveClock className="hidden lg:block" />
          <div ref={tabRowRef} className="relative flex min-w-0 gap-0 lg:justify-center lg:gap-1">
            {TABS.map((tabKey) => (
              <button
                key={tabKey}
                ref={(el) => {
                  tabRefs.current[tabKey] = el
                }}
                // Picking a tab always leaves the backup import/compare view — it's a detour
                // from Settings, not a destination, so the nav must never look active while
                // something else is on screen.
                onClick={() => {
                  setBackupTransfer(null)
                  setTab(tabKey)
                }}
                // Help is dropped from the row below lg (it moves into the ⋯ overflow menu on
                // phone/tablet — see HeaderOverflowMenu); on lg+ every tab shows inline.
                className={`min-w-0 flex-1 truncate whitespace-nowrap border-b-2 px-1 py-3 text-sm capitalize transition-colors lg:flex-none lg:px-4 ${
                  tabKey === 'help' ? 'hidden lg:block' : ''
                } ${
                  tab === tabKey ? 'text-ink' : 'text-ink-muted hover:text-ink'
                } border-transparent`}
              >
                {t(`shell.tabs.${tabKey}`)}
              </button>
            ))}
            {/* The active tab's underline, one bar that slides to the tab picked (user,
                2026-10-28: more motion). Measured from the tab itself, so it follows label
                widths in every locale; hidden when the active tab is not in this row (Help
                below lg lives in the ⋯ menu). */}
            {indicator && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 h-0.5 bg-brand-500 transition-[left,width] duration-300 ease-smooth"
                style={{ left: indicator.left, width: indicator.width }}
              />
            )}
          </div>
          <div aria-hidden="true" className="hidden lg:block" />
        </div>
      </nav>
      </div>

      {/* min-h fills the rest of the viewport below the sticky header (3.5rem) + tab nav
          (~3.5rem), so the grid/glow backdrop covers the full screen even when a tab's content
          is short — otherwise <main> only grows to fit its content and the remaining viewport
          falls through to plain bg-surface below it. dvh (with a vh fallback for older
          WebViews) = the DYNAMIC viewport height, which tracks a mobile browser/WebView's
          collapsing URL/system bars — plain 100vh over-measures there and forces a
          permanent scroll. */}
      <main className="relative min-h-[calc(100vh-7rem)] overflow-hidden supports-[height:100dvh]:min-h-[calc(100dvh-7rem)]" key={tab}>
        {/* Content-area backdrop: dot-grid texture (full height of main, now = full screen) +
            a brand glow at the top. Both behind the content and non-interactive. */}
        <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="bg-glow pointer-events-none absolute inset-x-0 top-0 h-72" aria-hidden="true" />
        {/* pb accounts for a phone's bottom gesture bar (safe-area inset) on top of the
            normal page padding. */}
        <div className="container-page stagger relative py-8 pb-[max(2rem,env(safe-area-inset-bottom))] animate-fade-in">
          {/* The backup import/compare view REPLACES the tab's content while open. Checked
              before the tab switch below so it wins regardless of which tab is active — though
              in practice selecting any tab closes it (see the nav's onClick). */}
          {backupTransfer ? (
            <BackupTransferScreen
              mode={backupTransfer}
              network={network}
              onBack={() => setBackupTransfer(null)}
            />
          ) : (
          <>
          {tab === 'keys' && (
            <KeysScreen
              network={network}
              openGuideOnMount={openKeysGuideOnMount}
              onGuideOpened={() => setOpenKeysGuideOnMount(false)}
            />
          )}
          {tab === 'sign' && (
            <SignScreen
              network={network}
              state={signState}
              onStateChange={setSignState}
              onNavigateToVaults={() => setTab('vaults')}
            />
          )}
          {tab === 'vaults' && <VaultsScreen network={network} />}
          {tab === 'settings' && (
            <SettingsScreen
              network={network}
              onNetworkChange={changeNetwork}
              settingsCorrupted={settingsCorrupted}
              autoLockMinutes={autoLockMinutes}
              onAutoLockChange={setAutoLockMinutes}
              theme={theme}
              onThemeChange={setTheme}
              onOpenBackupTransfer={setBackupTransfer}
            />
          )}
          {tab === 'help' && (
            <HelpScreen
              onOpenKeysGuide={() => {
                setOpenKeysGuideOnMount(true)
                setTab('keys')
              }}
            />
          )}
          </>
          )}
        </div>
      </main>
    </div>
  )
}

/*
  Auto-lock on inactivity. When unlocked and a timeout is set (>0 min), lock the keystore
  after that many minutes of no user activity — shrinking the "compromised host while
  unlocked" window (the MVP threat-model gap). Any pointer/key/touch/scroll resets the timer.
  Passing `true` marks it as an idle auto-lock in the security log.

  🚨 **DECIDED ON WALL-CLOCK ELAPSED TIME, NOT ON TIMER DELIVERY** (2026-09-11). A bare
  `setTimeout` froze while the OS was suspended, so closing the lid stopped the countdown and
  a stolen sleeping machine resumed UNLOCKED — the likeliest attack on an air-gapped signer,
  whose only attacker is one holding the device. The policy lives in `lib/auto-lock.ts` as
  pure functions so it can be tested against a three-day suspend and a tampered clock, neither
  of which a real timer can demonstrate in a test.
*/
function useAutoLock(active: boolean, minutes: number, lock: (auto?: boolean) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastActivityAt = useRef<number>(Date.now())

  useEffect(() => {
    if (!active || !isAutoLockEnabled(minutes)) return

    /*
      🚨 **UNLOCKING IS ACTIVITY, AND FORGETTING THAT LOCKED THE APP THE INSTANT IT OPENED.**
      (Android, user, 2026-09-19: *"when entering my password. sometimes it just locks
      instantly even on successful password."*)

      `lastActivityAt` is a ref on a component that STAYS MOUNTED across a lock, so it kept the
      timestamp from the PREVIOUS session. Lock the app, leave it longer than the timeout — on
      Android the OS backgrounds it, so that is the normal case, not an edge one — then unlock:
      this effect re-activates, `arm()` computes a remaining time of 0 against that stale
      timestamp, and `check` locks immediately. The passphrase was correct; the window it
      reopened had already expired before the user typed it.

      ⚠️ **"Sometimes" was a RACE, which is why it looked intermittent.** The listeners below
      attach only while unlocked, so a touch landing before the 0ms timer reset the clock and
      the app stayed open; losing that race locked it. Nothing about the passphrase differed
      between the two outcomes.

      🚨 **THIS DOES NOT WEAKEN THE CONTROL — it is the strongest presence proof the app ever
      gets.** Auto-lock exists to bound how long an unlocked keystore sits unattended; that
      clock can only start when the keystore becomes unlocked. Deferring on a RESUME would be
      the real weakening, and `check` (not `onActivity`) still handles focus/visibility, so a
      stolen sleeping device is unaffected.
    */
    lastActivityAt.current = Date.now()

    /*
      🚨 **THE TIMER IS AN INVITATION TO RE-CHECK, NOT THE DECISION.** `setTimeout` does not
      advance while the OS is suspended, so a lid-close used to FREEZE the countdown: a
      stolen sleeping laptop resumed unlocked no matter how long it had been gone. Every
      wake-up therefore asks the same wall-clock question — how long since real activity? —
      and the timer is only one of the things that can ask it. 📄 `lib/auto-lock.ts`.
    */
    const check = () => {
      if (shouldAutoLock(lastActivityAt.current, Date.now(), minutes)) {
        lock(true)
        return
      }
      arm()
    }

    const arm = () => {
      if (timer.current) clearTimeout(timer.current)
      // Arm for the TRUE remaining time, not a fresh full timeout — after a resume the
      // deadline is usually already close (or past, in which case this is 0).
      timer.current = setTimeout(check, msUntilAutoLock(lastActivityAt.current, Date.now(), minutes))
    }

    const onActivity = () => {
      lastActivityAt.current = Date.now()
      arm()
    }

    /*
      ⚠️ **`visibilitychange` AND `focus` ARE THE RESUME SIGNALS.** Waking from suspend,
      un-minimising, or switching back to the window all fire one of these, and each is a
      moment where a lot of unmeasured real time may just have passed. They re-CHECK rather
      than reset: returning to the window is not activity that should defer a lock.
    */
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel']
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    arm()

    return () => {
      if (timer.current) clearTimeout(timer.current)
      events.forEach((e) => window.removeEventListener(e, onActivity))
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [active, minutes, lock])
}

/*
  Apply + persist the theme preference. Re-applies whenever the preference changes, and while
  the preference is 'system' it also tracks live OS light/dark changes (so the app follows the
  desktop theme without a restart). Persistence happens in Settings on pick; here we only apply.
*/
function useTheme(theme: ThemePref) {
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
}

/*
  Header ⋯ overflow menu. Shows on all NON-DESKTOP sizes (below lg) and folds in whatever
  doesn't fit the header/subnav at the current width; hidden on lg+ (desktop shows everything
  inline). Portaled to <body> (same pattern as GhostLocaleSwitcher) so it paints above the
  sticky header/backdrop layers. Locale and Lock deliberately stay OUT of this menu: locale is
  one glyph wide, and Lock is the security-critical action on a signer — it must stay one tap
  away. Menu CONTENTS are breakpoint-aware:
   - Help (`onSelectTab('help')`) always shows here below lg — it's dropped from the 5-tab
     subnav on phone/tablet so the remaining four tabs get the full row width.
   - Network + theme rows show ONLY below xs (475px), where they're pulled out of the crowded
     header row; from xs to lg they sit inline in the header, so the menu only carries Help.
*/
function HeaderOverflowMenu({
  network,
  theme,
  onThemeChange,
  activeTab,
  onSelectTab,
}: {
  network: NetworkName
  theme: ThemePref
  onThemeChange: (t: ThemePref) => void
  activeTab: Tab
  onSelectTab: (t: Tab) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setRect({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onReposition() {
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
    }
  }, [open])

  const isLight = theme === 'light'
  function toggleTheme() {
    const next: ThemePref = isLight ? 'dark' : 'light'
    onThemeChange(next)
    writeSettings({ ...readSettings(), theme: next })
  }
  const themeLabel = t(`settings.appearance.${isLight ? 'dark' : 'light'}` as 'settings.appearance.light')

  return (
    <div className="relative lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('shell.moreControls')}
        title={t('shell.moreControls')}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-10 min-w-10 items-center justify-center border border-line text-ink-muted transition-colors hover:border-brand-400/60 hover:text-ink"
      >
        <DotsIcon className="h-4 w-4" />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', top: rect.top, right: rect.right }}
            className="z-[100] min-w-[11rem] origin-top-right animate-scale-in border border-line bg-surface-2 p-1 shadow-lift"
          >
            {/* Network + theme — only below xs, where they're pulled out of the header row.
                From xs to lg they sit inline in the header, so the menu carries only Help.
                Shown FIRST; Help follows below. */}
            <div className="hidden max-xs:block">
              {/* Network — read-only status row (the actual toggle lives in Settings). */}
              <div className="flex min-h-10 items-center justify-between gap-3 px-2.5 text-xs">
                <span className="text-ink-muted">{t('settings.network.label')}</span>
                <span className="border border-line px-1.5 py-0.5 font-mono text-ink-muted">{network}</span>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  toggleTheme()
                  setOpen(false)
                }}
                className="flex w-full min-h-10 items-center justify-between gap-3 px-2.5 text-left text-xs text-ink transition-colors hover:bg-surface"
              >
                <span>{t('shell.appearance', { mode: themeLabel })}</span>
                {isLight ? <MoonIcon className="h-3.5 w-3.5 text-ink-muted" /> : <SunIcon className="h-3.5 w-3.5 text-ink-muted" />}
              </button>
              {/* Divider between the xs-only controls and Help below. */}
              <div className="my-1 border-t border-line" aria-hidden="true" />
            </div>
            {/* Help — always present below lg (it's dropped from the subnav there). Comes AFTER
                the network/appearance block above. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onSelectTab('help')
                setOpen(false)
              }}
              className={`flex w-full min-h-10 items-center justify-between gap-3 px-2.5 text-left text-xs capitalize transition-colors hover:bg-surface ${
                activeTab === 'help' ? 'text-ink' : 'text-ink-muted'
              }`}
            >
              <span>{t('shell.tabs.help')}</span>
              {activeTab === 'help' && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />}
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

function NetworkBadge({ network }: { network: NetworkName }) {
  // No status dot — this signer is air-gapped, so a green "online" dot would be misleading.
  // The badge states the network only; offline status is confirmable in Settings.
  //
  // ⚠️ MAINNET IS VISUALLY DISTINCT, and that is a safety feature, not decoration. Once both
  // networks are live, "which network am I on" is a money question the user must be able to
  // answer from any screen at a glance — the two states must never look interchangeable.
  const mainnet = network === 'mainnet'
  return (
    // min-h-10 matches the touch-sized header controls so the row reads as one height on a
    // phone; sm+ collapses back to the compact badge.
    <span
      className={[
        'inline-flex min-h-10 items-center border px-2 text-xs uppercase tracking-wide sm:min-h-0 sm:py-1',
        mainnet
          ? 'border-brand-500 bg-brand-500/10 font-semibold text-brand-700 dark:text-brand-400'
          : 'border-line text-ink-muted',
      ].join(' ')}
    >
      {network}
    </span>
  )
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="1.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  )
}

/*
  Header appearance toggle — LIGHT/DARK only, a quick one-click flip (no "system" here; the
  full three-way preference, including System, still lives in Settings' Appearance card).
  Starting from 'system' flips to 'dark' (arbitrary but deterministic); every click after
  that alternates light/dark normally. Same read/writeSettings + applyTheme path as Settings.
*/
function ThemeToggle({ theme, onChange }: { theme: ThemePref; onChange: (t: ThemePref) => void }) {
  const { t } = useI18n()
  const isLight = theme === 'light'

  function toggle() {
    const next: ThemePref = isLight ? 'dark' : 'light'
    onChange(next)
    writeSettings({ ...readSettings(), theme: next })
  }

  const label = t(`settings.appearance.${isLight ? 'light' : 'dark'}` as 'settings.appearance.light')
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t('shell.appearance', { mode: label })}
      title={t('shell.appearance', { mode: label })}
      className="inline-flex min-h-10 min-w-10 items-center justify-center border border-line text-ink-muted transition-colors hover:border-brand-400/60 hover:text-ink sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-1"
    >
      {isLight ? <SunIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : <MoonIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
    </button>
  )
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  )
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  )
}

