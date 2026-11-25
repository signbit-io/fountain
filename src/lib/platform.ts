/*
  Which kind of device the app is running on, for the few places where the phone's own pickers
  and dialogs behave differently from a desktop's. Read from the webview's user agent once.

  ⚠️ iPadOS webviews report a MAC user agent ("Macintosh") by default. A Mac has no touch screen,
  so "Macintosh with more than one touch point" is an iPad. Without this an iPad would get the
  desktop file flows, which do not work there (iOS readiness, 2026-11-12).
*/
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0

export const IS_ANDROID = /Android/i.test(ua)
export const IS_IOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
export const IS_MOBILE = IS_ANDROID || IS_IOS
