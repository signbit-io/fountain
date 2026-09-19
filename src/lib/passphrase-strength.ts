/*
  Passphrase strength scoring — pure, dependency-free, testable.

  Shown wherever a passphrase is CHOSEN (first run, after a reset, and when changing it). Its
  job is guidance, not enforcement: the hard floor stays MIN_PASSPHRASE_LENGTH, and a weak-but-
  long-enough passphrase is still accepted. A meter that blocks submission teaches people to
  game the meter; one that informs teaches them what actually helps.

  ── Why not zxcvbn ───────────────────────────────────────────────────────────────────
  The obvious library is ~800 KB of frequency dictionaries. This app is air-gapped, ships as a
  portable binary people are told to verify, and pins every dep for auditability — a dictionary
  blob to draw a coloured bar is the wrong trade. The scoring below is deliberately cruder and
  says so in the UI (it's a hint, not a verdict).

  ── What it scores, and why LENGTH dominates ─────────────────────────────────────────
  Against this threat model the attacker has the keystore FILE and guesses OFFLINE (see the
  keystore notes in lib/crypto.ts: the scrypt cost is the real defense). Offline guessing makes
  length worth far more than character variety: a 20-character passphrase of nothing but
  lowercase words has a vastly larger search space than 8 characters of mixed symbols, because
  the space grows exponentially in length and only linearly in alphabet size.

  So: length carries most of the score, variety contributes a little, and obvious patterns are
  penalised. Deliberately NOT a charset-class checklist ("needs 1 upper, 1 digit, 1 symbol") —
  that rule is what produces `Password1!`, which is both miserable to type and weak.
*/

/** Hard minimum, enforced at every place a passphrase is set. Matches the first-run gate. */
export const MIN_PASSPHRASE_LENGTH = 8

/** 0 = unusable, 4 = strong. Ordinal buckets, not a percentage. */
export type StrengthScore = 0 | 1 | 2 | 3 | 4

export type Strength = {
  score: StrengthScore
  /** i18n key suffix for the label under the bar (`unlock.strength.<label>`). */
  label: 'tooShort' | 'weak' | 'fair' | 'good' | 'strong'
  /** i18n key suffix for the single most useful next improvement, or null when strong. */
  hint: 'longer' | 'variety' | 'avoidPattern' | null
}

/** Sequential runs (abcd, 1234) and keyboard walks — cheap for a cracker, invisible to a user. */
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

/** A handful of passwords so common that any real cracking run tries them in its first seconds. */
const COMMON = [
  'password',
  'passphrase',
  'letmein',
  'welcome',
  'admin',
  'qwerty',
  'iloveyou',
  'monkey',
  'dragon',
  'bitcoin',
  'satoshi',
  'signbit',
]

/** How many distinct character CLASSES are used (lower/upper/digit/symbol) — 1 to 4. */
function classCount(pass: string): number {
  let n = 0
  if (/[a-z]/.test(pass)) n++
  if (/[A-Z]/.test(pass)) n++
  if (/[0-9]/.test(pass)) n++
  if (/[^a-zA-Z0-9]/.test(pass)) n++
  return n
}

/** True when the passphrase is mostly one repeated character (aaaaaaaa, ababab). */
function isLowVariety(pass: string): boolean {
  const distinct = new Set(pass.toLowerCase()).size
  return distinct <= Math.max(2, Math.floor(pass.length / 4))
}

/** True when it contains a run of 4+ from a known sequence, forwards or backwards. */
function hasSequence(pass: string): boolean {
  const lower = pass.toLowerCase()
  for (const seq of SEQUENCES) {
    const back = [...seq].reverse().join('')
    for (let i = 0; i + 4 <= seq.length; i++) {
      if (lower.includes(seq.slice(i, i + 4)) || lower.includes(back.slice(i, i + 4))) return true
    }
  }
  return false
}

/** True when a well-known password makes up a substantial part of the input. */
function hasCommonWord(pass: string): boolean {
  const lower = pass.toLowerCase()
  // Substring match, not equality — `bitcoin123` is a `bitcoin` variant a cracker tries early.
  // Requiring the word to be a real share of the input keeps a long passphrase that happens to
  // contain "admin" from being punished for it.
  return COMMON.some((w) => lower.includes(w) && w.length * 2 >= lower.length)
}

/**
 * Score a candidate passphrase. Pure — no I/O, no state, safe to call on every keystroke.
 *
 * Below the hard minimum the result is always score 0 / `tooShort`, so the meter can never
 * suggest an unacceptably short passphrase is fine.
 */
export function scorePassphrase(pass: string): Strength {
  if (pass.length < MIN_PASSPHRASE_LENGTH) {
    return { score: 0, label: 'tooShort', hint: 'longer' }
  }

  // Length is the dominant term (see the header): the thresholds are what actually move the bar.
  let score = 1
  if (pass.length >= 12) score++
  if (pass.length >= 16) score++
  if (pass.length >= 24) score++

  // Variety is a modest bonus, not a requirement — one step, and only for a genuine mix.
  if (classCount(pass) >= 3 && pass.length >= 12) score++

  // Patterns are penalised hard: they collapse the real search space no matter the length.
  const patterned = isLowVariety(pass) || hasSequence(pass) || hasCommonWord(pass)
  if (patterned) score -= 2

  const clamped = Math.max(0, Math.min(4, score)) as StrengthScore

  // The hint names the ONE thing most worth fixing — a list of every shortcoming reads as
  // nagging and gets ignored. Patterns first (they cap everything else), then length, then mix.
  const hint: Strength['hint'] = patterned
    ? 'avoidPattern'
    : clamped >= 4
      ? null
      : pass.length < 16
        ? 'longer'
        : 'variety'

  const label = (['tooShort', 'weak', 'fair', 'good', 'strong'] as const)[clamped]
  return { score: clamped, label, hint }
}
