/*
  Read whatever someone pasted or imported as a vault backup, and say what it is BEFORE it is
  saved: the receive/change pair the cache stores, the label a backup file carries, what the
  descriptor describes (size, keys, network, checksum, first address), or a problem CODE the
  Vaults screen puts into the user's language.

  PURE and public-data only: descriptors and extended PUBLIC keys. Nothing here touches the
  keystore, storage or the network. `lib/vaults.ts` still does the storing; this decides what
  is worth storing.

  Why it exists (user, 2026-11-11: "pasting/storing a descriptor ... need better UX/UI"). The
  paste form used to save any text at all, and showed nothing until after the save. So a
  descriptor with one changed character (a wrong checksum), a receive line whose change line
  belonged to another vault, or a seed-bearing private descriptor all went straight into the
  cache the recovery path depends on. A plausible-but-wrong cached vault is worse than none
  (`docs/vault-cache.md` §7, the draft's reasoning), so the form now reads first and saves
  only what reads cleanly.
*/

import {
  PRIVATE_PREFIXES,
  changeDescriptorFor,
  deriveAddress,
  descriptorChecksumState,
  splitMultipath,
  withChecksum,
} from './build-descriptor.js'
import {
  changeDescriptorBelongsTo,
  parseDescriptorSummary,
  parseVaultBackupFile,
  sniffDescriptorNetwork,
  type ParsedDescriptor,
} from './vaults.js'

export type VaultInputProblem =
  /** Nothing to read. */
  | 'empty'
  /** 🚨 A private extended key anywhere in the text. The cache is plain, unencrypted storage
   *  and a descriptor never needs one, so this is refused before anything else is looked at. */
  | 'private_key'
  /** The checksum after `#` is not the one the text produces: a character was changed. */
  | 'bad_checksum'
  /** The text is not a descriptor this app can read addresses from. */
  | 'not_a_descriptor'
  /** The change descriptor given is broken (bad checksum or unreadable). */
  | 'change_invalid'
  /** The change descriptor given is valid but belongs to a DIFFERENT vault. */
  | 'change_mismatch'

export type VaultInput = {
  /** From a backup file's `# Label:` line; '' when the text carried none. */
  label: string
  /** Receive descriptor, with its checksum (added when the paste had none). */
  descriptor: string
  changeDescriptor?: string
  /** Where the change descriptor came from: given in the text, worked out from the receive
   *  one, or not available (a descriptor shape it cannot be worked out for). */
  changeSource: 'given' | 'derived' | 'none'
  /** True when the pasted descriptor had no checksum and one was added. */
  checksumAdded: boolean
  /** Size, keys and checksum, for the platform's descriptor shape; null for other shapes. */
  summary: ParsedDescriptor | null
  network: 'mainnet' | 'testnet'
  /** Receive address #0, the easiest thing to compare against another wallet. */
  firstAddress: string
}

export type VaultInputResult = { ok: true; value: VaultInput } | { ok: false; problem: VaultInputProblem }

const SCRIPT_START = /^(wsh|sh|tr|wpkh|pkh|multi|sortedmulti)\(/

/** True when the text holds a private extended key anywhere (any SLIP-132 flavour). */
export function containsPrivateKey(text: string): boolean {
  return PRIVATE_PREFIXES.some((p) => new RegExp(`(^|[^A-Za-z0-9])${p}[1-9A-HJ-NP-Za-km-z]{20,}`).test(text))
}

/**
 * Split pasted text into its descriptor lines, the way a person pastes:
 * - a SignBit backup file (`#` comment lines, receive and maybe change), via parseVaultBackupFile;
 * - two descriptor lines (receive then change), the same way;
 * - ONE descriptor, possibly wrapped over several lines by a mail client or a PDF, which is
 *   joined back up (a descriptor contains no whitespace, so none of it can be meaningful).
 */
function splitPaste(text: string): { label: string; descriptor: string; changeDescriptor?: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const hasComments = lines.some((l) => l.startsWith('#'))
  const descriptorLines = lines.filter((l) => SCRIPT_START.test(l))
  if (hasComments || descriptorLines.length >= 2) {
    const parsed = parseVaultBackupFile(text.replace(/\r\n/g, '\n'))
    return { label: parsed.label, descriptor: parsed.descriptor, changeDescriptor: parsed.changeDescriptor }
  }
  return { label: '', descriptor: text.replace(/\s+/g, '') }
}

function networkName(descriptor: string): 'mainnet' | 'testnet' {
  return sniffDescriptorNetwork(descriptor)
}

/** Check one descriptor and return it WITH a checksum, or the problem. */
function checkOne(raw: string): { ok: true; descriptor: string; added: boolean; address: string } | { ok: false; problem: 'bad_checksum' | 'not_a_descriptor' } {
  const compact = raw.replace(/\s+/g, '')
  const state = descriptorChecksumState(compact)
  if (state === 'wrong') return { ok: false, problem: 'bad_checksum' }
  let descriptor: string
  try {
    descriptor = state === 'ok' ? compact : withChecksum(compact)
  } catch {
    return { ok: false, problem: 'not_a_descriptor' }
  }
  try {
    const address = deriveAddress(descriptor, 0, networkName(descriptor))
    return { ok: true, descriptor, added: state === 'missing', address }
  } catch {
    return { ok: false, problem: 'not_a_descriptor' }
  }
}

/**
 * Read pasted or imported text (and an optional separately-pasted change descriptor).
 *
 * ⚠️ A change descriptor that does not belong to the receive one is REFUSED, not stored. The
 * Sign screen trusts this pair to say which outputs come back to the vault, and
 * `changeDescriptorBelongsTo` already fails closed there; refusing at the door means the
 * mismatch is reported where the person can fix it, instead of surfacing as "recipient" on a
 * spend months later.
 */
export function readVaultInput(text: string, changeText = ''): VaultInputResult {
  if (!text.trim()) return { ok: false, problem: 'empty' }
  if (containsPrivateKey(text) || containsPrivateKey(changeText)) return { ok: false, problem: 'private_key' }

  const pasted = splitPaste(text)
  let receiveRaw = pasted.descriptor
  let changeRaw = changeText.trim() || pasted.changeDescriptor || ''

  // A multipath descriptor carries both branches in one line.
  const multi = splitMultipath(receiveRaw)
  if (multi) {
    receiveRaw = multi.receive
    if (!changeRaw) changeRaw = multi.change
  }

  const receive = checkOne(receiveRaw)
  if (!receive.ok) return { ok: false, problem: receive.problem }

  let changeDescriptor: string | undefined
  let changeSource: VaultInput['changeSource'] = 'none'
  if (changeRaw) {
    const change = checkOne(changeRaw)
    if (!change.ok) return { ok: false, problem: 'change_invalid' }
    // Only a descriptor of the platform's shape can be compared key by key. For any other
    // shape the pair is kept as given (the Sign screen's own check still fails closed on it).
    if (parseDescriptorSummary(receive.descriptor) && !changeDescriptorBelongsTo(receive.descriptor, change.descriptor)) {
      return { ok: false, problem: 'change_mismatch' }
    }
    changeDescriptor = change.descriptor
    changeSource = 'given'
  } else {
    const derived = changeDescriptorFor(receive.descriptor)
    if (derived) {
      changeDescriptor = derived
      changeSource = 'derived'
    }
  }

  return {
    ok: true,
    value: {
      label: pasted.label,
      descriptor: receive.descriptor,
      changeDescriptor,
      changeSource,
      checksumAdded: receive.added,
      summary: parseDescriptorSummary(receive.descriptor),
      network: networkName(receive.descriptor),
      firstAddress: receive.address,
    },
  }
}
