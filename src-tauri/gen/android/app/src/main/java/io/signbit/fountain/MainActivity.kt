package io.signbit.fountain

import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()

    /*
      🚨 FLAG_SECURE — THIS APP PUTS BIP-39 SEED PHRASES ON THE SCREEN.

      Without it Android happily screenshots the window, screen-records it, mirrors it to a
      cast target, and — the one nobody thinks about — saves a THUMBNAIL of the last frame for
      the recents/app-switcher. That thumbnail is written to disk by the system, outlives the
      process, and is captured on the way out: reveal a seed, press Home, and a picture of it
      is now sitting in the system's snapshot store for any process with the right access (or
      anyone who picks the phone up and taps the square button) to read. No amount of at-rest
      encryption in this app touches a file the OS wrote on its own.

      Set WINDOW-WIDE and ONCE rather than toggled around the reveal screens. Toggling means
      every future screen that ever shows a mnemonic, an unlock passphrase or a PSBT has to
      remember to opt in, and the one that forgets fails silently and invisibly. A signer has
      no screen worth screenshotting, so the default is flipped instead.

      ⚠️ Costs: no screenshots at all (including the user's own), and the recents card shows a
      blank/placeholder tile. Both are correct for this app and are what every other serious
      wallet does. Found by the 2026-09-18 Android adversarial pass.
    */
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

    super.onCreate(savedInstanceState)
  }

  // The web app owns light/dark entirely (CSS tokens + `.dark` class + `color-scheme`).
  // Android's WebView "algorithmic darkening" would otherwise re-tint our already-themed
  // pages into washed-out / inverted colors on a device in dark mode. themes.xml opts out
  // via forceDarkAllowed (API 29-32); on API 33+ that flag is ignored, so we also turn the
  // setting off directly here once the Tauri WebView exists. Guarded by WebViewFeature so it
  // no-ops on WebView builds that don't support it.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
      WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
    }
  }
}
