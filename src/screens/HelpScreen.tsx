import { useMemo, useState } from 'react'
import { Button, Card, CollapsibleCard, Input } from '../components/ui'
import { useI18n } from '../i18n'
import { HELP_TOPICS, flattenLeaves, topLevelIdOf, type HelpTopic } from '../lib/help-topics'

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/*
  In-app manual — a real topic tree (major topics → subtopics, cross-referenced), not a
  flat wall of text. Fully bundled, no external links (this app is air-gapped). The tree
  SHAPE lives in lib/help-topics.ts; this screen only renders it and drives search.

  Selecting a TOP-LEVEL TOPIC (not a subtopic) opens its detail view — every one of that
  topic's subtopics rendered together as its own CollapsibleCard (organized, but no need to
  open a subtopic to see it's there; collapsing just tidies a long topic). `selectedTopicId`
  is the one piece of state driving both layouts:
  - **lg+ (wide):** topics list in a left sidebar, the selected topic's full detail (all its
    subtopic cards) in a reading pane on the right — both panes always visible.
  - **below lg (mobile/narrow):** a single column. With nothing selected, it's the topic
    list. Selecting one swaps the WHOLE view to a full-screen detail pane with a back arrow.

  Search filters the topic list at every width (typing narrows which topics match, checking
  every subtopic's title+body) — selecting a matching topic opens it exactly like normal.

  Deliberately COMPLEMENTS rather than duplicates the existing Keys screen "setup guide"
  modal (network/path/export specifics for the app's CURRENT settings) — the Keys topic's
  "exportPublicKey" subtopic links to it live via onOpenKeysGuide (wired in App.tsx to
  switch tabs + open that modal) instead of restating those exact numbers here.
*/
export function HelpScreen({ onOpenKeysGuide }: { onOpenKeysGuide: () => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)

  const allLeaves = useMemo(() => flattenLeaves(), [])
  const selectedTopic = selectedTopicId ? HELP_TOPICS.find((topic) => topic.id === selectedTopicId) ?? null : null

  const q = query.trim().toLowerCase()
  const matchingLeafIds = useMemo(() => {
    if (!q) return null
    const set = new Set<string>()
    for (const leaf of allLeaves) {
      const title = t(`help.${leaf.id}.title`).toLowerCase()
      const body = t(`help.${leaf.id}.body`).toLowerCase()
      if (title.includes(q) || body.includes(q)) set.add(leaf.id)
    }
    return set
  }, [q, allLeaves, t])

  const matchingTopicIds = useMemo(() => {
    if (!matchingLeafIds) return null
    const set = new Set<string>()
    for (const leafId of matchingLeafIds) set.add(topLevelIdOf(leafId))
    return set
  }, [matchingLeafIds])

  function selectTopic(id: string) {
    setSelectedTopicId(topLevelIdOf(id))
  }

  const topicList = (
    <TopicList
      matchingTopicIds={matchingTopicIds}
      matchingLeafCount={matchingLeafIds?.size ?? null}
      query={query}
      selectedTopicId={selectedTopicId}
      onSelectTopic={selectTopic}
    />
  )

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('help.title')}</h2>
        <p className="mt-1 text-sm text-ink-muted">{t('help.subtitle')}</p>
      </div>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('help.searchPlaceholder')}
        aria-label={t('help.searchPlaceholder')}
      />

      {/* Mobile/narrow (below md): topic list OR full-screen detail view, never both. */}
      <div className="md:hidden">
        {selectedTopic ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setSelectedTopicId(null)}
              className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
            >
              <BackIcon className="h-4 w-4" />
              {t('help.backToTopics')}
            </button>
            <TopicDetail
              topic={selectedTopic}
              matchingLeafIds={matchingLeafIds}
              onOpenKeysGuide={onOpenKeysGuide}
              onJump={selectTopic}
            />
          </div>
        ) : (
          topicList
        )}
      </div>

      {/* md+ (768px+): topics in a left sidebar, selected topic's detail in a reading pane on
          the right — both always visible. items-start so the sidebar doesn't stretch to
          match a much-taller detail pane once a topic with many subtopics is open. The
          min-height claims most of the viewport below the tab nav so the split reads as a
          real two-pane layout at rest, not a small box floating in empty space. */}
      <div className="hidden gap-6 md:grid md:min-h-[calc(100vh-16rem)] md:grid-cols-[280px_minmax(0,1fr)] md:items-start lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="md:sticky md:top-24">{topicList}</div>
        {selectedTopic ? (
          <TopicDetail
            topic={selectedTopic}
            matchingLeafIds={matchingLeafIds}
            onOpenKeysGuide={onOpenKeysGuide}
            onJump={selectTopic}
          />
        ) : (
          <Card className="flex min-h-[calc(100vh-16rem)] flex-col items-center justify-center gap-3 text-center">
            <HelpGlyph className="h-10 w-10 text-ink-muted/40" />
            <p className="text-sm text-ink-muted">{t('help.pickATopic')}</p>
          </Card>
        )}
      </div>
    </div>
  )
}

/* The left-hand (or mobile-only) topic list — one row per top-level topic, no subtopics
   shown here at all; picking a topic opens its full detail elsewhere. */
function TopicList({
  matchingTopicIds,
  matchingLeafCount,
  query,
  selectedTopicId,
  onSelectTopic,
}: {
  matchingTopicIds: Set<string> | null
  matchingLeafCount: number | null
  query: string
  selectedTopicId: string | null
  onSelectTopic: (id: string) => void
}) {
  const { t } = useI18n()
  const visibleTopics = matchingTopicIds ? HELP_TOPICS.filter((topic) => matchingTopicIds.has(topic.id)) : HELP_TOPICS

  if (matchingTopicIds && visibleTopics.length === 0) {
    return <Card className="text-sm text-ink-muted">{t('help.searchNoResults', { query })}</Card>
  }

  return (
    <div className="space-y-2">
      {matchingTopicIds && matchingLeafCount !== null && (
        <p className="px-1 text-xs text-ink-muted">
          {t(matchingLeafCount === 1 ? 'help.searchResultsCount' : 'help.searchResultsCountPlural', {
            count: matchingLeafCount,
          })}
        </p>
      )}
      {visibleTopics.map((topic) => (
        <button
          key={topic.id}
          type="button"
          onClick={() => onSelectTopic(topic.id)}
          className={cx(
            'flex w-full items-center justify-between gap-2 border p-3 text-left text-sm font-semibold shadow-soft transition-colors',
            selectedTopicId === topic.id
              ? 'border-brand-500/40 bg-brand-500/10 text-brand-700 dark:text-brand-400'
              : 'border-line bg-surface-2 text-ink hover:bg-surface',
          )}
        >
          {t(`help.topics.${topic.id}.title`)}
          <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-muted" />
        </button>
      ))}
    </div>
  )
}

/*
  A topic's full detail view: every one of its subtopics, each its own CollapsibleCard.
  Collapsed by default — a topic can have several subtopics and most visits are "I want
  one specific answer," not "read this whole page." A search match forces its card open
  (via `key`, which remounts CollapsibleCard with defaultOpen=true) so the highlighted hit
  is never hidden behind a click.
*/
function TopicDetail({
  topic,
  matchingLeafIds,
  onOpenKeysGuide,
  onJump,
}: {
  topic: HelpTopic
  matchingLeafIds: Set<string> | null
  onOpenKeysGuide: () => void
  onJump: (id: string) => void
}) {
  const { t } = useI18n()

  /*
    While SEARCHING, matches float to the top of their topic.

    Without this, a hit could sit eighth in a long topic and the user has to scroll a list of
    non-matches to reach the thing they searched for. Sorting is stable and only applies when a
    search is active — with the box empty the author's deliberate ordering (concepts before
    edge cases) is what the user should get.
  */
  const leaves = topic.children ?? []
  const ordered = matchingLeafIds
    ? [...leaves].sort((a, b) => Number(matchingLeafIds.has(b.id)) - Number(matchingLeafIds.has(a.id)))
    : leaves

  return (
    <div className="space-y-3 animate-fade-in">
      <h3 className="text-lg font-semibold text-ink">{t(`help.topics.${topic.id}.title`)}</h3>
      {ordered.map((leaf) => {
        const isMatch = !!matchingLeafIds?.has(leaf.id)
        return (
          <CollapsibleCard
            key={`${leaf.id}:${isMatch}`}
            storageKey={`help.subtopic.${leaf.id}`}
            defaultOpen={isMatch}
            className={isMatch ? 'ring-1 ring-brand-500/40' : undefined}
            title={
              <h4 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-ink">
                {t(`help.${leaf.id}.title`)}
                {/* A labelled marker, not a bare dot. The dot alone read as a flag on the card
                    ("starred"/"important") rather than as feedback about the search that just
                    ran, which is the one thing it actually means. */}
                {isMatch && (
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-brand-700 dark:text-brand-400">
                    {t('help.searchMatch')}
                  </span>
                )}
              </h4>
            }
          >
            <SubtopicBody leaf={leaf} onOpenKeysGuide={onOpenKeysGuide} onJump={onJump} />
          </CollapsibleCard>
        )
      })}
    </div>
  )
}

function SubtopicBody({
  leaf,
  onOpenKeysGuide,
  onJump,
}: {
  leaf: HelpTopic
  onOpenKeysGuide: () => void
  onJump: (id: string) => void
}) {
  const { t } = useI18n()
  const isKeysExportTopic = leaf.id === 'keys.exportPublicKey'

  return (
    <div className="space-y-2">
      <div className="space-y-2 text-sm text-ink">
        {t(`help.${leaf.id}.body`)
          .split('\n\n')
          .map((para, i) => (
            <p key={i}>{para}</p>
          ))}
      </div>

      {isKeysExportTopic && (
        <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={onOpenKeysGuide}>
          {t('help.guideAction')}
        </Button>
      )}

      {!!leaf.crossRefs?.length && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2 text-xs">
          <span className="text-ink-muted">{t('help.crossRefLabel')}</span>
          {leaf.crossRefs.map((refId) => (
            <button
              key={refId}
              type="button"
              onClick={() => onJump(refId)}
              className="text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
            >
              {t(`help.topics.${topLevelIdOf(refId)}.title`)} · {t(`help.${refId}.title`)}
            </button>
          ))}
        </div>
      )}
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

function HelpGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2 1.8-2 3.5" />
      <path d="M12 17h.01" />
    </svg>
  )
}
