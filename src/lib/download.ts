/*
  File-save helpers — write text to a local file the user chooses. Air-gap safe: no network,
  purely a local write. Shared by the Keys export (public key .json) and the Sign screen's
  PSBT/approval export.

  Two paths:
   - Under Tauri (the shipped app) the browser blob-download no-ops — Tauri intercepts the
     navigation and has no downloads handler. So we use the native Save-As dialog (dialog
     plugin) + writeTextFile (fs plugin) instead.
   - In a plain browser tab (`npm run dev`) we fall back to the blob download.
*/

/** True when running inside the Tauri webview (the desktop/mobile app), false in a browser tab. */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Browser fallback: save text via a blob URL + a synthetic <a download> click. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export type SaveResult = { status: 'saved'; path?: string } | { status: 'cancelled' }

/**
 * Save text to a file the user picks. Uses Tauri's native Save-As dialog + fs write in the
 * app; falls back to a browser blob download in a plain tab. `filters` narrows the dialog's
 * file-type list (e.g. JSON / PSBT). Returns whether the user saved or cancelled.
 */
export async function saveTextFile(
  suggestedName: string,
  text: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<SaveResult> {
  if (!isTauri()) {
    downloadText(suggestedName, text)
    return { status: 'saved' } // the browser handles the destination; treat as saved
  }
  // Dynamic import so the Tauri plugin code is never pulled into the browser/test bundle path.
  const [{ save }, { writeTextFile, readTextFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await save({ defaultPath: suggestedName, filters })
  if (!path) return { status: 'cancelled' } // user dismissed the dialog

  // Write, then VERIFY. On Android the save dialog returns a SAF content:// URI, and writing
  // to one (especially a document the user RENAMED in the dialog) can silently produce a
  // 0-byte file — a data-loss trap for an exported PSBT/signature. So we read the file back
  // and confirm its content matches; if the write came up empty we retry once, and if it's
  // still empty we THROW rather than let the caller believe an empty file was saved. Desktop
  // writes are reliable, so the readback simply passes there. (The signature can always also
  // leave via QR / copy-paste, the primary mobile transports.)
  await writeTextFile(path, text)
  if (!(await writtenOk(readTextFile, path, text))) {
    await writeTextFile(path, text) // one retry
    if (!(await writtenOk(readTextFile, path, text))) {
      throw new Error(
        'The file was saved empty (a known issue when renaming the file in the Android save dialog). ' +
          'Try again keeping the suggested name, or use QR / Copy to move the signature instead.',
      )
    }
  }
  return { status: 'saved', path }
}

/** Read a just-written file back and confirm it holds the expected content (non-empty, right
 *  length). Any read failure counts as "not ok" so the caller retries / errors rather than
 *  trusting a silent empty write. */
async function writtenOk(
  readTextFile: (path: string) => Promise<string>,
  path: string,
  expected: string,
): Promise<boolean> {
  if (expected.length === 0) return true // nothing to verify
  try {
    const back = await readTextFile(path)
    return back.length === expected.length
  } catch {
    return false
  }
}

/** Slugify a label into a safe filename fragment (letters/digits/-/_), lowercased. */
export function safeFileSlug(label: string, fallback = 'key'): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

/*
  Every file this app writes starts with `signbit-` so ONE machine-wide search for "signbit"
  finds all of a user's material — keystore, app backups, exported public keys. That matters on
  a signer: a year later, on a different machine, "where did my keys go" has to be answerable
  without remembering three different naming schemes. ("keystore", "key", a user's own label:
  all far too generic to search for.) The other two names live at their own sites —
  `defaultBackupFilename` in lib/backup.ts and `KEYSTORE_FILE` in src-tauri/src/lib.rs —
  since neither can import from here; keep the prefix in step across all three.
*/
export const FILE_PREFIX = 'signbit'

/**
 * Default filename for an exported PUBLIC key envelope:
 * `signbit-key-<label-slug>-<fingerprint>.json`. The label is kept (several exported keys stay
 * tellable apart in a folder) and the fingerprint disambiguates two keys sharing a label.
 */
export function defaultKeyExportFilename(label: string, masterFingerprint: string): string {
  return `${FILE_PREFIX}-key-${safeFileSlug(label, 'companion')}-${masterFingerprint}.json`
}

/*
  File-read helper — the counterpart to saveTextFile, shared by the Sign screen (PSBT/approval
  import) and the Vaults screen (descriptor backup import). TEXT-ONLY, read-then-parse, never
  executed: a mis-picked binary just fails to parse downstream. Hard size cap guards against a
  huge/garbage file (these artifacts are all a few KB at most).
*/
/*
  Default read cap. NOT a security control — the KDF cost is what defends an encrypted file
  (crypto.ts), and it's fixed regardless of payload size. This only stops a mis-picked huge file
  being buffered into memory (`readAsText` reads the whole thing), which on a phone is a real DoS.

  1 MB is right for the artifacts MOST callers read: a PSBT or a vault descriptor is a few KB, so
  a megabyte is already absurdly generous and a tighter bound is a genuine sanity check. The
  backup importer overrides it — see MAX_BACKUP_IMPORT_BYTES.
*/
const MAX_IMPORT_BYTES = 1024 * 1024 // 1 MB

/*
  Cap for FULL APP BACKUPS, which are in a different size class: a backup carries every seed AND
  every saved vault descriptor (~2.2 MB at 1000 keys + 1000 vaults), where a PSBT is a few KB.

  ⚠️ This exists because the shared 1 MB default silently rejected large-but-valid backups
  *before decryption was attempted* — and it did so on the RESTORE path, i.e. exactly when
  someone has just lost a device and can least afford a misleading error. Matches MAX_READ_BYTES
  in src-tauri/src/lib.rs, which bounds the same file on the other restore path (keep in step).
*/
export const MAX_BACKUP_IMPORT_BYTES = 16 * 1024 * 1024 // 16 MB

export type ImportResult =
  /** `name` is the picked file's own name — callers that show WHICH file was loaded (e.g. the
   *  backup import/compare screen, where picking the wrong backup is the whole risk) need it;
   *  callers that only care about the content ignore it. */
  | { status: 'ok'; text: string; name: string }
  | { status: 'cancelled' }
  | { status: 'rejected'; reason: string }

export function readTextFile(opts: {
  accept: string
  tooLargeMessage: string
  readErrorMessage: string
  /** Override the default 1 MB bound. Only the backup importer needs this
   *  (MAX_BACKUP_IMPORT_BYTES) — a PSBT or descriptor is a few KB, so the tighter default
   *  stays a real sanity check for every other caller. */
  maxBytes?: number
}): Promise<ImportResult> {
  return new Promise((resolve) => {
    const el = document.createElement('input')
    el.type = 'file'
    el.accept = opts.accept
    el.onchange = () => {
      const file = el.files?.[0]
      if (!file) return resolve({ status: 'cancelled' })
      if (file.size > (opts.maxBytes ?? MAX_IMPORT_BYTES)) {
        return resolve({ status: 'rejected', reason: opts.tooLargeMessage })
      }
      const reader = new FileReader()
      reader.onload = () => resolve({ status: 'ok', text: String(reader.result ?? ''), name: file.name })
      reader.onerror = () => resolve({ status: 'rejected', reason: opts.readErrorMessage })
      reader.readAsText(file)
    }
    el.click()
  })
}

/*
  ── Bulk export ───────────────────────────────────────────────────────────────────────────

  Exporting every key ONE FILE PER KEY is the point: a folder of `signbit-key-<label>-<fp>.json`
  files is what the enrollment flow (and every other tool) already reads, and it stays greppable
  by the `signbit-` prefix rule above. A single combined file would be a new format nothing
  consumes, and would put every key's identity in one artifact for no gain — these are PUBLIC
  keys, so the win is portability, not secrecy.

  ⚠️ The user picks a DIRECTORY once, not a filename N times. Fifteen keys through the Save-As
  dialog is fifteen dialogs, which is not an export — it's a chore someone abandons halfway,
  leaving a partial set they believe is complete.
*/

/** One planned file: the name it gets on disk and the text to write into it. */
export type PlannedFile = { filename: string; text: string }

/**
 * Turn a list of (label, fingerprint, json) into the exact files to write, resolving any name
 * COLLISION with a numeric suffix so no export can silently overwrite one of its own files.
 *
 * A collision needs the same label AND the same fingerprint. `importKey` rejects a duplicate
 * seed, so that pair should be unreachable — but "should be unreachable" is exactly the
 * assumption that turns a 15-key export into 14 files, and the loss is silent because the
 * folder still looks plausible. Suffixing is cheap; a lost key is not. (Same reasoning as the
 * vault cache's `" (2)"` label suffixing.)
 */
export function planKeyExports(
  keys: { label: string; masterFingerprint: string; json: string }[],
): PlannedFile[] {
  const used = new Set<string>()
  return keys.map((k) => {
    const base = defaultKeyExportFilename(k.label, k.masterFingerprint)
    let filename = base
    // Suffix before the extension (`…-73c5da0a-2.json`), never after — a name ending `.json.2`
    // stops being a JSON file to every picker and OS association that reads the extension.
    for (let n = 2; used.has(filename); n++) filename = base.replace(/\.json$/, `-${n}.json`)
    used.add(filename)
    return { filename, text: k.json }
  })
}

export type SaveManyResult =
  | { status: 'saved'; dir: string; written: number }
  | { status: 'cancelled' }

/**
 * Write several files into ONE directory the user picks. Returns how many landed.
 *
 * ⚠️ Each write goes through the SAME write-verify as `saveTextFile` (read back, retry once,
 * throw) — the Android SAF 0-byte trap does not become acceptable in bulk. A throw here aborts
 * the run rather than continuing, so the user is told the export is incomplete instead of
 * finding a folder of empty files later; the files already written stay, which is why the
 * error names the count that made it.
 */
export async function saveTextFilesToDir(files: PlannedFile[]): Promise<SaveManyResult> {
  if (!isTauri()) {
    // Browser fallback (`npm run dev`): one blob download per file. The browser decides where
    // they land, exactly as the single-file path already does.
    for (const f of files) downloadText(f.filename, f.text, 'application/json')
    return { status: 'saved', dir: '', written: files.length }
  }
  const [{ open }, { writeTextFile, readTextFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const dir = await open({ directory: true, multiple: false })
  if (typeof dir !== 'string') return { status: 'cancelled' } // dismissed

  let written = 0
  for (const f of files) {
    // Join with a forward slash: Windows accepts it in every path API, so one form works on
    // all three desktop targets without importing the path plugin for a single join.
    const path = `${dir}/${f.filename}`
    try {
      await writeTextFile(path, f.text)
      if (!(await writtenOk(readTextFile, path, f.text))) {
        await writeTextFile(path, f.text) // one retry, same as saveTextFile
        if (!(await writtenOk(readTextFile, path, f.text))) throw new Error('empty write')
      }
      written++
    } catch {
      throw new Error(
        `Saved ${written} of ${files.length} key files before writing "${f.filename}" failed. ` +
          'Check the folder is writable and try again — re-exporting is safe, it overwrites.',
      )
    }
  }
  return { status: 'saved', dir, written }
}
