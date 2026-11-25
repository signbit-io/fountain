fn main() {
    // Google Play requires 16 KB memory page support for 64-bit Android (Play Console error on 6007).
    // NDK 27 links at 4 KB by default. This lives here, not in .cargo/config.toml, because the Tauri
    // Android build sets RUSTFLAGS, which makes cargo ignore config rustflags.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target == "aarch64-linux-android" || target == "x86_64-linux-android" {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
