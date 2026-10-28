# The vault backup cache

> **Deep-dive split out of LLM_CONTEXT.md** to keep that file small enough to read whole.
> Same rules: update it in the same change that alters behavior, and if it contradicts the
> code, the code is right.
>
> **Tracked, not `docs/internal/`.** This describes a local cache of PUBLIC descriptor data
> and the reasoning behind its failure modes — the kind of thing an outside auditor of a
> key-holding tool should be able to read. It names no private repo, path or internal doc.

Covers `lib/vaults.ts`, `lib/build-descriptor.ts` and `screens/VaultsScreen.tsx`: the local
cache of vault descriptors, the offline builder that can produce one from scratch, and the
rules that stop either from silently losing or mixing up a vault.

---

## 1. What the cache is

A vault's descriptor (and change descriptor) is PUBLIC data: xpubs, derivation paths and a
checksum — no secrets. It is the same artifact the SignBit platform makes downloadable from a
vault page.

It exists so that if the platform is ever unreachable, a keyholder who saved their descriptor
can still reconstruct the vault's addresses and verify a PSBT's outputs in a third-party tool
(Sparrow, etc.) using only this public data plus their own key.

Descriptors reach the cache two ways — **pasted/imported** from the platform's `.txt` backup,
or **built from scratch offline** by `lib/build-descriptor.ts`. `lib/vaults.ts` only stores
them; it derives nothing itself.

Stored in `localStorage` (`signbit.vaults`), like `activity.ts`'s settings — public data, so
no encryption needed. It DOES travel inside the encrypted app backup (§6).

---

## 2. Saving is additive; duplicates are named apart

⚠️ **`addVaultBackup` ALWAYS ADDS A ROW — this cache is a reference LIST, not a set** (user
decision, 2026-08-13). Re-saving the same descriptor really does create a second entry.

An earlier build de-duplicated on the descriptor and returned the existing row. That read as a
broken save: `onAdded` appends to the screen's React state unconditionally, so the UI drew a
new card while the message said "nothing was added" — and the card vanished on reload, since
storage only ever held one.

**Duplicates are made tellable apart rather than refused.** `uniqueVaultLabel` suffixes a
colliding label `" (2)"`, `" (3)"`, …

⚠️ That suffix is not cosmetic. The remove modal asks the user to **type the label** to
confirm, so two identically-named vaults make that confirmation unable to say which one is
about to be deleted. It keys on the LABEL, so it also separates two genuinely DIFFERENT vaults
a user gave the same name — the case that made a real deletion ambiguous.

`renameVaultBackup` deliberately does NOT re-uniquify: a deliberate rename is the user's call.
Every save consumes capacity (`lib/limits.ts`), duplicates included.

**Known, accepted consequences:**
- `backup-diff.ts` indexes vaults BY DESCRIPTOR and keeps the first, so Compare/Import shows
  ONE row for a duplicated pair.
- `findMatchingChangeDescriptor` (`psbt-decode.ts`) may pick either copy — harmless, because
  identical descriptors classify change identically.

---

## 3. Deleting exactly one vault

🚨 **`removeVaultBackup` DELETES EXACTLY ONE ROW — never `filter(v => v.id !== id)`, which
deletes every match.**

`newId`'s old fallback was `String(Date.now())`, used whenever `crypto.randomUUID` is absent —
which is any non-secure-context origin, i.e. a plain-HTTP dev/LAN build. Two vaults saved in
the same millisecond therefore shared an id, and ONE confirmed delete silently removed BOTH,
including a vault whose descriptor was completely different from the one the user confirmed.

The fallback now carries a random suffix, but **the single-row splice is the real guard** — the
id fix alone cannot heal rows already written to someone's storage. Removal also falls back to
matching the DESCRIPTOR, because a collided id is regenerated on read (§4) and a caller may be
holding a stale one.

The remove modal shows the **quorum + descriptor checksum**, because the label it asks you to
type is exactly the field that does NOT identify a vault, and this is the last screen before an
irreversible delete.

---

## 4. Healing legacy rows

⚠️ **`readVaultBackups` heals in memory (`healEntries`) — IDS ONLY; it must never drop a row.**

A shared descriptor is a duplicate the user asked for (§2). A shared ID is the genuine defect
(§3), so the collided id is regenerated and both rows survive. Collapsing rows here would
destroy a vault nobody asked to remove — the very bug this undoes.

The heal never writes back, so a read cannot mutate storage as a side effect. The healed shape
persists the next time anything calls `writeVaultBackups`.

---

## 5. Cosigner names and the vault label

**`keyLabels` is keyed by 8-hex master FINGERPRINT, never by position.** `canonicalKeyOrder`
sorts keys before the descriptor is built, so builder row order is NOT descriptor order — an
index-keyed map would attach one person's name to another's key.

A key whose fingerprint is unknown is SKIPPED rather than stored: `normalizeFingerprint`
collapses a blank one to the placeholder `00000000`, and two such keys would both claim that
slot. Optional and always degradable — a vault with no map renders as "Signer N" exactly as
before. Display only: nothing about signing, derivation or verification reads it.

⚠️ Untrusted input on BOTH read paths (localStorage and a restored backup), so
`normalizeKeyLabels` coerces rather than casts.

**Both the vault label and each cosigner name are editable in place** (`renameVaultBackup` /
`setVaultKeyLabel`, inline pencil triggers mirroring the Keys screen's rename). A label is a
local nickname with no cryptographic meaning — not in the descriptor, never in a signature, and
two devices may legitimately call one vault different things. The DESCRIPTOR is the identity
and is still replaced only by remove-and-re-add.

`setVaultKeyLabel` **overwrites** (a person correcting a typo), and each saved copy carries its
own names, so editing one never rewrites another. Clearing a name REMOVES the map entry —
falling back to "Signer N" rather than storing an empty string — and clearing the last one
drops the map entirely.

**The card marks which cosigner is THIS DEVICE** (`summaryThisDevice`, which existed in all
four locales and was rendered nowhere) by matching descriptor fingerprints against the
keystore's derived ones, memoized once at the screen since it is BIP-32 per key. ⚠️ A master
fingerprint is identical across networks for the same seed — fine for a display hint, and
exactly why identity matching must never use it to tell networks apart.

**Each signer row's fingerprint AND full extended public key are copyable** (`CopyInline` in
`components/ui.tsx` — same clipboard path and three states as `CopyButton`, compact so a dense
row does not wrap on a phone; an `aria-label` names the specific value and an `aria-live`
region confirms, since several sit in one row and a silent icon swap is invisible to a screen
reader). This required `parseDescriptorSummary` to keep the **full `xpub` alongside
`xpubShort`** — it previously discarded it at parse time, so the only value on screen was
truncated and useless to paste into another tool. Public data, so nothing is withheld;
re-typing either by eye is how a wrong key gets enrolled.

---

## 6. Names in the app backup

Cosigner names travel inside the encrypted payload like everything else — there is no cleartext
section of that file to leak into. They were included rather than held device-only because
names are the same category as the descriptors already in there (topology and identity), and
excluding them would mean a restore silently drops them while seeds, descriptors and prefs all
survive.

⚠️ **An optional additive field must NOT bump `BACKUP_FORMAT_VERSION`.** `keyLabels` is the
worked example, pinned by tests in both directions: an old backup opens on a new app (field
absent → "Signer N"), and a new backup opens on an OLD app because `normalizePayload` passes
vault objects through whole rather than stripping unknown fields — the names survive unread, and
a re-export from that build still carries them. Bumping would have made every new backup
unreadable by the previous build, on the restore path, for nothing.

**The vault diff reports cosigner-name differences** (`keyLabels`, same
`same`/`onlyDevice`/`onlyBackup`/`differs` shape as `changeDescriptor`, compared as whole maps
so serialization ORDER is never reported as a rename). This is load-bearing: **restore writes
the file's vault list WHOLESALE**, so it does not go through `addVaultBackup` and the file's
names REPLACE the device's outright. Without the field, importing a backup whose only
difference is who the cosigners are called reported "unchanged" and then silently renamed every
one of them.

---

## 7. The offline builder

Builds a vault descriptor from every keyholder's public key with zero platform involvement —
the "coparties in a room together" scenario.

**Keys go through `canonicalKeyOrder()` first**, or two people entering the same key set in a
different order get textually different (though functionally equivalent) descriptors:
`sortedmulti` does NOT reorder the descriptor TEXT, so the checksum differs.

### The one hard refusal: a minority quorum

🔒 **`buildVaultDescriptor` REFUSES `m < floor(n/2) + 1`** — a strict majority
(`minMajorityThreshold`), user decision 2026-08-21. 2-of-5, 3-of-6 and 3-of-8 will not build.

⚠️ **This narrows this library's "warn, never block" rule, deliberately and exactly once.**
Everything else in the builder still only warns — notably `m === n` (3-of-3), which stays a
WARNING (`isNoRedundancyQuorum`) because losing your only spare is a real trade someone can
mean. A minority quorum is not a trade anyone means: a 2-of-5 hands any two of five keyholders
unilateral control while presenting itself as a five-key vault. The refusal lives in the
LIBRARY, not just the form, so a caller outside the UI cannot route around it.

⚠️ **Checked LAST, after every key-level check.** A key set with a malformed xpub *and* a
sub-majority `m` must report the malformed xpub — a policy refusal ordered ahead of a validity
check sends the user to fix the wrong thing. (The SignBit platform's importer paid for that
lesson three times.) `build-descriptor.test.ts` pins the ordering.

⚠️ **The error message carries the whole explanation**, because it is the only place this rule
is stated — a proposed UI note naming the platform's rule was cut, on the grounds that an
air-gapped tool should not assert what another product currently requires.

**What this deliberately does NOT do.** The platform's importer also enforces an absolute floor
(`m ≥ 2`, `n ≥ 3`), which is NOT mirrored here: a **2-of-2** built in this app is legal under the
majority rule but still refused if it is later imported there. That gap is accepted rather than
closed — a majority is a property of any multisig vault and belongs in a general-purpose tool,
while a minimum key count is one product's tier policy and does not. In practice the exposure is
small: 2-of-2 already draws the no-redundancy warning at build time, and 1-of-1 is unreachable
from the form (two keys minimum).

### One click, compare afterwards

**"Build and save vault" builds AND saves.** It was Build → review → Add backup, on the
reasoning that keyholders must compare before saving. ⚠️ **The comparison was kept but MOVED
AFTER the save** (user decision): the descriptor is on screen to compare either way, so gating
the save on a click bought no extra verification and only created a window where a correct,
valuable descriptor existed unsaved.

This is safe because a saved backup is a PUBLIC descriptor CACHE, not an authorization — a
keyholder who finds a mismatch simply removes the entry. The build is still refused unless the
keys parse, so a half-entered key set is never stored.

### The draft

**The in-progress build is persisted** (`readVaultDraft` / `writeVaultDraft` /
`clearVaultDraft`, key `signbit.vault-draft`). Transcribing a room's worth of xpubs is minutes
of work that was previously discarded, silently and totally, by anything unmounting the screen
(the Shell remounts on tab switch) or by an app restart — the only recovery being to ask
everyone to read their key out again.

⚠️ **The draft is NOT the vault cache and is never auto-promoted into it.** Saving is still
driven by an explicit click; it is just the same click that builds. What remains rejected is
saving on mere keystroke-level validity: `filled >= 2` is the builder's only floor, so two keys
entered toward an intended three build a perfectly valid **2-of-2** descriptor for a vault
nobody is a member of, and a draft auto-promoted on every edit would fill the cache the
recovery path depends on with those. A plausible-but-wrong cached vault is worse than a lost
draft — the same reasoning as never fabricating a date instead of showing "not known".

⚠️ **Restored via lazy `useState` initializers, never an effect** — an effect renders the empty
form first and overwrites the draft with it on the next write. An untouched form is not
persisted, and emptying the form CLEARS the stored draft (`isDraftWorthKeeping` is the one
predicate both the UI and the storage layer use, so "there is a draft to discard" can never
disagree with what is stored). A malformed or older-shaped stored draft is discarded or
repaired field-by-field rather than cast and rendered with holes. A save refused by the vault
cap **leaves the draft intact**.

---

## 8. Importing the platform's `.txt` backup

**"Import file" SAVES immediately** — there is no fill-the-form-then-click-Save step. Picking a
vault backup file is unambiguous intent and the file already carries everything a save needs,
so the confirmation click supplied no information and only a chance to lose the work.

⚠️ It could also be a DEAD CLICK: Save is `disabled` while the descriptor field is empty and
`importFile` is async, so the state it set landed in a LATER render than a click following it —
a click in that window hit a still-disabled button and did nothing at all, with no error.

⚠️ **`parseVaultBackupFile` returns the CHANGE descriptor when the file carries both branches,
told apart by the key expressions' CHAIN element (`/0/*` vs `/1/*`), never by line order.** A
change-only file parsed positionally would be stored as the receive descriptor and every
address derived from it would be wrong. A mixed-chain or unrecognised line falls back to
first-non-comment-line behaviour rather than being guessed at.

Both paste and import say whether they saved a NEW vault or a SECOND COPY, naming the
(possibly suffixed) label — never claiming nothing was added, because something always is.
