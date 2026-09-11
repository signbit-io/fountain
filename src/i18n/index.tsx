import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import en from './locales/en.json'
import fr from './locales/fr.json'
import es from './locales/es.json'
import de from './locales/de.json'

/*
  Lightweight i18n — no external library. Fully local (bundled JSON, no network fetch),
  which matters here: this app is air-gapped and the WebView blocks remote origins.

  - `en.json` is the source of truth and the type shape for all locales.
  - To add a language: create `locales/<code>.json` mirroring en.json, import it,
    and add it to the `locales` map below. Then any language switcher just sets
    the active locale; English is swapped out automatically.
  - `t('a.b.c')` looks up a dotted key; `t('x', { name: 'Sam' })` fills {{name}}.
  - Missing keys fall back to the ENGLISH value (then, only if en also lacks it,
    to the key string + a dev warning). So we add strings to en.json ONLY and
    other locales can lag — they show English until translated in a batch. Run
    `npm run i18n:report` to list what's still untranslated per locale.
*/

export type Locale = 'en' | 'fr' | 'es' | 'de'
export const DEFAULT_LOCALE: Locale = 'en'

// `en` is the SOURCE OF TRUTH + type shape. Other locales may be PARTIAL —
// any key they're missing falls back to English at runtime (see `t` below). This
// is what lets us add strings to en.json only and translate the rest in batches
// (run `npm run i18n:report` to see what's still English). DeepPartial keeps the
// nested shape but makes every leaf optional.
type Dict = typeof en
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// Register additional locales here as they're added. `en` is the full shape;
// others are typed partial so missing keys don't error.
const locales: { en: Dict } & Record<Exclude<Locale, 'en'>, DeepPartial<Dict>> = {
  en,
  fr,
  es,
  de,
}

// For language switchers — label each available locale.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
}

export const AVAILABLE_LOCALES = Object.keys(locales) as Locale[]

const STORAGE_KEY = 'signbit.locale'

type I18nContextValue = {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function lookup(dict: DeepPartial<Dict>, key: string): string | undefined {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part]
    }
    return undefined
  }, dict) as string | undefined
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{{${name}}}`,
  )
}

function getInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && stored in locales) return stored as Locale
  } catch {
    // localStorage unavailable — fall through to default
  }
  return DEFAULT_LOCALE
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale)

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      // ignore — locale still applies for this session
    }
    document.documentElement.lang = l
  }, [])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const value = lookup(locales[locale], key) ?? lookup(locales[DEFAULT_LOCALE], key)
      if (value === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`)
        return key
      }
      return interpolate(value, vars)
    },
    [locale],
  )

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider')
  return ctx
}
