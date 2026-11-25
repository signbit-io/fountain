import { describe, expect, it } from 'vitest'
import en from '../i18n/locales/en.json'
import { HELP_TOPICS, findTopic, flattenLeaves } from './help-topics'

/*
  The Help tree (help-topics.ts) and its copy (en.json `help.*`) are two files that must agree,
  and until 2026-11-11 nothing checked it. Both ways it goes wrong render something broken
  with no error anywhere:
  - a cross-ref to an id that is not a leaf renders the RAW KEY as a dead button;
  - a section removed from the tree leaves `help.topics.<id>.title` (and its bodies) behind in
    every locale, which `i18n:report` cannot see because the key exists in all four.
*/

type Tree = { [key: string]: string | Tree }
const help = (en as unknown as { help: Tree }).help

const at = (path: string): unknown =>
  path.split('.').reduce<unknown>((node, k) => (node as Tree | undefined)?.[k], help)

const leaves = flattenLeaves()
const sectionIds = HELP_TOPICS.map((s) => s.id)

describe('help topic tree ↔ en.json', () => {
  it('every leaf has a title and a body in en', () => {
    const missing = leaves.flatMap((leaf) =>
      ['title', 'body'].filter((f) => typeof at(`${leaf.id}.${f}`) !== 'string').map((f) => `${leaf.id}.${f}`),
    )
    expect(missing).toEqual([])
  })

  it('every section has a title in en', () => {
    expect(sectionIds.filter((id) => typeof at(`topics.${id}.title`) !== 'string')).toEqual([])
  })

  it('every cross-ref lands on a leaf (a dangling one renders the raw key as a dead button)', () => {
    const all = [...HELP_TOPICS, ...HELP_TOPICS.flatMap((s) => s.children ?? [])]
    const dangling = all.flatMap((t) =>
      (t.crossRefs ?? []).filter((ref) => {
        const target = findTopic(ref)
        return !target || !!target.children?.length
      }).map((ref) => `${t.id} → ${ref}`),
    )
    expect(dangling).toEqual([])
  })

  it('no section title in en is left over from a section that left the tree', () => {
    const titled = Object.keys((help.topics as Tree) ?? {})
    expect(titled.filter((id) => !sectionIds.includes(id))).toEqual([])
  })

  it('no leaf copy in en is left over from a leaf that left the tree', () => {
    const leafIds = new Set(leaves.map((l) => l.id))
    const orphans = sectionIds.flatMap((section) =>
      Object.keys((help[section] as Tree | undefined) ?? {})
        .map((leaf) => `${section}.${leaf}`)
        .filter((id) => !leafIds.has(id)),
    )
    expect(orphans).toEqual([])
  })

  it('leaf ids are unique and sit under their own section', () => {
    const ids = leaves.map((l) => l.id)
    expect(ids.length).toBe(new Set(ids).size)
    for (const section of HELP_TOPICS) {
      for (const leaf of section.children ?? []) expect(leaf.id.startsWith(`${section.id}.`)).toBe(true)
    }
  })
})
