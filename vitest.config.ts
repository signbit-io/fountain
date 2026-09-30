import { defineConfig } from 'vitest/config'

// Node environment — the crypto/key libs are pure and run without a DOM. UI
// component tests (if added later) can opt into jsdom per-file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /*
      Vitest's 5s default is too tight for this suite. Several tests do REAL cryptographic work
      — scrypt at N=2^17 (deliberately ~128MB/guess), BIP-32 derivation, and building genuine
      P2WSH descriptors/PSBTs — and a few take >10s on their own. Run in parallel with the rest,
      they starve and time out intermittently, which reads as a broken test rather than a slow
      one. The cost is real and intentional (see lib/crypto.ts on why the KDF is expensive), so
      the timeout moves rather than the crypto.
    */
    testTimeout: 30_000,

    /*
      Per-FILE results, not just a grand total.

      The default 'dot' summary prints one line for the whole run, so a failure means re-running
      to find out even WHICH suite broke — and with crypto-heavy files that is a ~30s round trip
      each time. 'default' lists every file with its own pass/fail count and duration, which also
      makes the slow files visible (they are the ones that time out first under parallel load).
    */
    reporters: ['default'],

    /*
      Name the slowest files instead of leaving it to guesswork. These are genuinely expensive
      (real scrypt + BIP-32), so the point is not to "fix" them but to know which they are when
      the suite gets slower.
    */
    slowTestThreshold: 2_000,
  },
})
