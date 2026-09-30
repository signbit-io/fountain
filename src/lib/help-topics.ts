/*
  The Help tab's information architecture: topics → subtopics, with cross-references
  between related leaves. This file owns the TREE SHAPE ONLY (ids, nesting, ordering,
  cross-refs) — the actual title/body text lives in en.json under `help.<id-with-dots>`,
  same split as lib/vaults.ts / lib/build-descriptor.ts (structure/logic in .ts, copy in
  en.json). Reused for three things in HelpScreen.tsx: the nested browse view, the flat
  searchable index (built once from this tree), and cross-reference jump targets.

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

  🚨 REMOVING A SECTION MEANS DELETING TWO SEPARATE BRANCHES OF en.json, and the 2026-08-22
  prune only did one. A section's copy lives under `help.<section>.<leaf>` but its SECTION TITLE
  lives under `help.topics.<section>.title` — a different subtree. Dropping `sending` and
  `account` from this file took their bodies with them and left both titles behind in all four
  locales, live and translated, naming sections that no longer exist.
  ⚠️ **No tool catches this.** `i18n:report` compares locales against en, so a key present in
  ALL FOUR is not "stale" and not "untranslated"; `i18n:check` only asserts that literal `t()`
  keys RESOLVE, and nothing renders a dead title, so nothing fails. The parity test passed
  throughout. **The check is this comment and a grep** — when a section leaves this tree, grep
  `help.topics.<id>` across `locales/*.json` before calling it done.
*/

export type HelpTopic = {
  /** Stable id — dotted path used both as the en.json key prefix and the cross-ref target. */
  id: string
  children?: HelpTopic[]
  /** Other topic ids this leaf points to, rendered as jump-links under its body. */
  crossRefs?: string[]
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'gettingStarted',
    children: [
      { id: 'gettingStarted.whatIsThis' },
      // ⚠️ Its body DEFERS the transport comparison to `signing.transports` rather than
      // repeating it (they had near-identical paragraphs until 2026-08-23). The cross-ref is
      // what makes the deferral navigable — keep them together: prose that says "see X" with
      // no jump to X is worse than the duplication it replaced.
      { id: 'gettingStarted.airGap', crossRefs: ['signing.transports', 'trust.neverConnects'] },
      { id: 'gettingStarted.publicVsPrivate', crossRefs: ['keys.exportPublicKey', 'keys.seedBackup'] },
      // ⚠️ Lost its `settings.networkToggle` cross-ref when the Settings section was removed
      // (2026-08-22). The network rule a signer actually needs — a key is stamped with the
      // network it was created on and always derives there — is stated in this leaf's own body
      // rather than delegated to a topic about a settings screen.
      { id: 'gettingStarted.testnetOnly' },
      // The one topic that has to be read BEFORE a key exists, which is why it sits in Getting
      // Started rather than under Trust: verifying the binary is only useful while there is
      // still nothing to lose. Its body must stay a signpost — Settings' publisher block cannot
      // prove anything (a tampered copy prints the same string), so the copy points at the
      // published checksum and never implies the on-screen text is the proof.
      { id: 'gettingStarted.verifyingThisApp', crossRefs: ['trust.neverConnects'] },
    ],
  },
  {
    id: 'deviceSecurity',
    children: [
      { id: 'deviceSecurity.createUnlock' },
      { id: 'deviceSecurity.restore' },
      // The three artifacts, set side by side. Deliberately ONE leaf rather than three: the
      // facts that decide whether funds come back (only paper survives a forgotten passphrase;
      // only the app backup carries vault descriptors; a backup is a snapshot, not a mirror)
      // are only visible in the comparison. Split across three topics, each one reads as
      // reassuring on its own and the gaps between them are what loses money.
      {
        id: 'deviceSecurity.threeBackupArtifacts',
        crossRefs: ['keys.seedBackup', 'deviceSecurity.storageLocation', 'deviceSecurity.changingYourPassphrase'],
      },
      // ⚠️ NOT revocation, in both directions — an old file still opens under the old
      // passphrase (so an exposed one was never revoked), and the user who changed it will
      // try the NEW passphrase on an old file and think it is corrupt. Settings says this
      // correctly at the moment of change; Help is where it gets searched for months later.
      { id: 'deviceSecurity.changingYourPassphrase', crossRefs: ['deviceSecurity.threeBackupArtifacts'] },
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
      { id: 'keys.whatIsAKey' },
      { id: 'keys.creating' },
      { id: 'keys.importing' },
      { id: 'keys.seedBackup', crossRefs: ['gettingStarted.publicVsPrivate'] },
      { id: 'keys.revealSeedAgain' },
      { id: 'keys.exportPublicKey', crossRefs: ['vaults.enrolling'] },
      // Lives under KEYS, not Vaults, on purpose: "where's my address?" is asked while looking
      // at a key, and someone with that question won't think to browse the Vaults topic. The
      // answer (addresses belong to the vault) then points them at the two places that have it.
      {
        id: 'keys.whereAreMyAddresses',
        crossRefs: ['vaults.buildingOffline', 'vaults.derivingAnAddress', 'vaults.enrolling'],
      },
      { id: 'keys.removing' },
    ],
    crossRefs: ['vaults.enrolling', 'gettingStarted.publicVsPrivate'],
  },
  {
    id: 'vaults',
    children: [
      { id: 'vaults.whatIsAVault', crossRefs: ['trust.noSingleParty'] },
      { id: 'vaults.whatIsADescriptor' },
      { id: 'vaults.enrolling', crossRefs: ['keys.exportPublicKey'] },
      { id: 'vaults.rolesVsQuorum' },
      { id: 'vaults.savingADescriptor' },
      { id: 'vaults.buildingOffline' },
      { id: 'vaults.derivingAnAddress' },
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
      { id: 'signing.whatIsAPsbt' },
      { id: 'signing.signingATransaction' },
      { id: 'signing.verifyingBeforeYouSign' },
      { id: 'signing.policyApproval' },
      { id: 'signing.transports', crossRefs: ['signing.qrFrameWontScan'] },
      // Meets the "cannot finish a round trip they already started" bar. The machinery is
      // already good (any-order capture, per-frame ticks, "still need frame N") and users do
      // not know it exists — the documented failure was people re-scanning frames they already
      // held. Framed as "your transfer is recoverable", not as troubleshooting trivia.
      { id: 'signing.qrFrameWontScan', crossRefs: ['signing.transports'] },
    ],
  },
  {
    id: 'trust',
    children: [{ id: 'trust.noSingleParty' }, { id: 'trust.neverConnects' }],
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
