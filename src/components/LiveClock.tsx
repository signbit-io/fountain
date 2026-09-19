import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/**
 * A live, locale-aware date/time readout — ticks every second off the DEVICE clock (this app
 * is air-gapped, so there's no server time to sync against; the device clock is all there is).
 * First use: UnlockScreen, a quiet "this is a live, local app" signal before you're even in.
 */
export function LiveClock({ className }: { className?: string }) {
  const { locale } = useI18n()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const date = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(now)
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(now)

  // TIME first, then date — the time is what's glanced at; the date is context.
  return (
    <div className={cx('font-mono text-xs text-ink-muted', className)}>
      <span className="tabular-nums">{time}</span>
      <span className="mx-1.5 text-ink-muted/40" aria-hidden>
        ·
      </span>
      <span>{date}</span>
    </div>
  )
}
