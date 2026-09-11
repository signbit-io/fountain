package io.signbit.fountain

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
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
