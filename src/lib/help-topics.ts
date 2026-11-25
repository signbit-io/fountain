/*
  The Help tab's information architecture: topics → subtopics, with cross-references
  between related leaves. This file owns the TREE SHAPE ONLY (ids, nesting, ordering,
  cross-refs, which diagram a leaf shows) — the actual title/body text lives in en.json under
  `help.<id-with-dots>`, same split as lib/vaults.ts / lib/build-descriptor.ts (structure/logic
  in .ts, copy in en.json). Reused for three things in HelpScreen.tsx: the nested browse view,
  the flat searchable index (built once from this tree), and cross-reference jump targets.

  🚨 SCOPE: THIS APP, NOT THE PLATFORM (user directive, 2026-08-22). Help covers what a person
  can DO on the device in front of them — their keys, their vault descriptors, signing, and this
  app's own settings. It is deliberately NOT a manual for the SignBit platform.

  ⚠️ It used to be. Topics explaining platform signup, email verification, 2FA, the send
  round trip, cancelling a pending payment, cosigner invites, the Rep role, draft vaults, the
  policy delay timer, and the isolated signer service were all removed, because every one of
  them described a screen that is not here and an action the reader cannot take. Fountain is
  the offline half and is meant to work with NO platform at all — a vault built in the offline
  builder never touches one — so platform material does not merely fail to help, it implies a
  dependency the app does not have.

  ⚠️ The test for a new topic is therefore: **can the reader act on this, offline, on this
  device?** "Someone might wonder about it" is not enough — that is the reasoning that grew the
  removed half. Concepts that a keyholder genuinely needs in order to understand what they are
  SIGNING (what a vault is, what a policy is) stay, framed around the signing decision rather
  than around whoever asked for the signature.

  ✅ WHAT PASSES THAT TEST AND WAS ADDED (2026-11-11, the Help overhaul): moving your bitcoin
  when you can't reach us (`recovery`), working with another wallet such as Sparrow
  (`otherWallets`), and the real refusals this app raises (`troubleshooting`, each one written
  from an actual error path in key.ts / psbt-decode.ts / key-file.ts / backup.ts). They are
  about the same device and the same keys; the other wallet only coordinates, Fountain signs.
  ⚠️ Help never asks the reader to type seed words anywhere but Fountain's own import screen,
  so the recovery path is "another wallet builds, Fountain signs", never "move the words".

  🚨 REMOVING A SECTION MEANS DELETING TWO SEPARATE BRANCHES OF en.json, and the 2026-08-22
  prune only did one. A section's copy lives under `help.<section>.<leaf>` but its SECTION TITLE
  lives under `help.topics.<section>.title` — a different subtree. Dropping `sending` and
  `account` from this file took their bodies with them and left both titles behind in all four
  locales, live and translated, naming sections that no longer exist.
  ✅ `help-topics.test.ts` now catches it (2026-11-11): every `help.topics.*` and `help.<section>.*`
  key in en.json must belong to a node in this tree, and every cross-ref must land on a leaf.
  `i18n:report` still cannot (a key present in all four locales is neither stale nor
  untranslated), so that test is the guard, not the report.
*/

/**
 * The drawings `components/HelpDiagrams.tsx` can show above a leaf. Defined here, not there,
 * so the tree (lib) names a diagram without importing a component.
 */
export type HelpDiagramId =
  | 'anyTwoOfThree'
  | 'backupArtifacts'
  | 'keysApart'
  | 'roundTrip'
  | 'qrFrames'
  | 'addressMatch'
  | 'recoveryKit'
  | 'checksumCompare'

export type HelpTopic = {
  /** Stable id — dotted path used both as the en.json key prefix and the cross-ref target. */
  id: string
  children?: HelpTopic[]
  /** Other topic ids this leaf points to, rendered as jump-links under its body. */
  crossRefs?: string[]
  /** A language-free drawing shown above the leaf's text. Decorative: the text must stand alone. */
  diagram?: HelpDiagramId
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'gettingStarted',
    children: [
      { id: 'gettingStarted.whatIsThis', crossRefs: ['gettingStarted.firstSteps'] },
      // The ordered "do this first" path. It is the ONE leaf that names signbit.io/guides (as
      // plain text: this app never shows a link); repeating it elsewhere turns a pointer into noise.
      {
        id: 'gettingStarted.firstSteps',
        crossRefs: ['gettingStarted.verifyingThisApp', 'keys.seedBackup', 'keys.keepKeysApart', 'vaults.derivingAnAddress'],
      },
      // The one topic that has to be read BEFORE a key exists, which is why it sits in Getting
      // Started rather than under Trust: verifying the binary is only useful while there is
      // still nothing to lose. Its body must stay a signpost — Settings' publisher block cannot
      // prove anything (a tampered copy prints the same string), so the copy points at the
      // published checksum and never implies the on-screen text is the proof.
      { id: 'gettingStarted.verifyingThisApp', crossRefs: ['deviceSecurity.keepingItOffline', 'trust.neverConnects'] },
      // ⚠️ Its body DEFERS the transport comparison to `signing.transports` rather than
      // repeating it (they had near-identical paragraphs until 2026-08-23). The cross-ref is
      // what makes the deferral navigable — keep them together: prose that says "see X" with
      // no jump to X is worse than the duplication it replaced.
      {
        id: 'gettingStarted.airGap',
        crossRefs: ['signing.transports', 'deviceSecurity.keepingItOffline', 'trust.neverConnects'],
      },
      { id: 'gettingStarted.publicVsPrivate', crossRefs: ['keys.exportPublicKey', 'keys.seedBackup'] },
      // ⚠️ Lost its `settings.networkToggle` cross-ref when the Settings section was removed
      // (2026-08-22). The network rule a signer actually needs — a key is stamped with the
      // network it was created on and always derives there — is stated in this leaf's own body
      // rather than delegated to a topic about a settings screen.
      { id: 'gettingStarted.testnetOnly', crossRefs: ['troubleshooting.wrongNetwork'] },
    ],
  },
  {
    id: 'deviceSecurity',
    children: [
      { id: 'deviceSecurity.createUnlock', crossRefs: ['deviceSecurity.forgotPassphrase'] },
      // The lock screen's own escape hatches (Restore it / Reset this device) in the order that
      // loses the least: a backup file first, a reset only once every key is on paper.
      { id: 'deviceSecurity.forgotPassphrase', crossRefs: ['deviceSecurity.restore', 'troubleshooting.backupWontOpen'] },
      { id: 'deviceSecurity.restore', crossRefs: ['troubleshooting.backupWontOpen'] },
      // The three artifacts, set side by side. Deliberately ONE leaf rather than three: the
      // facts that decide whether funds come back (only paper survives a forgotten passphrase;
      // only the app backup carries vault descriptors; a backup is a snapshot, not a mirror)
      // are only visible in the comparison. Split across three topics, each one reads as
      // reassuring on its own and the gaps between them are what loses money.
      {
        id: 'deviceSecurity.threeBackupArtifacts',
        diagram: 'backupArtifacts',
        crossRefs: ['keys.seedBackup', 'deviceSecurity.storageLocation', 'deviceSecurity.changingYourPassphrase'],
      },
      // ⚠️ NOT revocation, in both directions — an old file still opens under the old
      // passphrase (so an exposed one was never revoked), and the user who changed it will
      // try the NEW passphrase on an old file and think it is corrupt. Settings says this
      // correctly at the moment of change; Help is where it gets searched for months later.
      { id: 'deviceSecurity.changingYourPassphrase', crossRefs: ['deviceSecurity.threeBackupArtifacts'] },
      // ⚠️ Says "no network calls of its own", never "no network permission": the Android
      // manifest does declare INTERNET (Tauri's WebView), so the strong claim would be false.
      {
        id: 'deviceSecurity.keepingItOffline',
        crossRefs: ['gettingStarted.verifyingThisApp', 'deviceSecurity.autoLock', 'signing.transports'],
      },
      { id: 'deviceSecurity.autoLock' },
      { id: 'deviceSecurity.storageLocation' },
      // ⚠️ A topic about something NOT built (hardware-backed Keystore / StrongBox / biometric
      // are ⏳ in LLM_CONTEXT §2), which is exactly why no other leaf can carry it: the reader's
      // default assumption about an Android app holding secrets is the opposite of the truth.
      // When hardware-backed storage ships this leaf changes rather than disappears.
      { id: 'deviceSecurity.androidStorage', crossRefs: ['deviceSecurity.createUnlock'] },
    ],
  },
  {
    id: 'keys',
    children: [
      { id: 'keys.whatIsAKey', crossRefs: ['vaults.whatIsAVault'] },
      { id: 'keys.creating', crossRefs: ['keys.seedBackup', 'keys.revealSeedAgain'] },
      { id: 'keys.importing' },
      { id: 'keys.seedBackup', crossRefs: ['gettingStarted.publicVsPrivate', 'keys.keepKeysApart'] },
      // Its own leaf (it was a paragraph inside seedBackup) because it is the rule a multisig
      // vault rests on and the one people break first: one Fountain holding two keys of a vault.
      { id: 'keys.keepKeysApart', diagram: 'keysApart', crossRefs: ['keys.seedBackup', 'recovery.forYourFamily'] },
      { id: 'keys.revealSeedAgain' },
      { id: 'keys.exportPublicKey', crossRefs: ['vaults.enrolling', 'otherWallets.keyFormats'] },
      // Lives under KEYS, not Vaults, on purpose: "where's my address?" is asked while looking
      // at a key, and someone with that question won't think to browse the Vaults topic. The
      // answer (addresses belong to the vault) then points them at the two places that have it.
      {
        id: 'keys.whereAreMyAddresses',
        crossRefs: ['vaults.buildingOffline', 'vaults.derivingAnAddress', 'vaults.enrolling'],
      },
      { id: 'keys.removing', crossRefs: ['recovery.lostAKey'] },
    ],
    crossRefs: ['vaults.enrolling', 'gettingStarted.publicVsPrivate'],
  },
  {
    id: 'vaults',
    children: [
      { id: 'vaults.whatIsAVault', diagram: 'anyTwoOfThree', crossRefs: ['trust.noSingleParty', 'recovery.cantReachUs'] },
      { id: 'vaults.whatIsADescriptor', crossRefs: ['vaults.savingADescriptor', 'recovery.cantReachUs'] },
      { id: 'vaults.enrolling', crossRefs: ['keys.exportPublicKey'] },
      { id: 'vaults.rolesVsQuorum' },
      // The build ends on the checksum shown large for every keyholder to compare, so the
      // drawing and the "what if it differs" jump sit here as well as under Troubleshooting.
      {
        id: 'vaults.buildingOffline',
        diagram: 'checksumCompare',
        crossRefs: ['troubleshooting.checksumDiffers', 'troubleshooting.keyFileRefused'],
      },
      { id: 'vaults.savingADescriptor', crossRefs: ['vaults.whatIsADescriptor', 'vaults.derivingAnAddress'] },
      { id: 'vaults.derivingAnAddress', diagram: 'addressMatch', crossRefs: ['otherWallets.watchOnly'] },
    ],
    crossRefs: ['signing.signingATransaction'],
  },
  {
    /*
      ⚠️ The whole SPENDING POLICY section was removed on 2026-08-22 (user), for the same reason
      as the platform material before it: a policy is administered somewhere this reader cannot
      open, and someone signing with an offline-built vault may never meet one at all. What
      survives is the ACT this device performs — signing an approval message — which is why it
      lives here under Signing rather than in a section about policies.

      `signing.policyApproval` therefore has to be self-contained: it explains what the message
      you are approving MEANS, because the three topics that used to explain it are gone. Do not
      "restore the context" by adding a policy section back; put what a signer needs into the
      leaf that asks them to sign.
    */
    id: 'signing',
    children: [
      { id: 'signing.whatIsAPsbt', crossRefs: ['otherWallets.exchangingTransactions'] },
      {
        id: 'signing.signingATransaction',
        diagram: 'roundTrip',
        crossRefs: ['signing.verifyingBeforeYouSign', 'signing.transports', 'troubleshooting.keyDoesNotSign'],
      },
      { id: 'signing.verifyingBeforeYouSign', crossRefs: ['vaults.savingADescriptor', 'troubleshooting.refusedToSign'] },
      // ⚠️ States that Fountain's QR codes are its OWN frame format (lib/qr.ts, deliberately not
      // BC-UR): the scanner silently ignores any other code, so with Sparrow & co. a file or a
      // paste is the only route. Saying "QR works with other wallets" sends people into a scan
      // that never completes.
      { id: 'signing.transports', crossRefs: ['signing.qrFrameWontScan', 'otherWallets.exchangingTransactions'] },
      // Meets the "cannot finish a round trip they already started" bar. The machinery is
      // already good (any-order capture, per-frame ticks, "still need frame N") and users do
      // not know it exists — the documented failure was people re-scanning frames they already
      // held. Framed as "your transfer is recoverable", not as troubleshooting trivia.
      { id: 'signing.qrFrameWontScan', diagram: 'qrFrames', crossRefs: ['signing.transports'] },
      { id: 'signing.policyApproval' },
    ],
  },
  {
    /*
      Moving your bitcoin when you can't reach us. 🚨 Copy rules that bite hardest here: say
      "if you can't reach us", never that SignBit disappears / shuts down / is gone, and no time
      words ("one day", "ever") around it. The recovery recipe is "another wallet builds and
      broadcasts, Fountain signs offline", so the reader's seed words never leave Fountain.
    */
    id: 'recovery',
    children: [
      { id: 'recovery.cantReachUs', diagram: 'recoveryKit', crossRefs: ['recovery.prepareNow', 'recovery.withSparrow'] },
      {
        id: 'recovery.prepareNow',
        crossRefs: ['vaults.savingADescriptor', 'deviceSecurity.threeBackupArtifacts', 'otherWallets.watchOnly'],
      },
      // ⚠️ The Sparrow steps say BASE64, not "save the file": Fountain reads a PSBT as text
      // (download.ts readTextFile + Psbt.fromBase64), so Sparrow's binary .psbt fails to parse.
      {
        id: 'recovery.withSparrow',
        diagram: 'roundTrip',
        crossRefs: ['otherWallets.exchangingTransactions', 'signing.verifyingBeforeYouSign', 'vaults.derivingAnAddress'],
      },
      { id: 'recovery.lostAKey', crossRefs: ['keys.keepKeysApart', 'vaults.buildingOffline'] },
      { id: 'recovery.forYourFamily', crossRefs: ['keys.keepKeysApart', 'recovery.withSparrow'] },
    ],
  },
  {
    id: 'otherWallets',
    children: [
      { id: 'otherWallets.keyFormats', crossRefs: ['keys.exportPublicKey', 'troubleshooting.checksumDiffers'] },
      { id: 'otherWallets.watchOnly', crossRefs: ['vaults.whatIsADescriptor', 'vaults.derivingAnAddress'] },
      {
        id: 'otherWallets.exchangingTransactions',
        crossRefs: ['troubleshooting.notAValidPsbt', 'troubleshooting.refusedToSign'],
      },
    ],
  },
  {
    /*
      One leaf per refusal a user actually meets, named for the situation rather than the error
      string: several of these messages come from lib/ code with no locale (key.ts throws plain
      English), so the fr/es/de bodies quote the English text once to make it findable by search.
      ⚠️ If one of those messages is reworded in code, reword the quote here too.
    */
    id: 'troubleshooting',
    children: [
      { id: 'troubleshooting.keyDoesNotSign', crossRefs: ['vaults.whatIsADescriptor'] },
      { id: 'troubleshooting.wrongNetwork', crossRefs: ['gettingStarted.testnetOnly'] },
      { id: 'troubleshooting.notAValidPsbt', crossRefs: ['otherWallets.exchangingTransactions'] },
      { id: 'troubleshooting.refusedToSign', crossRefs: ['signing.verifyingBeforeYouSign'] },
      { id: 'troubleshooting.keyFileRefused', crossRefs: ['vaults.buildingOffline'] },
      {
        id: 'troubleshooting.checksumDiffers',
        diagram: 'checksumCompare',
        crossRefs: ['vaults.buildingOffline', 'otherWallets.keyFormats'],
      },
      {
        id: 'troubleshooting.backupWontOpen',
        crossRefs: ['deviceSecurity.changingYourPassphrase', 'deviceSecurity.restore'],
      },
    ],
  },
  {
    id: 'trust',
    children: [
      { id: 'trust.noSingleParty', crossRefs: ['vaults.whatIsAVault'] },
      { id: 'trust.neverConnects', crossRefs: ['deviceSecurity.keepingItOffline'] },
    ],
  },
]

/** Every leaf (topic with no children) across the whole tree, depth-first. */
export function flattenLeaves(topics: HelpTopic[] = HELP_TOPICS): HelpTopic[] {
  return topics.flatMap((t) => (t.children?.length ? flattenLeaves(t.children) : [t]))
}

/** Find a topic (leaf or parent) anywhere in the tree by id. */
export function findTopic(id: string, topics: HelpTopic[] = HELP_TOPICS): HelpTopic | undefined {
  for (const t of topics) {
    if (t.id === id) return t
    if (t.children) {
      const found = findTopic(id, t.children)
      if (found) return found
    }
  }
  return undefined
}

/** The top-level topic id a given leaf/child id belongs to, e.g. 'keys.seedBackup' → 'keys'. */
export function topLevelIdOf(id: string): string {
  return id.split('.')[0]
}
