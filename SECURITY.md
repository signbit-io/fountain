# Security

## Reporting a problem

Please report security issues **privately** rather than opening a public issue.

## What the test suite proves

These are asserted by the suite, and a change that breaks one fails CI.

- **No private material ever leaves.** Only the public account key and its fingerprint come out
  of the export path.
- **Networks cannot be crossed.** Mainnet signing is refused on both signing paths, and a
  transaction is refused outright if its derivation paths belong to a different network than the
  key.
- **Seeds come from the operating system's secure random source.** The entropy path throws rather
  than falling back to a weak generator, and 256-bit draws show no duplicates and no stuck bits.
- **The keystore leaks no plaintext.** A wrong passphrase is rejected, as is any tampering with
  the ciphertext, its authentication tag, the salt or the IV. Fresh salt and IV on every write.
- **A backup cannot weaken you.** Restoring one cannot lower the passphrase-guessing cost below
  the enforced floor, which would otherwise be a way to make an old file cheap to crack.
- **Output matches the platform byte for byte**, pinned by a golden vector, so a vault built here
  and a vault built there cannot silently diverge.

## How keys are stored

Your keys are encrypted with AES-256-GCM, under a key derived from your passphrase with scrypt at
N=2¹⁷, r=8. That costs roughly 128 MB of memory per guess, which is what makes large-scale
guessing expensive rather than merely slow.

The parameters are stored inside the file itself, so raising the cost later never locks anyone
out of a keystore written under the old settings.

**The passphrase is the entire defence** for a stolen file. No rate limit, lockout or screen is
involved in that attack, because the attacker has your file and works offline.

## What to expect today

Two things are on the way, and both are worth knowing before you download.

**Code signing is coming.** Until it lands, Windows shows a SmartScreen warning the first time
you run Fountain. That is what an unsigned program looks like, not a sign that anything is wrong
with this one. Check the SHA-256 against the release, and the warning is safe to click through.

**Reproducible builds are coming.** Today a checksum proves your download matches the file we
published. Once builds are reproducible you will be able to rebuild this source yourself and
confirm it produces that same file, which proves the published binary really was built from the
code you are reading. Until then, building it yourself is the strongest option.

**One limit is permanent, and worth understanding.** While Fountain is unlocked, your keys are
decrypted in memory, so anything already running as you on that machine can read them. No
software signer can avoid this. It is the reason to keep Fountain on a machine you trust, lock
it when you step away, and treat a compromised computer as a compromised key.

## Deliberate design choices

**Files are written and then read back** to confirm they landed, retried once, and an error is
raised if not. Android's file-picker path could otherwise produce a silent 0-byte file, usually
when the filename was edited in the save dialog. A backup someone believes they have but which is
empty is the worst failure this app could have, so it fails loudly instead.

**A QR code is a carrier, not a trust boundary.** Anything scanned in is validated exactly as
pasted text would be. Nothing is trusted because of how it arrived.

**There is no connectivity indicator.** A green "online" dot would contradict the design. Settings
offers an air-gap check that confirms the device is offline, and there is no toggle, because being
offline is a property of the app rather than a setting.
