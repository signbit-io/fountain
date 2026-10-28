import { describe, it, expect } from 'vitest'
import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve, sep } from 'node:path'

/*
  A comment that names a test is a claim that something is pinned. `build-descriptor.ts` said
  its port of the platform builder was "pinned by build-descriptor.drift.test.ts" for weeks
  after no such file existed (2026-10-04 sweep), which is how a reader concludes a guarantee
  holds that nothing enforces. So every test file a source comment names must exist.
*/
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('every test a source comment names exists', () => {
  it('names only real test files', () => {
    const files = globSync('src/**/*.{ts,tsx}', { cwd: repoRoot }).map((f) => f.split(sep).join('/'))
    const tests = new Set(files.filter((f) => f.includes('.test.')).map((f) => basename(f)))
    expect(tests.size, 'the glob must find the suite').toBeGreaterThan(10)

    const missing = files
      .filter((f) => !f.includes('.test.'))
      .flatMap((f) =>
        [...readFileSync(resolve(repoRoot, f), 'utf8').matchAll(/[\w.-]+\.test\.tsx?/g)]
          .map((m) => m[0])
          .filter((name) => !tests.has(name))
          .map((name) => `${f}: ${name}`),
      )
    expect(missing).toEqual([])
  })
})
