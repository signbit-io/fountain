import { useEffect, useMemo, useState } from 'react'

import { createPortal } from 'react-dom'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { useI18n } from '../i18n'
import { analyzeMnemonic } from '../lib/key'

/*
  Minimal on-brand primitives (SignBit look: squared corners, Bitcoin-orange accent,
  surface/ink tokens). Deliberately small — the companion signer is a focused tool, not
  the full app. Shares the same Tailwind token system as the SignBit platform.
*/

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
}

export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  // Motion mirrors the platform's Button: 300ms ease-smooth, hover lift/shadow, press scale,
  // focus ring. Primary uses brand-700 (readable white text; 500 is the accent identity).
  // Disabled = a flat, fully-opaque muted fill (surface-2/ink-muted/line border), NOT a
  // faded/see-through version of the enabled color — a 50%-opacity brand-orange button read
  // as "broken/transparent" rather than "not ready yet".
  const base =
    'inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-smooth ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-surface ' +
    'disabled:pointer-events-none disabled:hover:translate-y-0 disabled:hover:shadow-none disabled:shadow-none ' +
    'disabled:border disabled:border-line disabled:!bg-surface-2 disabled:!text-ink-muted'
  const variants = {
    primary: 'bg-brand-700 text-white shadow-soft hover:bg-brand-800 hover:shadow-lift active:scale-[0.98]',
    secondary: 'border border-line bg-surface-2 text-ink hover:border-brand-400/60 hover:-translate-y-0.5 active:translate-y-0',
    ghost: 'text-ink-muted hover:text-ink hover:bg-surface-2',
    danger: 'border border-red-500/30 text-red-600 hover:bg-red-500/10 active:scale-[0.98] dark:text-red-400',
  }
  return <button className={cx(base, variants[variant], className)} {...props} />
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  // Cards get a gentle hover-lift like the platform's Card, plus an entrance fade-up.
  return (
    <div className={cx('card p-5 animate-fade-in-up transition-shadow duration-300 ease-smooth hover:shadow-lift', className)}>
      {children}
    </div>
  )
}

/*
  A Card with a clickable header that collapses its body (mirrors the platform's CollapsibleCard).
  Open/closed state is persisted per `storageKey` so a section stays the way the user left it.
  `actions` renders inline on the right (e.g. Copy/Remove buttons) and doesn't toggle collapse.
*/
export function CollapsibleCard({
  title,
  children,
  storageKey,
  defaultOpen = true,
  className,
  actions,
}: {
  title: ReactNode
  children: ReactNode
  storageKey: string
  defaultOpen?: boolean
  className?: string
  actions?: ReactNode
}) {
  const key = `signbit.card.${storageKey}`
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? defaultOpen : v === '1'
    } catch {
      return defaultOpen
    }
  })

  function toggle() {
    setOpen((prev) => {
      const next = !prev
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        /* ignore storage failures */
      }
      return next
    })
  }

  return (
    <Card className={className}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="-m-1 flex flex-1 items-center gap-2 rounded-lg p-1 text-left transition-colors hover:text-ink"
        >
          <ChevronDownIcon className={cx('h-4 w-4 shrink-0 text-ink-muted transition-transform duration-200', !open && '-rotate-90')} />
          <span className="min-w-0 flex-1">{title}</span>
        </button>
        {actions}
      </div>
      <div className={cx('grid transition-all duration-200', open ? 'mt-4 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
        <div className="overflow-hidden">{children}</div>
      </div>
    </Card>
  )
}

export function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'w-full border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none transition-colors',
        'focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20 placeholder:text-ink-muted/60',
        className,
      )}
      {...props}
    />
  )
}

/*
  Password field with a show/hide (eye) toggle — the reveal button flips the input between
  `password` and `text`. Built on top of Input so it shares the exact same border/focus styling;
  the toggle sits inside the field's right padding. More valuable on mobile (no hover, easy to
  fat-finger a passphrase) but a real convenience on desktop too. The revealed state is LOCAL
  and resets on unmount — a passphrase never stays visible across a screen change. `type` is
  fixed by this component; every other input attr (autoFocus/value/onChange/autoComplete/…)
  passes straight through.
*/
export function PasswordInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useI18n()
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="relative">
      <Input
        type={revealed ? 'text' : 'password'}
        className={cx('pr-11', className)}
        {...props}
      />
      <button
        type="button"
        // Not a form-submitting control; sits over the input's right padding. min-w/h-10 keeps
        // a 40px tap target below sm, tightening on desktop where a mouse is precise.
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? t('common.hide') : t('common.show')}
        aria-pressed={revealed}
        title={revealed ? t('common.hide') : t('common.show')}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 inline-flex min-w-10 items-center justify-center px-2 text-ink-muted transition-colors hover:text-ink"
      >
        {/* Icon reflects the CURRENT state: revealed text = open eye, hidden text = slashed eye. */}
        {revealed ? <EyeIcon className="h-4 w-4" /> : <EyeOffIcon className="h-4 w-4" />}
      </button>
    </div>
  )
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68M6.1 6.1A13.2 13.2 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 5.9-1.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </svg>
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        'w-full border border-line bg-surface px-3 py-2.5 font-mono text-xs text-ink outline-none transition-colors',
        'focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20 placeholder:text-ink-muted/60',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-muted">{children}</label>
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('break-all font-mono text-xs text-ink', className)}>{children}</span>
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'warn' | 'ok' | 'info'; children: ReactNode }) {
  /*
    `info` is deliberately NEUTRAL, not a fourth accent colour. It states a fact the user chose
    and already knows ("you are on mainnet") — the other three all carry a judgement: error =
    something broke, warn = be careful, ok = that worked. Reusing one of those to say a neutral
    thing miscolours it: green reads as reassurance the app is not in a position to give about
    the live network, and brand-orange reads as a caution the user has already accepted and
    cannot act on, which is how a persistent banner becomes wallpaper.
  */
  const tones = {
    error: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
    warn: 'border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-300',
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    info: 'border-line bg-surface-2 text-ink-muted',
  }
  // Errors shake to draw the eye; ok/warn scale in gently.
  const motion = kind === 'error' ? 'animate-shake' : 'animate-scale-in'
  return <div className={cx('border px-3 py-2 text-sm', tones[kind], motion)}>{children}</div>
}

/*
  Modal — body-portal overlay so it's never clipped by a card's overflow or the narrow
  (380px min) window/webview. Backdrop click + Escape close it; body scroll is locked while
  open. Used for sensitive, deliberate surfaces (e.g. revealing a seed phrase).
*/
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Widen the dialog on larger screens (max-w-3xl instead of max-w-lg). For content whose
   *  usefulness scales with size — currently the QR display, where a bigger code on a desktop
   *  monitor is materially easier for a phone camera to read from a distance. */
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    // Full-screen overlay. On a phone the dialog sits in the UPPER THIRD (between top and center)
    // — `justify-start` + a fixed top gutter (`pt-24`) — deliberately KISS: Tauri's Android WebView
    // doesn't reliably shrink the viewport OR expose keyboard insets (tauri#10631), so rather than
    // chase the keyboard we just park the dialog high enough that its fields stay above where the
    // keyboard rises. The overlay itself scrolls (`overflow-y-auto`) if a tall dialog + the gutter
    // exceed the screen. Rounded corners + all-round gutter read as a floating sheet. sm+ recenters
    // (`sm:justify-center sm:pt-4`) — no on-screen keyboard on desktop, so classic centered.
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-start overflow-y-auto bg-black/50 p-3 pt-24 animate-fade-in sm:justify-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        // Rounded on all corners (no hard bottom edge). The overlay is the scroll container and
        // already reserves a top gutter (`pt-10`); `max-h-full` keeps a very tall dialog inside
        // the padded region and lets ITS content scroll internally rather than pushing past the
        // status bar.
        className={cx(
          'card max-h-full w-full overflow-y-auto rounded-2xl p-4 animate-scale-in sm:p-5',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-ink">{title}</h3>
            <ModalCloseButton onClose={onClose} />
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  )
}

function ModalCloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose}>
      {t('common.close')}
    </Button>
  )
}

export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fall through to the legacy fallback below
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/*
  Compact copy affordance for a value shown INLINE in a dense list (a signer row's
  fingerprint or xpub), where a full CopyButton per value would out-weigh the value itself
  and wrap the row on a phone.

  Same clipboard path and same three states as CopyButton — only the presentation differs, so
  there is one copy implementation, not two. `label` names the specific value for screen
  readers ("Copy fingerprint"), since several of these sit in one row and a bare "Copy" would
  be ambiguous to anyone not seeing the layout. Confirmation is a visible ✓ AND an
  aria-live announcement, because a silent icon swap is invisible to a screen reader.
*/
export function CopyInline({ value, label }: { value: string; label: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function handleClick() {
    const ok = await copyToClipboard(value)
    setState(ok ? 'copied' : 'failed')
    setTimeout(() => setState('idle'), 1500)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      // min-h/w-6 keeps it tappable in a dense row without the 44px target forcing the row
      // taller than its text; it sits inside a row that is itself comfortably tappable.
      className={cx(
        'inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center border border-line px-1 text-[11px] leading-none transition-colors',
        state === 'idle' && 'text-ink-muted hover:border-brand-500/40 hover:text-ink',
        state === 'copied' && 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
        state === 'failed' && 'border-red-500/40 text-red-600 dark:text-red-400',
      )}
    >
      <span aria-hidden="true">{state === 'copied' ? '✓' : state === 'failed' ? '✕' : '⧉'}</span>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? t('common.copied') : state === 'failed' ? t('common.copyFailed') : ''}
      </span>
    </button>
  )
}

export function CopyButton({ value }: { value: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function handleClick() {
    const ok = await copyToClipboard(value)
    setState(ok ? 'copied' : 'failed')
    setTimeout(() => setState('idle'), 1500)
  }

  return (
    <Button
      variant="secondary"
      className={cx(
        'px-2.5 py-1.5 text-xs',
        state === 'copied' && 'text-emerald-600 dark:text-emerald-400',
        state === 'failed' && 'text-red-600 dark:text-red-400',
      )}
      onClick={handleClick}
    >
      {state === 'copied' ? t('common.copied') : state === 'failed' ? t('common.copyFailed') : t('common.copy')}
    </Button>
  )
}

/*
  Seed-phrase import textarea with live incremental feedback (word count, per-word wordlist
  validity, checksum) — built on lib/key.ts's analyzeMnemonic so this component and any test
  share the same validation logic. Word-chips only flag a word as invalid once the user has
  moved past it (typed a trailing space or the phrase is complete) — flagging mid-word would
  fight the user while they're still typing it.
*/
/*
  True once `value` has stopped changing for a beat — i.e. the user paused typing.

  Used ONLY to decide whether a failing checksum on an intermediate word count is worth
  reporting. It deliberately does not gate anything else: per-word validity and the green
  "valid seed phrase" confirmation stay instant, because those are never false alarms.

  700ms is chosen to sit above a normal inter-word pause while typing (so it doesn't fire
  between words) but below the point where a genuinely-finished 12-word phrase feels ignored.
*/
function useTypingSettled(value: string, delayMs = 700): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    setSettled(false) // any keystroke restarts the wait
    const timer = setTimeout(() => setSettled(true), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

export function SeedPhraseInput({
  value,
  onChange,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  const { t } = useI18n()
  const endsWithBoundary = value === '' || /\s$/.test(value)
  const analysis = useMemo(() => analyzeMnemonic(value), [value])
  const hasContent = analysis.count > 0
  const settled = useTypingSettled(value)

  /*
    When is a failing checksum worth SHOWING?

    BIP-39 allows 12/15/18/21/24 words, so someone typing a correct 24-word phrase passes
    THROUGH four other valid counts on the way. At each one the checksum is computed on a
    partial phrase, fails, and the UI used to announce "all valid words, but the order looks
    wrong" — four false alarms per correct entry, each one telling the user their seed is
    broken when they are simply not finished. On a recovery screen that is genuinely alarming.

    The distinction: 24 words is TERMINAL — no more words can follow, so a failing checksum
    there is a real problem worth flagging at once. An intermediate count is not: the user may
    be mid-phrase. So an intermediate failure is only surfaced once typing has actually STOPPED
    (useTypingSettled), which is the closest signal we have to "I'm done".

    A genuine 12-word phrase still gets the warning — just a beat later, rather than being
    shouted at everyone typing 24.
  */
  const MAX_WORDS = 24
  const checksumFailureIsMeaningful = analysis.count === MAX_WORDS || settled

  return (
    <div className="space-y-2">
      <Textarea
        autoFocus={autoFocus}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('keys.seedPlaceholder')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {hasContent && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cx('font-mono', analysis.countValid ? 'text-ink-muted' : 'text-brand-600 dark:text-brand-400')}>
              {t('keys.seedWordCount', { count: analysis.count })}
            </span>
            {analysis.ok && (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">{t('keys.seedValid')}</span>
            )}
            {endsWithBoundary &&
              analysis.countValid &&
              checksumFailureIsMeaningful &&
              !analysis.checksumValid &&
              analysis.words.every((w) => w.ok) && (
                <span className="font-medium text-brand-600 dark:text-brand-400">{t('keys.seedOrderSuspect')}</span>
              )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {analysis.words.map((w, i) => {
              // Don't flag the last word RED while it's still being typed (no trailing boundary
              // yet) — an incomplete word looks "invalid" but may just not be finished. Green is
              // safe to show as soon as it's an exact wordlist match, even without a trailing
              // boundary (e.g. a pasted phrase with no trailing space) — some BIP-39 words are
              // prefixes of others ("act"/"action"), so this can briefly flicker green→green
              // while typing past a shorter match, which is harmless.
              const isLast = i === analysis.words.length - 1
              const judge = !isLast || endsWithBoundary || w.ok

              // Every word is a real BIP-39 word AND the count is right, but the checksum still
              // fails — the words themselves are fine, something about their ORDER/combination
              // isn't (can't localize which one, so every word shares the "order" signal).
              // Gated on checksumFailureIsMeaningful: without it, passing through 12/15/18/21
              // words on the way to 24 turned EVERY chip orange mid-typing (see above).
              const orderSuspect =
                analysis.countValid &&
                checksumFailureIsMeaningful &&
                !analysis.checksumValid &&
                analysis.words.every((x) => x.ok)

              // A word goes green the moment IT is a valid BIP-39 word — not gated on the whole
              // phrase's checksum, since that can't be known until every word is in.
              let tone: 'idle' | 'invalid' | 'orderSuspect' | 'valid'
              if (!judge) tone = 'idle'
              else if (!w.ok) tone = 'invalid'
              else if (orderSuspect) tone = 'orderSuspect'
              else tone = 'valid'

              const tones = {
                idle: 'border-line bg-surface-2 text-ink-muted',
                invalid: 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300',
                orderSuspect: 'border-brand-500/50 bg-brand-500/10 text-brand-700 dark:text-brand-300',
                valid: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              }

              return (
                <span key={i} className={cx('border px-1.5 py-0.5 font-mono text-[11px]', tones[tone])}>
                  {i + 1}. {w.word}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
