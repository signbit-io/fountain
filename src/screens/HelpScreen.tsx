import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { HelpDiagram } from '../components/HelpDiagrams'
import { Button, Card, Input } from '../components/ui'
import { useI18n } from '../i18n'
import { HELP_TOPICS, flattenLeaves, topLevelIdOf, type HelpTopic } from '../lib/help-topics'

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/*
  In-app manual — a real topic tree (sections → articles, cross-referenced), fully bundled, no
  external links (this app is air-gapped). The tree SHAPE lives in lib/help-topics.ts; this
  screen only renders it and drives search.

  ⚠️ PAGES, NOT DROPDOWNS (user, 2026-11-11: "not a fan of these multi dropdown layouts ... what
  ends up happening is just a long scrolling and messy vertical"). A section used to open as a
  column of collapsible cards, one per article, so reading two answers meant a long page of
  half-open cards. Now ONE article is on screen at a time:
  - HOME: the sections, each with a hint of what is inside.
  - SECTION: its articles as a ruled list.
  - ARTICLE: one answer, its drawing, "See also" jumps, and Previous / Next through the whole
    manual in order.
  - RESULTS: while searching, a flat list of matching articles with the matching words shown.
  md+ keeps the sections in a sticky left column, so the right side is the page and there is
  no home view there (it opens on the first section). Below md it is one column, with a back
  link on every page.

  Deliberately COMPLEMENTS rather than duplicates the Keys screen "setup guide" modal
  (network/path/export specifics for the app's CURRENT settings) — the `keys.exportPublicKey`
  article links to it live via onOpenKeysGuide (wired in App.tsx to switch tabs + open that
  modal) instead of restating those exact numbers here.
*/
export function HelpScreen({ onOpenKeysGuide }: { onOpenKeysGuide: () => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [sectionId, setSectionId] = useState<string | null>(null)
  const [articleId, setArticleId] = useState<string | null>(null)

  const allLeaves = useMemo(() => flattenLeaves(), [])
  const section = sectionId ? HELP_TOPICS.find((s) => s.id === sectionId) ?? null : null
  const article = articleId ? allLeaves.find((l) => l.id === articleId) ?? null : null

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!q) return null
    return allLeaves.filter((leaf) => {
      const title = t(`help.${leaf.id}.title`).toLowerCase()
      const body = t(`help.${leaf.id}.body`).toLowerCase()
      return title.includes(q) || body.includes(q)
    })
  }, [q, allLeaves, t])

  // Every page starts at the top.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [sectionId, articleId])

  function openSection(id: string) {
    setQuery('')
    setArticleId(null)
    setSectionId(id)
  }
  function openArticle(id: string, keepQuery = false) {
    if (!keepQuery) setQuery('')
    setSectionId(topLevelIdOf(id))
    setArticleId(id)
  }
  function search(value: string) {
    setQuery(value)
    setArticleId(null)
  }

  const articleView = article && (
    <ArticlePage
      article={article}
      allLeaves={allLeaves}
      fromSearch={!!q}
      back={
        q
          ? { label: t('help.backToResults'), onClick: () => setArticleId(null) }
          : { label: t(`help.topics.${topLevelIdOf(article.id)}.title`), onClick: () => setArticleId(null) }
      }
      onOpenKeysGuide={onOpenKeysGuide}
      onOpen={(id) => openArticle(id)}
    />
  )
  const resultsView = results && !article && (
    <SearchResults results={results} query={query} onOpen={(id) => openArticle(id, true)} />
  )

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-[-0.03em] text-ink">{t('help.title')}</h2>
        <p className="mt-1 text-sm text-ink-muted">{t('help.subtitle')}</p>
      </div>

      <Input
        type="search"
        value={query}
        onChange={(e) => search(e.target.value)}
        placeholder={t('help.searchPlaceholder')}
        aria-label={t('help.searchPlaceholder')}
      />

      {/* Below md: one page at a time. */}
      <div className="md:hidden">
        {articleView ||
          resultsView ||
          (section ? (
            <SectionPage
              section={section}
              back={{ label: t('help.backToTopics'), onClick: () => setSectionId(null) }}
              onOpen={(id) => openArticle(id)}
            />
          ) : (
            <SectionList selectedId={null} onSelect={openSection} withHints />
          ))}
      </div>

      {/* md+ (768px+): sections in a sticky left column, the page on the right. */}
      <div className="hidden gap-6 md:grid md:grid-cols-[240px_minmax(0,1fr)] md:items-start lg:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)] 2xl:gap-8">
        {/* top-28 = clear of the sticky header (3.5rem) + tab row (~2.75rem) with a gap. */}
        <nav className="md:sticky md:top-28" aria-label={t('help.title')}>
          <SectionList selectedId={q && !article ? null : section?.id ?? HELP_TOPICS[0].id} onSelect={openSection} />
        </nav>
        <div className="min-w-0">
          {articleView ||
            resultsView || <SectionPage section={section ?? HELP_TOPICS[0]} onOpen={(id) => openArticle(id)} />}
        </div>
      </div>
    </div>
  )
}

/* The sections as one ruled panel. With hints (the phone's home page), each row also names its
   first few articles, so the section's contents are visible before it is opened. */
function SectionList({
  selectedId,
  onSelect,
  withHints = false,
}: {
  selectedId: string | null
  onSelect: (id: string) => void
  withHints?: boolean
}) {
  const { t } = useI18n()
  return (
    <div className="card divide-y divide-line overflow-hidden">
      {HELP_TOPICS.map((s) => {
        const selected = selectedId === s.id
        const children = s.children ?? []
        return (
          <button
            key={s.id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onSelect(s.id)}
            className={cx(
              'flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
              selected ? 'bg-ink text-surface' : 'text-ink hover:bg-ink/[0.025]',
            )}
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{t(`help.topics.${s.id}.title`)}</span>
              {withHints && (
                <span className="mt-0.5 line-clamp-1 text-[13px] text-ink-muted">
                  {children.slice(0, 3).map((c) => t(`help.${c.id}.title`)).join(' · ')}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className={cx('text-xs tabular-nums', selected ? 'text-surface/70' : 'text-ink-muted')}>{children.length}</span>
              <ChevronRightIcon className={cx('h-4 w-4', selected ? 'text-surface/70' : 'text-ink-muted')} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

type Back = { label: string; onClick: () => void }

function BackLink({ back }: { back: Back }) {
  return (
    <button
      type="button"
      onClick={back.onClick}
      className="-ml-1 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <BackIcon className="h-4 w-4" />
      {back.label}
    </button>
  )
}

/* The first sentence of an article, flattened to one line, for the section list's second line. */
function leadOf(body: string): string {
  const flat = body.replace(/^(- |\d+\. )/gm, '').replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  return end > 0 ? flat.slice(0, end + 1) : flat
}

/* One section: its articles as a ruled list, each with its first sentence. */
function SectionPage({ section, back, onOpen }: { section: HelpTopic; back?: Back; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  return (
    <div key={section.id} className="space-y-3 animate-fade-in">
      {back && <BackLink back={back} />}
      <h3 className="text-xl font-semibold tracking-[-0.02em] text-ink">{t(`help.topics.${section.id}.title`)}</h3>
      <ArticleList
        items={(section.children ?? []).map((leaf) => ({ leaf, line: leadOf(t(`help.${leaf.id}.body`)) }))}
        onOpen={onOpen}
      />
    </div>
  )
}

/*
  A list of articles. One ruled panel on a phone; from `lg` a grid of cards (two across, three
  from `2xl`), so a section fills a wide screen instead of a strip of very long rows
  (user, 2026-11-12: "could help subtabs be responsive for widescreens/desktop also?").
*/
function ArticleList({
  items,
  onOpen,
}: {
  items: { leaf: HelpTopic; line: ReactNode; over?: string }[]
  onOpen: (id: string) => void
}) {
  const { t } = useI18n()
  return (
    <ul className="card overflow-hidden lg:grid lg:grid-cols-2 lg:gap-3 lg:overflow-visible lg:border-0 lg:bg-transparent lg:shadow-none lg:dark:ring-0 2xl:grid-cols-3">
      {items.map(({ leaf, line, over }) => (
        <li
          key={leaf.id}
          className="border-t border-line first:border-t-0 lg:border lg:border-line lg:bg-surface-2 lg:shadow-soft lg:first:border-t"
        >
          <button
            type="button"
            onClick={() => onOpen(leaf.id)}
            className="flex h-full w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 sm:px-5 lg:items-start lg:py-4"
          >
            <span className="min-w-0 flex-1">
              {over && <span className="block text-xs text-ink-muted">{over}</span>}
              <span className="block text-[15px] font-semibold tracking-[-0.01em] text-ink">{t(`help.${leaf.id}.title`)}</span>
              <span className="mt-0.5 line-clamp-2 text-[13px] text-ink-muted lg:mt-1">{line}</span>
            </span>
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-muted lg:mt-0.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/*
  Search results: every matching article in manual order, each with its section above the
  title and the words around the first match below it (the match itself in bold), so the right
  answer can be picked without opening each one.
*/
function SearchResults({ results, query, onOpen }: { results: HelpTopic[]; query: string; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  const q = query.trim()
  if (results.length === 0) {
    return <Card className="text-sm text-ink-muted animate-fade-in">{t('help.searchNoResults', { query: q })}</Card>
  }
  return (
    <div className="space-y-2 animate-fade-in">
      <p className="px-1 text-xs tabular-nums text-ink-muted">
        {t(results.length === 1 ? 'help.searchResultsCount' : 'help.searchResultsCountPlural', { count: results.length })}
      </p>
      <ArticleList
        items={results.map((leaf) => ({
          leaf,
          over: t(`help.topics.${topLevelIdOf(leaf.id)}.title`),
          line: <Snippet body={t(`help.${leaf.id}.body`)} query={q} />,
        }))}
        onOpen={onOpen}
      />
    </div>
  )
}

/* The words around the first match in an article's body, the match in bold. A title-only
   match shows the body's opening instead. React text only, never HTML. */
function Snippet({ body, query }: { body: string; query: string }) {
  const flat = body.replace(/^(- |\d+\. )/gm, '').replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return <>{leadOf(body)}</>
  const from = Math.max(0, at - 60)
  const to = Math.min(flat.length, at + query.length + 100)
  return (
    <>
      {from > 0 && '… '}
      {flat.slice(from, at)}
      <strong className="font-semibold text-ink">{flat.slice(at, at + query.length)}</strong>
      {flat.slice(at + query.length, to)}
      {to < flat.length && ' …'}
    </>
  )
}

/*
  One article, on its own: drawing, text, "See also", and Previous / Next through the manual.

  Wide screens (2026-11-12): the article takes the full width of the page instead of a fixed
  narrow column that left half the screen empty. The article itself stays ONE column, drawing
  above text (user, 2026-11-12: "id rather the article page have 1 col"). From `xl` a sticky
  column to its LEFT, level with the top of the page, lists the other articles in this section and the
  "See also" jumps, so moving around a section is one click without going back.
*/
function ArticlePage({
  article,
  allLeaves,
  back,
  fromSearch,
  onOpenKeysGuide,
  onOpen,
}: {
  article: HelpTopic
  allLeaves: HelpTopic[]
  back: Back
  /** Opened from search results: the back link says so, so the section is named above the title. */
  fromSearch: boolean
  onOpenKeysGuide: () => void
  onOpen: (id: string) => void
}) {
  const { t } = useI18n()
  const at = allLeaves.findIndex((l) => l.id === article.id)
  const prev = at > 0 ? allLeaves[at - 1] : null
  const next = at >= 0 && at < allLeaves.length - 1 ? allLeaves[at + 1] : null
  const sectionId = topLevelIdOf(article.id)
  const siblings = HELP_TOPICS.find((s) => s.id === sectionId)?.children ?? []
  const refs = article.crossRefs ?? []

  const seeAlso = refs.length > 0 && (
    <section className="space-y-2">
      <h4 className="px-1 text-[13px] font-semibold text-ink-muted">{t('help.crossRefLabel')}</h4>
      <div className="card divide-y divide-line overflow-hidden">
        {refs.map((refId) => (
          <button
            key={refId}
            type="button"
            onClick={() => onOpen(refId)}
            className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-ink/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-ink-muted">{t(`help.topics.${topLevelIdOf(refId)}.title`)}</span>
              <span className="block font-semibold text-ink">{t(`help.${refId}.title`)}</span>
            </span>
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-muted" />
          </button>
        ))}
      </div>
    </section>
  )

  return (
    /*
      ONE grid for the whole page, so the right column starts at the very top of the page, on
      the same line as the back link and the sections list on the left (user, 2026-11-12:
      "improve the alignment of in this section ... aligned near the top of the article page").
      Its title sits INSIDE the card as a ruled header, so the card's top edge is that line.
      The column is on the LEFT of the article, next to the sections list (user, 2026-11-12:
      "try, the section on the left side and article right side"); `xl:order-first` puts it
      there while the article stays first in the page for a phone and a screen reader.
    */
    <article
      key={article.id}
      className="grid gap-6 animate-fade-in xl:grid-cols-[18rem_minmax(0,1fr)] xl:items-start 2xl:grid-cols-[20rem_minmax(0,1fr)] 2xl:gap-8"
    >
      <div className="min-w-0 space-y-4">
        <BackLink back={back} />
        <div>
          {fromSearch && <p className="text-[13px] text-ink-muted">{t(`help.topics.${sectionId}.title`)}</p>}
          <h3 className="mt-0.5 text-xl font-semibold tracking-[-0.02em] text-ink xl:text-2xl">{t(`help.${article.id}.title`)}</h3>
        </div>

        {/* One column: the drawing above the text, at every width. */}
        <Card className="space-y-4">
          {article.diagram && <HelpDiagram id={article.diagram} />}
          <BodyText text={t(`help.${article.id}.body`)} />
          {article.id === 'keys.exportPublicKey' && (
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={onOpenKeysGuide}>
              {t('help.guideAction')}
            </Button>
          )}
        </Card>

        {/* Under the article until `xl`; in the right column from there. */}
        {seeAlso && <div className="xl:hidden">{seeAlso}</div>}

        <nav className="grid gap-2 sm:grid-cols-2" aria-label={t('help.title')}>
          {prev ? <PagerLink leaf={prev} direction="prev" onOpen={onOpen} /> : <span className="hidden sm:block" />}
          {next && <PagerLink leaf={next} direction="next" onOpen={onOpen} />}
        </nav>
      </div>

      <aside className="hidden space-y-4 xl:sticky xl:top-28 xl:order-first xl:block">
        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <p className="text-xs text-ink-muted">{t('help.inThisSection')}</p>
            <h4 className="text-sm font-semibold text-ink">{t(`help.topics.${sectionId}.title`)}</h4>
          </div>
          <div className="divide-y divide-line">
            {siblings.map((leaf) => {
              const current = leaf.id === article.id
              return (
                <button
                  key={leaf.id}
                  type="button"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => onOpen(leaf.id)}
                  className={cx(
                    'block min-h-11 w-full border-l-2 px-4 py-2.5 text-left text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
                    current ? 'border-l-brand-500 font-semibold text-ink' : 'border-l-transparent text-ink-muted hover:bg-ink/[0.025] hover:text-ink',
                  )}
                >
                  {t(`help.${leaf.id}.title`)}
                </button>
              )
            })}
          </div>
        </section>
        {seeAlso}
      </aside>
    </article>
  )
}

function PagerLink({ leaf, direction, onOpen }: { leaf: HelpTopic; direction: 'prev' | 'next'; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  const isNext = direction === 'next'
  return (
    <button
      type="button"
      onClick={() => onOpen(leaf.id)}
      className={cx(
        'card flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:border-ink/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        isNext ? 'justify-end text-right' : 'text-left',
      )}
    >
      {!isNext && <BackIcon className="h-4 w-4 shrink-0 text-ink-muted" />}
      <span className="min-w-0">
        <span className="block text-xs text-ink-muted">{isNext ? t('help.next') : t('help.previous')}</span>
        <span className="block text-sm font-semibold text-ink">{t(`help.${leaf.id}.title`)}</span>
      </span>
      {isNext && <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-muted" />}
    </button>
  )
}

/*
  A Help body is plain text from the locale files, split into blocks on a blank line. A block
  whose EVERY line starts with "- " is a bullet list; one whose every line starts with "1. ",
  "2. "… is a numbered list; anything else is a paragraph. Rendered as React text only, never as
  HTML, so no translation can inject markup, and a block that mixes the two simply stays a
  paragraph rather than half-parsing. Search runs over the raw string, markers included.
*/
const NUMBERED = /^\d+\. /

function BodyText({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-ink">
      {text.split('\n\n').map((block, i) => {
        const lines = block.split('\n')
        if (lines.every((line) => line.startsWith('- '))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5 marker:text-ink-muted">
              {lines.map((line, j) => <li key={j}>{line.slice(2)}</li>)}
            </ul>
          )
        }
        if (lines.every((line) => NUMBERED.test(line))) {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5 marker:text-ink-muted">
              {lines.map((line, j) => <li key={j}>{line.replace(NUMBERED, '')}</li>)}
            </ol>
          )
        }
        return <p key={i}>{block}</p>
      })}
    </div>
  )
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}
