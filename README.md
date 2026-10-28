<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
  <img src="docs/assets/wordmark-light.svg" width="280" alt="SignBit">
</picture>

# Fountain

**An offline Bitcoin key manager. Generate keys, store them encrypted, sign multisig
transactions, all with no network.**

Your keys are generated on the device, encrypted under your passphrase, and never leave it.
Only the public account key does.

[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-f7931a?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-16181f?style=flat-square)](https://signbit.io/download)
[![Tests](https://img.shields.io/badge/tests-450%20passing-3fb950?style=flat-square)](DEVELOPING.md)

[Download](https://signbit.io/download) &nbsp;·&nbsp; [Verify a build](#verifying-a-build) &nbsp;·&nbsp; [Build it yourself](DEVELOPING.md) &nbsp;·&nbsp; [Security](SECURITY.md)

</div>

---

## What it is

Fountain holds your keys for SignBit collaborative-custody vaults, where several keys are needed
to move money and no single party holds enough on their own. One vault, several vaults, or several
keys in the same vault — it is your keystore, and it holds as many as you want it to.

Nothing here depends on SignBit, though. Fountain writes standard descriptors and signs standard
PSBTs, so any multisig wallet can work with what it produces.

It shares no code, no runtime and no secrets with the SignBit platform. **There is no connection
between them.**

Signing a transaction looks like this. The platform prepares an unsigned transaction. You carry
it to Fountain yourself, as a QR code, a file, or copied text. Fountain shows you what it does,
signs it, and hands it back the same way. Your keys stay where they are, and the only thing that
ever crosses is a transaction you can read.

> GPLv3, because software holding your keys should be readable by the people trusting it, and
> should stay that way.

## What it protects you from

| | |
|---|---|
| ✅ **Someone who steals the file** | From a lost laptop, a backup, or a synced folder. What they get is encrypted, and guessing your passphrase costs roughly 128 MB of memory per attempt. None of that attack happens on screen, so **your passphrase is the whole defence.** Choose a strong one. |
| ❌ **Malware on an unlocked machine** | Anything running as you while Fountain is unlocked can read your keys out of memory. Auto-lock after 5 minutes shortens that window without closing it. |
| ❌ **A payment you approve yourself** | Fountain shows the destination, amount and fee before you sign. Approve a payment to an attacker and it will sign that too. Read the screen. |

**Mainnet works,** and it is worth being clear about what you are trusting. Your keys sit in an
encrypted file on an ordinary computer, protected by your passphrase. That is weaker than a
dedicated hardware signer, and it is the same on either network.

Fountain will not sign a mainnet transaction with a testnet key, or the reverse.

## Verifying a build

Every release is tagged here and published with a checksum, so what you download can be checked
against a tree you can read.

```bash
sha256sum fountain.exe                    # Linux/macOS
certutil -hashfile fountain.exe SHA256    # Windows
```

A matching checksum means your download is exactly the file we published.

From 0.6.4 the Windows build is code-signed by **SignBit Ltd**, so Windows names SignBit Ltd as the
publisher when you run it. A Windows build that shows an unknown publisher is either older than
0.6.4 or not ours, so check its checksum before you trust it.

On Android, Fountain is also on [Google Play](https://play.google.com/store/apps/details?id=io.signbit.fountain).
Google signs the copy it delivers with its own key, so a Play install has no checksum to compare
against. The APK on the download page does, and it installs as a separate app beside the Play one.

Reproducible builds are on the way. [SECURITY.md](SECURITY.md) covers what that will add.

**Or skip the question entirely and [build it yourself](DEVELOPING.md),** which takes us out of
the picture altogether.

## Where your keys live

Your keys are encrypted with your passphrase and kept in a single file.

Fountain looks for a `data` folder next to the program first, and falls back to your user folder
if it cannot write there. A copy on a USB stick therefore keeps its keys with it, while an
installed copy keeps them under your user account.

> ⚠️ **Delete a portable copy's folder and those keys are gone.** Your 24-word phrase is the real
> backup. Write it down, keep it offline, and store it somewhere you would keep anything else
> valuable.

## More

| | |
|---|---|
| [DEVELOPING.md](DEVELOPING.md) | Building from source, the Android build, project layout, where the security-critical code lives |
| [SECURITY.md](SECURITY.md) | What the test suite proves, the known gaps, and how to report a problem |

## License

[GPL-3.0-or-later](./LICENSE) &nbsp;·&nbsp; © 2026 SignBit

Free software: redistribute and modify it under the terms of the GNU General Public License,
version 3 or any later version. Distributed without any warranty, express or implied.
