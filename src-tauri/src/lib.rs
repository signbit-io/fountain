// Keystore file IO lives in the trusted Rust layer (not the webview) — the encrypted
// blob is written/read here. Encryption itself is done in JS (the audited, tested crypto
// path); Rust only persists opaque bytes to disk. This keeps the file path off the
// webview's reach.
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

// The keystore filename carries the `signbit-` prefix so a machine-wide search for
// "signbit" finds a user's keys. A bare "keystore.json" is far too generic to locate
// among the thousands of files an OS accumulates — and this is the ONE file that matters
// on a signer. Matches the naming of the other exported artifacts (signbit-backup-*.json,
// signbit-key-*.json), so every file this app writes is findable by the same search.
const KEYSTORE_FILE: &str = "signbit-keystore.json";
// The pre-0.6 filename. READ-ONLY: still resolved so an existing install keeps working,
// never written. See `resolve_keystore_path` for the read-legacy/write-new contract.
const LEGACY_KEYSTORE_FILE: &str = "keystore.json";
// Portable builds keep their data in a `data/` folder next to the executable, so keys
// travel with the app (e.g. on a USB stick). Kept in its own subfolder (not loose beside
// the .exe) so the install dir stays tidy and the folder is easy to copy/back up.
const PORTABLE_DIR: &str = "data";

// Upper bound on a file we're willing to READ into memory. This is NOT a security control —
// the KDF cost is what defends the ciphertext (see crypto.ts), and it is fixed regardless of
// payload size. This cap exists only so a mis-picked multi-gigabyte file can't be slurped into
// RAM on a phone (`read_to_string` buffers the whole thing).
//
// ⚠️ It was 1 MB with the message "too large to be a keystore", sized when this only ever read
// a bare keystore. It now also reads FULL APP BACKUPS, which additionally carry every saved
// vault descriptor: ~2.2 MB at 1000 keys + 1000 vaults. At 1 MB a large but perfectly valid
// backup was rejected *before decryption was attempted* — and it failed on the RESTORE path,
// i.e. exactly when someone has just lost a device. 16 MB clears every realistic backup with
// room to spare while still bounding the read.
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

/// Write a file and VERIFY it landed — read it back and compare byte length, retry once, then
/// fail rather than report success.
///
/// A bare `fs::write` reports Ok on a short write in some conditions (a full disk or a full USB
/// stick on a portable install, which is a first-class deployment here). For a KEYSTORE that is
/// the worst possible silent failure: the user believes their keys are saved. The JS side already
/// does exactly this for exported files (`saveTextFile` in lib/download.ts — the fix for the
/// Android SAF 0-byte data-loss bug); this brings the Rust writes up to the same bar.
fn write_verified(path: &PathBuf, contents: &str) -> Result<(), String> {
    let expected = contents.len() as u64;
    for attempt in 0..2 {
        fs::write(path, contents).map_err(|e| format!("write failed: {e}"))?;
        match fs::metadata(path) {
            // Compare BYTE length (contents.len() is bytes for a Rust str), not char count.
            Ok(meta) if meta.len() == expected => return Ok(()),
            _ if attempt == 0 => continue, // one retry, then give up loudly
            _ => {}
        }
    }
    Err("The file was saved incomplete (the disk may be full). Your previous data was not \
         replaced — free up space and try again."
        .into())
}

/// The directory holding the keystore. PORTABLE-FIRST: if a `data/` folder next to the
/// executable is writable (a USB / unzipped portable build), use it so keys travel with
/// the app. Otherwise fall back to the OS app-config dir (installed builds, read-only
/// locations like Program Files). The choice is made fresh each launch — plugging the same
/// USB into another machine "just works", and an installed copy uses per-user config.
fn keystore_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = portable_dir_if_writable() {
        return Ok(dir);
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    Ok(dir)
}

/// Returns the exe-adjacent `data/` dir IFF we can actually create + write in it; else None.
/// A write probe (not just "is it there") is what makes the auto-detect honest — a folder
/// can exist but be read-only (Program Files, a locked mount), in which case we must fall back.
fn portable_dir_if_writable() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let data_dir = exe_dir.join(PORTABLE_DIR);
    fs::create_dir_all(&data_dir).ok()?;
    // Probe write access with a temp file, then clean it up. If this fails the location is
    // read-only and we fall back to app-config.
    let probe = data_dir.join(".write-test");
    fs::write(&probe, b"ok").ok()?;
    let _ = fs::remove_file(&probe);
    Some(data_dir)
}

/// The path we WRITE to — always the current `signbit-keystore.json` name.
fn keystore_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(keystore_dir(app)?.join(KEYSTORE_FILE))
}

/// The path to READ from, honouring the legacy filename. READ-BOTH / WRITE-NEW: prefer
/// `signbit-keystore.json`, else fall back to a pre-0.6 `keystore.json` sitting in the SAME
/// directory. Returns None when neither exists (a genuine first run).
///
/// The old file is deliberately never renamed, moved, or deleted — this is a signer, and
/// mutating key material at startup to satisfy a cosmetic rename is a bad trade. An install
/// upgraded in place therefore reads the legacy file until its next save, which writes the new
/// name; from then on the new name wins here and the stale legacy file is simply ignored.
fn existing_keystore_path(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = keystore_dir(app)?;
    let current = dir.join(KEYSTORE_FILE);
    if current.exists() {
        return Ok(Some(current));
    }
    let legacy = dir.join(LEGACY_KEYSTORE_FILE);
    if legacy.exists() {
        return Ok(Some(legacy));
    }
    Ok(None)
}

/// Read the encrypted keystore JSON, or `None` if it doesn't exist yet (first run).
#[tauri::command]
fn load_keystore(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(path) = existing_keystore_path(&app)? else {
        return Ok(None);
    };
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read failed: {e}"))
}

/// Write the encrypted keystore JSON (opaque ciphertext envelope from JS). Always writes the
/// CURRENT filename, even when the load came from the legacy one — that's the migration.
#[tauri::command]
fn save_keystore(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = keystore_path(&app)?;
    // Write-VERIFIED: a silently truncated keystore is the worst failure this app has, because
    // the user only discovers it at unlock time on a device they may no longer be able to fix.
    write_verified(&path, &contents)
}

/// Where the keystore is stored, for display in Settings. `portable` = true means it lives
/// next to the app (USB-portable); false = the per-user OS config dir. Only the FOLDER is
/// returned (not the file), and it's non-secret location metadata — no key material.
#[derive(serde::Serialize)]
struct StorageInfo {
    portable: bool,
    dir: String,
}

#[tauri::command]
fn storage_info(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    let portable = portable_dir_if_writable();
    let dir = match &portable {
        Some(d) => d.clone(),
        None => keystore_dir(&app)?,
    };
    Ok(StorageInfo {
        portable: portable.is_some(),
        dir: dir.to_string_lossy().into_owned(),
    })
}

/// A keystore found in the location NOT currently in use, offered for restore. The common
/// case: the app just switched to portable storage (empty `data/`) but the user's real
/// keystore still sits in the per-user OS config dir from before — so first-run would wrongly
/// look empty. We surface that file so it can be restored instead of starting fresh.
#[derive(serde::Serialize)]
struct RestoreCandidate {
    path: String,
    /// WHICH location this file came from — "appData" or "portable".
    ///
    /// The path alone was being handed to the UI and printed raw, which asks the user to parse
    /// `%APPDATA%\Roaming\io.signbit.fountain\…` and work out what it means. Naming the
    /// location lets the screen say "an older copy in the app-data folder" in words, which is
    /// what makes the offer explicable — especially on a portable install, where a leftover
    /// app-data keystore predates the move to portable and may well be locked with a passphrase
    /// the user no longer has.
    ///
    /// Today this is always "appData" (see the portable-only guard in `restore_candidate`), but
    /// it is reported rather than assumed: the inactive location is a property of how storage
    /// resolved at launch, and a UI that hardcodes "app data" would silently start lying if the
    /// direction is ever reversed.
    location: &'static str,
}

/// The app-config keystore, regardless of whether portable is currently active — checking BOTH
/// the current and legacy filenames, newest name first. Used to look for a "previous" keystore
/// when the active (portable) location is empty. A user upgrading from a pre-0.6 installed build
/// to a portable one has a legacy-named file here, so skipping that name would silently strand it.
fn app_config_keystore_path(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    for name in [KEYSTORE_FILE, LEGACY_KEYSTORE_FILE] {
        let p = dir.join(name);
        if p.exists() {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

/// If the ACTIVE keystore location has no file but the INACTIVE one does, return that file as
/// a restore candidate. Today that means: running portable with an empty `data/`, while an old
/// keystore still exists in the OS config dir. Returns None when there's nothing to offer
/// (active file exists, or no other copy anywhere).
#[tauri::command]
fn restore_candidate(app: tauri::AppHandle) -> Result<Option<RestoreCandidate>, String> {
    // If the active location already has a keystore under EITHER name, there's nothing to
    // restore into — `load_keystore` will have picked it up.
    if existing_keystore_path(&app)?.is_some() {
        return Ok(None);
    }
    // Only meaningful when portable is active (the "other" location is the OS config dir).
    if portable_dir_if_writable().is_none() {
        return Ok(None);
    }
    // The candidate is the OS config dir copy — the only inactive location that exists today
    // (this branch is reached only when portable is active, per the guard above).
    Ok(app_config_keystore_path(&app)?.map(|p| RestoreCandidate {
        path: p.to_string_lossy().into_owned(),
        location: "appData",
    }))
}

/// Read a keystore JSON from an explicit path (an auto-detected candidate or a user-picked
/// file). Returns the opaque envelope text so JS can VERIFY the passphrase decrypts it BEFORE
/// anything is copied into place. Never writes.
///
/// Reads EITHER a bare keystore envelope OR a full app backup (the restore screen sniffs which
/// by content) — so the size bound is MAX_READ_BYTES, not a keystore-sized guess, and the error
/// must not claim the file "isn't a keystore" when a valid backup is exactly what it is.
#[tauri::command]
fn read_keystore_at(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("cannot read that file: {e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "That file is {} MB — larger than the {} MB limit for a keystore or backup file.",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024)
        ));
    }
    fs::read_to_string(&p).map_err(|e| format!("read failed: {e}"))
}

/// Commit a restore: copy the chosen keystore text into the ACTIVE keystore location. Called
/// only AFTER JS has verified the passphrase decrypts it, so we never overwrite the active
/// store with a file the user can't open. Writes the envelope text verbatim.
#[tauri::command]
fn restore_keystore(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = keystore_path(&app)?;
    // Write-VERIFIED — this one OVERWRITES the active keystore, so a short write here would
    // replace working keys with an unopenable file. JS has already proven the passphrase opens
    // the source, so the only remaining risk is the write itself; don't leave it unchecked.
    write_verified(&path, &contents)
}

/// Delete the keystore from the ACTIVE location — the "reset this device" wipe, called only
/// after the UI's two confirmation gates. This is the one command that destroys key material,
/// and it is reachable from the LOCK screen (by definition by someone who cannot prove they
/// own the data), so its contract is deliberately narrow.
///
/// ⚠️ Deletes BOTH filenames in the active dir. `existing_keystore_path` is read-both /
/// write-new, so a pre-0.6 install can have `keystore.json` sitting beside (or instead of)
/// `signbit-keystore.json`. Removing only the current name would leave the legacy file behind,
/// and the very next `load_keystore` would resolve to it — the app would reopen still locked,
/// to the same passphrase the user just told us they'd lost. A reset that doesn't reset is
/// worse than no reset at all.
///
/// Only the ACTIVE location is touched. A keystore in the inactive location (the portable /
/// app-config pair) is left alone on purpose: it's the same file `restore_candidate` offers as
/// a recovery route, and this command's job is to unblock first-run, not to erase every copy
/// on the machine. Missing files are not an error — the wipe is idempotent, so a retry after a
/// partial failure always converges.
#[tauri::command]
fn wipe_keystore(app: tauri::AppHandle) -> Result<(), String> {
    let dir = keystore_dir(&app)?;
    for name in [KEYSTORE_FILE, LEGACY_KEYSTORE_FILE] {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        fs::remove_file(&path).map_err(|e| format!("could not delete {name}: {e}"))?;
    }
    // Verify the erase the same way writes are verified: report success only when the files are
    // provably gone. A remove_file that reports Ok while the file survives (a lock, a
    // permissions quirk) would tell the user their keys were destroyed when they were not —
    // the exact inverse of the write-verify failure, and just as bad to get wrong.
    if existing_keystore_path(&app)?.is_some() {
        return Err("The keystore could not be deleted (a file may be in use). Nothing was \
                    reset — close any other copy of this app and try again."
            .into());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            load_keystore,
            save_keystore,
            storage_info,
            restore_candidate,
            read_keystore_at,
            restore_keystore,
            wipe_keystore
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
