import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { BACKUP_FORMAT_VERSION } from './backup.js'

/*
  VERSION DRIFT GUARD — the app version is declared in THREE files that cannot import from each
  other, so nothing but a test can keep them in step.

  Same pattern (and same reason) as the `signbit-*` filename contract: a value duplicated across
  a language boundary drifts, and the drift is silent.

    package.json            → `createdWith` stamped into every backup file, and the version
                              shown in Settings. What a user quotes in a bug report.
    src-tauri/Cargo.toml    → stamped into the WINDOWS EXE version resource, i.e. what Explorer
                              shows under Properties → Details. This app ships as a portable exe
                              people are told to verify before trusting it with their keys, so a
                              stale number there is a trust problem, not a cosmetic one.
    src-tauri/tauri.conf.json → installer/bundle metadata, AND the source Tauri derives Android's
                              `versionCode`/`versionName` from.

  ── The failures this prevents ───────────────────────────────────────────────────────
  All quiet, all found late:
   - Settings reports 0.5.1 while the exe properties say 0.5.0 — a user verifying the binary
     before running it sees two different numbers and has no way to tell which is the truth.
   - A backup's `createdWith` records a build that was never shipped.
   - Android refuses to install over the previous build because `versionCode` never moved.

  ⚠️ Deliberately compares STRINGS, not parsed semver: these three must be byte-identical, not
  merely equivalent. `0.5.1` and `0.5.1-beta` would satisfy a loose comparison while producing
  genuinely different artifacts.
*/

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')) as Record<string, unknown>
}

/** The `version = "x.y.z"` line from Cargo.toml's [package] section (first match — the package's
 *  own version, not a dependency's). Parsed with a regex rather than a TOML dep: one field does
 *  not justify adding a parser to an audited signer's dependency tree. */
function cargoVersion(): string {
  const toml = readFileSync(resolve(repoRoot, 'src-tauri/Cargo.toml'), 'utf8')
  const m = /^version\s*=\s*"([^"]+)"/m.exec(toml)
  if (!m) throw new Error('Could not find a version in src-tauri/Cargo.toml')
  return m[1]
}

describe('version drift — the three declarations must agree', () => {
  /*
    Read all three INSIDE the test, not at module scope.

    ⚠️ Module-scope reads happen at import time, which can be seconds before the assertion runs.
    That is not hypothetical: bumping 0.5.0 → 0.5.1 while a suite was already in flight made this
    guard fail on files that were in fact consistent by the time anyone looked — a false alarm on
    the one test whose whole job is telling you a version is wrong. Reading at assertion time
    makes the failure mean what it says.
  */
  function versions() {
    return {
      pkg: readJson('package.json').version as string,
      tauri: (readJson('src-tauri/tauri.conf.json').version as string) ?? '',
      cargo: cargoVersion(),
    }
  }

  it('all three declare the same version', () => {
    const { pkg, tauri, cargo } = versions()
    /*
      Asserted as ONE object rather than three separate `toBe`s so a failure names every file and
      its value at once. Three isolated assertions would report only the first mismatch, leaving
      you to re-run to discover the second — during a release bump, which is exactly when you are
      moving fast and least want a partial answer.
    */
    expect({
      'package.json': pkg,
      'src-tauri/Cargo.toml': cargo,
      'src-tauri/tauri.conf.json': tauri,
    }).toEqual({
      'package.json': pkg,
      'src-tauri/Cargo.toml': pkg,
      'src-tauri/tauri.conf.json': pkg,
    })
  })

  it('the version is well-formed semver-ish (x.y.z)', () => {
    // Tauri requires a major.minor.patch triple; Android's versionCode derivation depends on it.
    expect(versions().pkg).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('backup format version — bump only on a STRUCTURAL change', () => {
  it('is pinned to 1', () => {
    /*
      ⚠️ This is NOT the app version and must not track it. `version` in a backup file is the
      FORMAT CONTRACT that `readBackup` branches on: a file whose version exceeds the running
      app's is refused outright ("made by a newer version of SignBit").

      So bumping it in step with an app release would make every new backup unreadable by the
      previous build for no reason at all — on the restore path, which is exactly where that
      failure is least affordable.

      Change this ONLY when BackupFile/BackupPayload gains or changes a field, and when you do,
      update this test in the same commit as a deliberate act. A failure here means someone
      bumped the format by reflex while bumping the app.
    */
    expect(BACKUP_FORMAT_VERSION).toBe(1)
  })
})
