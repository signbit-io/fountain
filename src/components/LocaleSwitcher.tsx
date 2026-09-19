import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n, AVAILABLE_LOCALES, LOCALE_LABELS, type Locale } from '../i18n'

/**
 * Language switcher.
 * `field` (default) = plain native <select> showing the full language name — used in Settings.
 * `ghost` = compact custom dropdown showing the short code (EN/FR/…) with full names in the
 * list — used in tight spaces like the navbar/unlock header.
 */
export function LocaleSwitcher({
  className,
  variant = 'field',
}: {
  className?: string
  variant?: 'field' | 'ghost'
}) {
  if (variant === 'ghost') return <GhostLocaleSwitcher className={className} />

  const { locale, setLocale } = useI18n()
  return (
    <select
      aria-label="Language"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className={
        'border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-brand-500/60' +
        (className ? ` ${className}` : '')
      }
    >
      {AVAILABLE_LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  )
}

function GhostLocaleSwitcher({ className }: { className?: string }) {
  const { locale, setLocale } = useI18n()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [rect, setRect] = useState<{ top: number; right: number } | null>(null)

  // Position the portal list under the trigger — like ui.tsx's Modal, rendering at <body>
  // so the dropdown always paints above the header/nav/backdrop layers, regardless of any
  // ancestor stacking context (transforms/opacity on cards would otherwise trap a z-50 child).
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setRect({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false)
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

  return (
    <div className={'relative' + (className ? ` ${className}` : '')}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Language"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md px-1.5 font-mono text-xs font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 sm:min-h-0 sm:min-w-0 sm:py-1"
      >
        {locale.toUpperCase()}
      </button>
      {open &&
        rect &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            style={{ position: 'fixed', top: rect.top, right: rect.right }}
            className="z-[100] min-w-[8rem] origin-top-right animate-scale-in border border-line bg-surface-2 p-1 shadow-lift"
          >
            {AVAILABLE_LOCALES.map((l) => (
              <li key={l}>
                <button
                  type="button"
                  role="option"
                  aria-selected={l === locale}
                  onClick={() => {
                    setLocale(l as Locale)
                    setOpen(false)
                  }}
                  className={
                    'flex w-full min-h-10 items-center justify-between gap-2 px-2.5 text-left text-xs transition-colors sm:min-h-0 sm:py-1.5 ' +
                    (l === locale ? 'text-brand-600 dark:text-brand-400' : 'text-ink hover:bg-surface')
                  }
                >
                  <span>{LOCALE_LABELS[l]}</span>
                  <span className="font-mono text-[10px] text-ink-muted">{l.toUpperCase()}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  )
}
