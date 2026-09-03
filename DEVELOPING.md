# Developing Fountain

Building from source is the intended path, and the one that requires trusting nobody.

## Build

```bash
npm install
npm test            # 341 tests: crypto, key derivation, keystore, entropy, compat vectors
npm run tauri dev   # desktop app
```

You need Node, Rust 1.88 or newer, and on Windows the MSVC C++ toolset plus the Windows SDK
("Desktop development with C++" in the Visual Studio Installer).

Desktop and Android build from one codebase. `src/` (React and TypeScript) and `src-tauri/src/`
(Rust) are shared, and platform differences are handled with `#[cfg(mobile)]` and
`#[cfg(desktop)]`.

## Android

```bash
npm run android                                        # device or emulator, dev build
npx tauri android build --apk --debug --target x86_64  # emulator APK
npx tauri android build --apk                          # device (arm64), release
```

You also need Android Studio (SDK, platform-tools, an emulator image), the NDK (SDK Manager,
SDK Tools, *NDK (Side by side)*), and the Rust targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

On Windows, Developer Mode has to be on. The build needs permission to create symlinks.

> ⚠️ `npm run android` is a **dev build that loads the interface from the Vite dev server over
> your local network**, so it needs a connection. That is the opposite of how the app normally
> works. Build an APK for anything resembling real use.

## Package identity

Two identifiers, deliberately different:

| | |
|---|---|
| `io.signbit.fountain` | Desktop, and a future Play Store build |
| `io.signbit.fountain.direct` | The APK downloaded from signbit.io |

They differ because the two channels are signed with different keys, and Android refuses an
update whose signature does not match the installed copy. One package name could not serve both
without stranding whoever installed from the other.

> 🚨 **A published package name is permanent.** Google never allows it to be reused or renamed,
> and changing it on a sideloaded app orphans every existing install, exactly as losing the
> signing key would.

## Release signing

Release APKs are signed with a key that is not in this repository, so a release build fails
here unless you supply your own. Debug builds and `npm run android` are unaffected.

To build a signed release of your own fork, create `src-tauri/gen/android/app/keystore.properties`:

```properties
storeFile=/absolute/path/to/your-release.jks
keyAlias=your-alias
storePassword=your-passphrase
```

`keyPassword` is optional and falls back to `storePassword`. The file is gitignored.

A release build **fails rather than falling back to the debug key**. That fallback is Android's
default and it is a poor one for a signer: a debug-signed APK installs and behaves normally, so
the mistake surfaces only when a real release cannot update it, and by then every install is
stranded.

> 🚨 **An Android signing key is permanent and cannot be regenerated.** Android installs an
> update only when it is signed by the same key, so losing it strands every existing install:
> the only route forward is uninstall and reinstall, which on a signer destroys the keystore
> holding someone's seed. Back the key up somewhere that survives losing the machine, and record
> its file hash so a restored copy can be checked rather than assumed intact.

## Where the important code lives

Every security-relevant decision is pure TypeScript under `src/lib/`, with its tests beside it.

| Concern | File |
|---|---|
| Key derivation, public key export, PSBT and approval signing | [`lib/key.ts`](src/lib/key.ts) |
| Encrypted keystore (scrypt and AES-256-GCM) | [`lib/crypto.ts`](src/lib/crypto.ts) |
| Seed entropy | [`lib/entropy.test.ts`](src/lib/entropy.test.ts) |
| Whole-state encrypted backup | [`lib/backup.ts`](src/lib/backup.ts) |
| Network resolver and mainnet gate | [`lib/bitcoin-network.ts`](src/lib/bitcoin-network.ts) |
| Reading a PSBT before signing (recipient, change, fee) | [`lib/psbt-decode.ts`](src/lib/psbt-decode.ts) |
| QR transport (frame encode and reassemble) | [`lib/qr.ts`](src/lib/qr.ts) |

The Rust layer is deliberately thin. It reads and writes opaque bytes, all encryption happens in
the tested TypeScript path, and the file path never reaches the WebView.

## How transactions get in and out

Nothing leaves over a network. Three transports carry the same text:

- **Copy and paste.** Always available.
- **A file.** Read as text and handed to the parser. Never executed, never passed to a shell, so
  picking the wrong file just fails to parse. Capped at 1 MB.
- **A QR code.** A small JSON frame envelope, split across several codes when a payload is too
  big for one, stepped through by hand rather than animated.

There is no connectivity indicator, on purpose. A green "online" dot would contradict the whole
design. Settings has an air-gap check that confirms the *device* is offline, and there is no
toggle, because being offline is a property of the app rather than a preference.

## Stack

Tauri 2, React 18, Vite, TypeScript, Tailwind 3.

Crypto is `@bitcoinerlab/descriptors` with `@bitcoinerlab/secp256k1` (pure JavaScript elliptic
curve), `@scure/bip39`, and `@noble/hashes`. Nothing compiles natively, so identical code runs on
desktop, Android and CI. That is why the compatibility vector holds everywhere.

> ⚠️ Use the descriptors package's own bundled bitcoinjs (`descriptors.Psbt`, `signers`,
> `createBitcoinjsLib`), never top-level `bitcoinjs-lib@6`. Mixing them causes a number vs bigint
> clash.

## Releases

**One public commit per release.** Day-to-day work happens in a private repository, where fixes
land as however many commits they take. When those add up to a release, they arrive here as a
single commit describing the release as a whole. So `v0.6.1` is one commit here even if it was a
dozen privately.

That keeps this history readable as a record of what shipped, rather than a transcript of how it
got written.

Each release is tagged `v<version>` and published with a SHA-256 for every artifact. **The
checksum has to correspond to the tagged tree.** Under GPL-3.0 the source offer is what gives the
hash meaning: a checksum nobody can trace back to readable code proves only that two files match.

**A published hash is never edited or removed**, including for superseded versions. People do
install old builds, and a checksum quietly dropped when something newer shipped leaves anyone
still holding that file with no way to check it.
