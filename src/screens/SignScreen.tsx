import { useMemo, useState } from 'react'
import { useKeystore } from '../lib/keystore'
import { signPsbt, signApproval, classifyMessage, networkOf } from '../lib/key'
import type { NetworkName } from '../lib/key'
import { Button, Card, Label, Textarea, Alert, CopyButton, Mono } from '../components/ui'
import { saveTextFile, readTextFile } from '../lib/download'
import { QrDisplayModal, QrScanModal } from '../components/QrTransport'
import { decodePsbt, findMatchingChangeDescriptor, countMatchingVaults, type DecodedPsbt } from '../lib/psbt-decode'
import { readVaultBackups } from '../lib/vaults'
import { useI18n } from '../i18n'

/*
  Sign screen — two jobs, both offline:
   - PSBT co-signing (a vault spend): paste/import/scan the unsigned PSBT, sign with a chosen
     key, copy/export/show-as-QR the co-signed PSBT back to the platform. Standard BIP-174 →
     the platform merges it toward the m-of-n threshold.
   - Policy approval: paste/import/scan the SIGNBIT-POLICY-CHANGE block, sign with the
     enrolled key, copy/export/show-as-QR the base64 signature into the platform's policy page.

  Transports: copy/paste, file import/export, and QR (camera scan in / on-screen QR out —
  lib/qr.ts + components/QrTransport.tsx).
*/

export type Mode = 'psbt' | 'approval'

/**
 * All of the Sign screen's in-progress work (mode/key/input/output) — lifted up to Shell
 * (App.tsx) so switching tabs and back doesn't wipe out a pasted PSBT or a just-produced
 * signature. See SignScreen's own header comment for why this needs to survive a remount.
 */
export type SignScreenState = {
  mode: Mode
  keyId: string
  input: string
  output: string
  /**
   * The label of the key that produced `output`, captured AT SIGNING TIME.
   *
   * ⚠️ NOT read from the key picker at render time. The picker stays live after signing, so
   * changing it would relabel an already-produced signature with a key that had nothing to
   * do with it — on the one screen whose entire job is telling a keyholder which of their
   * keys has signed. It is a property of the OUTPUT, so it is stored with the output and
   * cleared whenever the output is.
   */
  signedWithLabel?: string
}

export const initialSignScreenState: SignScreenState = { mode: 'psbt', keyId: '', input: '', output: '' }

export function SignScreen({
  network,
  state,
  onStateChange,
  onNavigateToVaults,
}: {
  network: NetworkName
  state: SignScreenState
  onStateChange: (next: SignScreenState) => void
  /** Jump to the Vaults tab — used by the fee summary's "save this vault's descriptor" hint. */
  onNavigateToVaults: () => void
}) {
  const { entries, mnemonicFor } = useKeystore()
  const { t } = useI18n()
  const { mode, keyId, input, output, signedWithLabel } = state
  const setKeyId = (id: string) => onStateChange({ ...state, keyId: id })
  const setInput = (v: string) => onStateChange({ ...state, input: v })
  // ⚠️ Label travels WITH the output, always. Clearing one without the other is how a
  // stale key name outlives the signature it described.
  const setOutput = (v: string, signedWithLabel?: string) =>
    onStateChange({ ...state, output: v, signedWithLabel: v ? signedWithLabel : undefined })
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [showingQr, setShowingQr] = useState(false)

  /*
    ⚠️ With more than one key, an unset selection must NOT silently resolve to entries[0]:
    once mainnet and testnet keys can coexist, the fallback could quietly hand the user a
    mainnet key at the exact moment before an irreversible action. A single key is unambiguous,
    so the convenience is kept there.
  */
  const activeKey = entries.find((e) => e.id === keyId) ?? (entries.length === 1 ? entries[0] : undefined)

  /*
    THE network for every key-specific operation on this screen — the key's own stamp, never
    the app's toggle. Deriving/signing against the toggle would use a different derivation path
    than the key was enrolled with (see lib/key.ts networkOf).
  */
  const keyNetwork = activeKey ? networkOf(activeKey) : network

  // What kind of message is pasted? Display only — see the Alert below and
  // `classifyMessage`'s own note on why recognition must never become permission.
  const messageKind = useMemo(() => classifyMessage(input), [input])

  // Pre-sign decode: show what a pasted/imported/scanned PSBT actually does — recomputed
  // independently from its own bytes, never trusting any label in the PSBT itself (see
  // lib/psbt-decode.ts). Only meaningful in PSBT mode; a policy approval isn't a PSBT.
  const decoded = useMemo(() => {
    if (mode !== 'psbt' || !input.trim()) return null
    /*
      ⚠️ Decoded at the KEY'S network, not the app's. Addresses are rendered from the network's
      HRP, so decoding a mainnet PSBT as testnet prints `tb1q…` for what is really a `bc1q…`
      address — the user would "verify" a recipient that does not exist. Pre-sign verification
      is the point of this panel, so it must agree with the key that is about to sign.
    */
    const vaults = readVaultBackups()
    const changeDescriptor = findMatchingChangeDescriptor(input.trim(), keyNetwork, vaults)
    const result = decodePsbt(input.trim(), keyNetwork, changeDescriptor)
    if ('reason' in result) return null // an undecodable PSBT just shows nothing here —
    // run() below still surfaces the real parse error when they try to sign
    /*
      Change is classified against ONE vault, so a PSBT drawing inputs from two of them is a
      shape this panel cannot fully describe — and silently describing it PARTLY is the
      problem: the second vault's spending does not appear anywhere. Count and warn.
    */
    return { ...result, multiVault: countMatchingVaults(input.trim(), keyNetwork, vaults) > 1 }
  }, [mode, input, keyNetwork])

  function run() {
    setError(null)
    setOutput('')
    if (!activeKey) {
      setError(t('sign.errorNoKey'))
      return
    }
    try {
      const mnemonic = mnemonicFor(activeKey.id)
      // The KEY'S network. signPsbt additionally refuses a PSBT whose own derivation paths
      // belong to the other network (lib/bitcoin-network.ts assertPsbtCoinType).
      const result =
        mode === 'psbt'
          ? signPsbt(mnemonic, keyNetwork, input.trim())
          : signApproval(mnemonic, keyNetwork, input.trim())
      setOutput(result, activeKey.label)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function importFile() {
    const res = await readTextFile({
      accept: '.psbt,.txt,text/plain',
      tooLargeMessage: t('sign.errorFileTooLarge'),
      readErrorMessage: t('sign.errorReadFile'),
    })
    if (res.status === 'ok') {
      setInput(res.text.trim())
      setError(null)
    } else if (res.status === 'rejected') {
      setError(res.reason)
    }
    // 'cancelled' → no-op (user closed the picker)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('sign.title')}</h2>
        <p className="text-sm text-ink-muted">{t('sign.subtitle')}</p>
      </div>

      {/* Mode tabs */}
      <div className="inline-flex border border-line">
        {(['psbt', 'approval'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              // ⚠️ Clears `signedWithLabel` too — this bypasses setOutput, so forgetting it
              // would leave the previous signature's key name attached to a blank output.
              onStateChange({ ...state, mode: m, input: '', output: '', signedWithLabel: undefined })
              setError(null)
            }}
            className={`min-h-11 px-4 py-2 text-sm font-medium transition-colors sm:min-h-0 ${mode === m ? 'bg-brand-700 text-white' : 'bg-surface-2 border border-transparent text-ink hover:text-ink'}`}
          >
            {m === 'psbt' ? t('sign.modePsbt') : t('sign.modeApproval')}
          </button>
        ))}
      </div>

      <Card className="space-y-4">
        <div>
          <Label>{t('sign.signingKey')}</Label>
          <select
            value={activeKey?.id ?? ''}
            onChange={(e) => setKeyId(e.target.value)}
            className="w-full border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-brand-500/60"
          >
            {entries.length === 0 && <option value="">{t('sign.noKeysOption')}</option>}
            {/* No key chosen yet and several to choose from — the user must pick deliberately
                rather than inherit whichever happens to be first (see activeKey above). */}
            {entries.length > 1 && !activeKey && <option value="">{t('sign.chooseKeyOption')}</option>}
            {entries.map((e) => (
              // The network is part of the key's identity here: this is the last screen before
              // an irreversible action, and "Ledger backup" alone doesn't say whether signing
              // with it moves real money.
              <option key={e.id} value={e.id}>
                {e.label} — {networkOf(e)}
              </option>
            ))}
          </select>
          {/* No extra mainnet warning here on purpose. The option above already reads
              "<label> — mainnet", and getting onto mainnet at all required a confirm modal.
              A third restatement on every signature is the kind of thing people stop seeing. */}
        </div>

        <div>
          {/* flex-wrap: translated action labels (fr "Importer un fichier") + the field label
              can't share one 360px row — the actions wrap under the label instead of crushing
              it. Touch-sized (min-h-9) actions since these are primary mobile entry points. */}
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <Label>{mode === 'psbt' ? t('sign.psbtLabel') : t('sign.approvalLabel')}</Label>
            <div className="flex gap-2">
              <Button variant="ghost" className="min-h-9 px-2 py-1 text-xs" onClick={() => setScanning(true)}>
                {t('sign.scanQr')}
              </Button>
              <Button variant="ghost" className="min-h-9 px-2 py-1 text-xs" onClick={importFile}>
                {t('sign.importFile')}
              </Button>
            </div>
          </div>
          <Textarea
            rows={6}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'psbt' ? t('sign.psbtPlaceholder') : t('sign.approvalPlaceholder')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {decoded && <PsbtDecodeSummary decoded={decoded} onNavigateToVaults={onNavigateToVaults} />}

        {/*
          What IS this message? Shown in message mode as soon as there is text to classify.

          ⚠️ Recognition, never permission — `signApproval` signs anything, and this app must
          not refuse a message the platform introduced after this build shipped (it used to,
          which is how SIGNBIT-VAULT-IMPORT arrived as "doesn't look like a SignBit approval
          block"). What protects the user is SEEING what they are about to sign, so an
          unrecognised message is labelled honestly rather than blocked.
        */}
        {mode === 'approval' && input.trim() && (
          <>
            <Alert kind={messageKind === 'unknown' ? 'error' : messageKind === 'unknownSignbit' ? 'warn' : 'ok'}>
              {t(`sign.messageKind.${messageKind}`)}
            </Alert>
            {/*
              ⚠️ Only for text we do NOT recognise. The stake is not obvious from the screen:
              this tab signs with the account's 0/0 child, which is also a key in the vault's
              multisig script — the same key that authorises spends. Signing an unknown string
              is safe against a forged SPEND (a transaction sighash is a hash of binary tx
              bytes, not of UTF-8 text, so the two domains do not overlap), but it is still a
              signature from a funds-controlling key, given to whoever asked for it. A user
              being talked into signing "just a message" deserves to be told that plainly.
              This is a WARNING, never a refusal — see KNOWN_MESSAGES: recognition, never
              permission, so a message type newer than this build must still be signable.
            */}
            {messageKind === 'unknown' && <Alert kind="error">{t('sign.messageKindUnknownStake')}</Alert>}
          </>
        )}

        {error && <Alert kind="error">{error}</Alert>}

        {/* Full-width on a phone (the screen's one primary action, easy thumb reach);
            auto-width inline button back at sm+. */}
        <Button className="w-full sm:w-auto" onClick={run} disabled={!input.trim() || !activeKey}>
          {mode === 'psbt' ? t('sign.signPsbtButton') : t('sign.signApprovalButton')}
        </Button>
      </Card>

      {output && (
        <Card className="space-y-3 animate-fade-in-up">
          {/*
            Names the key that SIGNED — on a vault where one holder runs several keys (the
            3-of-5 story this app exists for), "Co-signed" alone does not say WHICH, so a
            keyholder cannot tell what they still owe without decoding the PSBT again.

            ⚠️ Reads `signedWithLabel`, CAPTURED AT SIGNING TIME — never `activeKey`, which
            follows the picker and would relabel this signature if the dropdown were changed
            afterwards.
          */}
          <Alert kind="ok">
            {mode === 'psbt'
              ? signedWithLabel
                ? t('sign.resultPsbtWithKey', { key: signedWithLabel })
                : t('sign.resultPsbt')
              : signedWithLabel
                ? t('sign.resultApprovalWithKey', { key: signedWithLabel })
                : t('sign.resultApproval')}
          </Alert>
          <div>
            <Label>{mode === 'psbt' ? t('sign.outputPsbtLabel') : t('sign.outputApprovalLabel')}</Label>
            <Textarea rows={6} readOnly value={output} className="text-emerald-700 dark:text-emerald-300" />
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={output} />
            <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setShowingQr(true)}>
              {t('sign.showQr')}
            </Button>
            {/* Native Save-As dialog in the app (blob download in a browser tab). A PSBT saves
                as .psbt (base64 text), an approval signature as .txt. */}
            <Button
              variant="secondary"
              className="px-2.5 py-1.5 text-xs"
              disabled={exporting}
              onClick={async () => {
                setError(null)
                setExporting(true)
                try {
                  const name = mode === 'psbt' ? 'signbit-cosigned.psbt' : 'signbit-approval.txt'
                  const filters =
                    mode === 'psbt'
                      ? [{ name: 'PSBT', extensions: ['psbt', 'txt'] }]
                      : [{ name: 'Signature', extensions: ['txt'] }]
                  await saveTextFile(name, output, filters)
                } catch (e) {
                  setError((e as Error).message || t('sign.errorSaveFile'))
                } finally {
                  setExporting(false)
                }
              }}
            >
              {exporting ? t('sign.exportFileSaving') : t('sign.exportFile')}
            </Button>
          </div>
        </Card>
      )}

      <QrScanModal
        open={scanning}
        onClose={() => setScanning(false)}
        onScanned={(text) => {
          setInput(text)
          setError(null)
          setScanning(false)
        }}
      />
      <QrDisplayModal open={showingQr} onClose={() => setShowingQr(false)} text={output} />
    </div>
  )
}

/*
  Pre-sign decode summary — shown right above the Sign button so the user sees exactly what
  they're about to authorize before their key signs anything. Every value here is computed
  independently from the PSBT's own bytes (lib/psbt-decode.ts); nothing is trusted from a label
  inside the PSBT. Change classification needs a cached vault descriptor (lib/vaults.ts) — when
  none matches, outputs are shown plainly as "unknown" rather than guessed.
*/
function PsbtDecodeSummary({
  decoded,
  onNavigateToVaults,
}: {
  decoded: DecodedPsbt & { multiVault?: boolean }
  onNavigateToVaults: () => void
}) {
  const { t } = useI18n()

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2/60 p-4">
      <div className="text-sm font-medium text-ink">{t('sign.decodeTitle')}</div>
      <ul className="space-y-1.5">
        {decoded.outputs.map((o, i) => (
          <li key={i} className="flex items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-2 overflow-hidden">
              <ChangeBadge kind={o.change} />
              <Mono className="truncate text-xs text-ink-muted">{o.address}</Mono>
            </div>
            <span className="shrink-0 font-mono text-sm text-ink">{o.amountSats.toLocaleString()} sats</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-line pt-2 text-sm">
        <span className="text-ink-muted">{t('sign.decodeFee')}</span>
        <span className={decoded.feeLooksWrong ? 'font-mono font-semibold text-rose-600 dark:text-rose-400' : 'font-mono text-ink'}>
          {decoded.feeSats.toLocaleString()} sats
        </span>
      </div>
      {/*
        The fee is the figure a value-understating PSBT distorts, and it is the only one the
        user has no independent way to check — output amounts they can read, but an input's
        real value lives on-chain. Say so in words rather than relying on the colour alone.
      */}
      {decoded.feeLooksWrong && <Alert kind="error">{t('sign.decodeFeeAlarm')}</Alert>}
      {/*
        Inputs from more than one cached vault: the classification above only speaks for one of
        them, so say plainly that this spends from several rather than letting the panel imply
        a single-vault transaction.
      */}
      {decoded.multiVault && <Alert kind="warn">{t('sign.decodeMultiVault')}</Alert>}
      {!decoded.changeClassified && (
        <p className="text-xs text-ink-muted">
          {t('sign.decodeNoChangeInfo')}{' '}
          <button
            type="button"
            onClick={onNavigateToVaults}
            className="font-medium text-brand-700 underline decoration-dotted underline-offset-2 hover:text-brand-600 dark:text-brand-400"
          >
            {t('sign.decodeGoToVaults')}
          </button>
        </p>
      )}
    </div>
  )
}

function ChangeBadge({ kind }: { kind: 'recipient' | 'change' | 'unknown' }) {
  const { t } = useI18n()
  const styles =
    kind === 'change'
      ? 'border-line text-ink-muted'
      : kind === 'recipient'
        ? 'border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400'
        : 'border-line text-ink-muted'
  const label =
    kind === 'change' ? t('sign.decodeChange') : kind === 'recipient' ? t('sign.decodeRecipient') : t('sign.decodeUnknown')
  return (
    <span className={`inline-flex shrink-0 items-center border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles}`}>
      {label}
    </span>
  )
}

