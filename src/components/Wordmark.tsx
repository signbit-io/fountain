import { useI18n } from '../i18n'

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/**
 * Brand wordmark — "SigNBit" set in Sabre Shark (bold italic), split ink/brand-orange.
 * Capital N deliberately (lowercase "n" reads oddly in this face). Mirrors the SignBit platform's
 * Wordmark.tsx — same font, same split, same casing, kept as a separate copy since this
 * repo has no shared-component import path to the platform.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cx('font-wordmark inline-flex items-baseline text-xl leading-none tracking-tight', className)}
      aria-label="SignBit"
    >
      <span className="text-ink">SigN</span>
      <span className="text-brand-500">Bit</span>
    </span>
  )
}

/**
 * Wordmark + "Companion Signer" tagline, same row, no separator dot. The one lockup used
 * everywhere the brand header appears (App shell, Unlock, Restore) — was three copies of
 * the same markup before this extraction.
 */
export function BrandLockup({ size = 'md', className }: { size?: 'sm' | 'md'; className?: string }) {
  const { t } = useI18n()
  return (
    <div className={cx('flex min-w-0 items-baseline gap-2.5', className)}>
      {/* sm lockup steps the wordmark down one notch below xs (475px) — the smallest header
          rows need the width more than the logo does. */}
      <Wordmark className={cx('shrink-0', size === 'sm' ? 'text-base xs:text-lg' : 'text-xl')} />
      <span
        className={cx(
          'truncate font-medium uppercase tracking-wide text-ink-muted',
          size === 'sm' ? 'hidden text-xs xs:inline' : 'text-xs',
        )}
      >
        {t('common.brandTagline')}
      </span>
    </div>
  )
}
