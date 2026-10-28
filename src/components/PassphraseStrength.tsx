import { scorePassphrase } from '../lib/passphrase-strength'
import { useI18n } from '../i18n'

/*
  The passphrase strength meter — shown wherever a passphrase is CHOSEN (first run, after a
  reset, and when changing it). Four segments, red → amber → green, with a one-line label and
  the single most useful next improvement.

  Deliberately GUIDANCE, not a gate: the form's own minimum-length rule is what blocks
  submission, and a "weak" passphrase that clears that minimum is still accepted. A meter that
  refuses to let you continue teaches people to satisfy the meter (Password1!) rather than to
  choose something long, which is what actually helps here.

  ── Why segments rather than one filling bar ──────────────────────────────────────────
  The score is ordinal (0–4 buckets), not a percentage. A continuous bar implies a precision
  the scoring doesn't have — and would invite reading "73%" off a heuristic. Four discrete
  segments say "one of four levels" honestly.

  Colour is never the only signal (the label carries the same information in text), so the
  meter still reads for a colour-blind user or in a screenshot printed greyscale.
*/

/** Segment colours per score. Index = score; 0 shares the weak colour (bar is empty anyway). */
const SEGMENT_COLOR = [
  'bg-red-500',
  'bg-red-500',
  'bg-amber-500',
  'bg-lime-500',
  'bg-emerald-500',
] as const

/** Matching text colour for the label, so the word and the bar agree. */
const LABEL_COLOR = [
  'text-ink-muted',
  'text-red-600 dark:text-red-400',
  'text-amber-600 dark:text-amber-400',
  'text-lime-600 dark:text-lime-400',
  'text-emerald-600 dark:text-emerald-400',
] as const

export function PassphraseStrength({ value }: { value: string }) {
  const { t } = useI18n()

  // Nothing typed yet — render nothing rather than an empty red bar, which would scold someone
  // for not having started. The meter appears with the first keystroke.
  if (!value) return null

  const { score, label, hint } = scorePassphrase(value)

  return (
    <div className="mt-2 space-y-1.5">
      {/*
        The bar. `aria-hidden` because the label below already states the strength in words —
        announcing four anonymous divs adds noise for a screen reader without adding meaning.
        Transitions are 300ms per the brand's interaction timing and are suppressed globally
        under prefers-reduced-motion (index.css), so no per-component guard is needed.
      */}
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((seg) => (
          <div
            key={seg}
            className={[
              'h-1 flex-1 rounded-full transition-colors duration-300 ease-smooth',
              seg <= score ? SEGMENT_COLOR[score] : 'bg-line',
            ].join(' ')}
          />
        ))}
      </div>

      {/*
        Label + hint on one row: the verdict, then what to do about it. `aria-live="polite"`
        so a screen-reader user hears the strength change as they type, without it interrupting
        each keystroke.
      */}
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs" aria-live="polite">
        <span className={`font-medium ${LABEL_COLOR[score]}`}>{t(`unlock.strength.${label}`)}</span>
        {hint && <span className="text-ink-muted">{t(`unlock.strengthHint.${hint}`)}</span>}
      </p>
    </div>
  )
}
