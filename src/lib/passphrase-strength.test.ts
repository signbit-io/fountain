import { describe, it, expect } from 'vitest'
import { scorePassphrase, MIN_PASSPHRASE_LENGTH } from './passphrase-strength.js'

/*
  Strength-meter tests. The meter is GUIDANCE, not a gate — so what's pinned here is that its
  advice points the right way, not that any particular passphrase lands on a particular number.

  The one property worth defending hardest: LENGTH must beat character variety. Against an
  offline attacker holding the keystore file, the search space grows exponentially in length and
  only linearly in alphabet size — a meter that rewarded `Passw0rd!` over a long lowercase
  passphrase would actively push people toward the weaker of the two.
*/

describe('scorePassphrase', () => {
  it('rejects anything under the hard minimum as tooShort', () => {
    for (const pass of ['', 'a', 'short', 'seven77']) {
      const s = scorePassphrase(pass)
      expect(s.score).toBe(0)
      expect(s.label).toBe('tooShort')
      expect(s.hint).toBe('longer')
    }
  })

  it('treats exactly the minimum length as acceptable but weak', () => {
    const s = scorePassphrase('x'.repeat(MIN_PASSPHRASE_LENGTH - 1))
    expect(s.label).toBe('tooShort')

    // At the floor it is allowed — the meter says "weak", the form still accepts it.
    const atFloor = scorePassphrase('mK7pQ2wZ')
    expect(atFloor.score).toBeGreaterThan(0)
    expect(atFloor.label).not.toBe('tooShort')
  })

  it('scores a long lowercase passphrase ABOVE a short mixed-charset one', () => {
    // The headline property. `Passw0rd!` is the classic charset-checklist winner and is weak;
    // a long ordinary phrase is strong. If this inverts, the meter is teaching the wrong lesson.
    const longPhrase = scorePassphrase('correct horse battery staple')
    const shortMixed = scorePassphrase('Pw7!kQ2x')

    expect(longPhrase.score).toBeGreaterThan(shortMixed.score)
    expect(longPhrase.label).toBe('strong')
  })

  it('increases monotonically as length grows', () => {
    // Pattern-free samples, each a prefix of the next, so LENGTH is the only variable. (An
    // earlier version of this fixture used runs like "…stuvwxy" and was correctly penalised
    // by the sequence rule — the scorer was right and the test data was wrong.)
    const base = 'krfmvjptwqbnhxgdlszc'
    const scores = [8, 12, 16, 20].map((n) => scorePassphrase(base.slice(0, n)).score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1])
    }
    // And the ends must genuinely differ — a flat line would pass the loop above vacuously.
    expect(scores[scores.length - 1]).toBeGreaterThan(scores[0])
  })

  it('penalises repeated-character passphrases regardless of length', () => {
    // Long but trivially guessable — length alone must not carry it.
    const s = scorePassphrase('aaaaaaaaaaaaaaaaaaaa')
    expect(s.score).toBeLessThanOrEqual(2)
    expect(s.hint).toBe('avoidPattern')
  })

  it('penalises keyboard walks and digit runs', () => {
    for (const pass of ['qwertyuiop123', 'abcdefghijkl', 'pass123456789']) {
      const s = scorePassphrase(pass)
      expect(s.hint).toBe('avoidPattern')
      expect(s.score).toBeLessThanOrEqual(2)
    }
  })

  it('penalises common passwords even with decoration', () => {
    for (const pass of ['password123', 'bitcoin2026', 'letmein12345']) {
      const s = scorePassphrase(pass)
      expect(s.score).toBeLessThanOrEqual(2)
    }
  })

  it('does NOT penalise a long passphrase that merely contains a common word', () => {
    // "admin" appears, but it's a small share of a long phrase — punishing this would be noise.
    const s = scorePassphrase('my administrator lives on a quiet hill')
    expect(s.hint).not.toBe('avoidPattern')
    expect(s.score).toBeGreaterThanOrEqual(3)
  })

  it('gives a variety hint only once length is already good', () => {
    // A 16+ char single-class passphrase has length covered; the next best advice is a mix.
    const s = scorePassphrase('optimalfrogsjumpwidely')
    expect(s.hint).toBe('variety')
  })

  it('gives a length hint while still short, even with a rich charset', () => {
    const s = scorePassphrase('Kq7!vX2m')
    expect(s.hint).toBe('longer')
  })

  it('returns no hint at full strength', () => {
    const s = scorePassphrase('Tumbling Vellum Harbour 41!')
    expect(s.score).toBe(4)
    expect(s.label).toBe('strong')
    expect(s.hint).toBeNull()
  })

  it('always returns a score within 0..4 and a matching label', () => {
    const labels = ['tooShort', 'weak', 'fair', 'good', 'strong']
    const samples = ['', 'a', 'abcdefgh', 'correct horse', 'Tumbling Vellum Harbour 41!', 'aaaa'.repeat(20)]
    for (const pass of samples) {
      const s = scorePassphrase(pass)
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.score).toBeLessThanOrEqual(4)
      expect(s.label).toBe(labels[s.score])
    }
  })
})
