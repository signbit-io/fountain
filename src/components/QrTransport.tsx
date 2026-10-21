import { useCallback, useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { Button, Modal, Alert } from './ui'
import { encodeToFrames, frameToSvg, parseFrame, FrameCollector } from '../lib/qr'
import { useI18n } from '../i18n'

/*
  Camera permission denial is a one-way trap on every desktop/mobile OS: once the user (or an
  accidental click) blocks camera access for this app, calling getUserMedia() again does NOT
  re-prompt — the browser/WebView just rejects immediately every time. There is no web API and
  no Tauri plugin to force a re-prompt or open the OS's privacy settings panel directly, so the
  only way back in is the user re-enabling it in their OS settings. We can't automate that step,
  but we CAN detect the denial specifically (NotAllowedError, distinct from "no camera" or
  "camera in use elsewhere") and tell them exactly where to look for their OS.
*/
type OsHint = 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'other'

function detectOs(): OsHint {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Windows/.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macos'
  if (/Linux/.test(ua)) return 'linux'
  return 'other'
}

/*
  QR transport UI — thin wrappers around lib/qr.ts's pure encode/decode logic. Two modals:

   - QrDisplayModal: renders `text` as one or more QR codes. A payload too big for one QR
     splits into several STATIC frames the user steps through with Next/Prev (their own pace —
     not a timed animation; see lib/qr.ts's header comment for why).
   - QrScanModal: opens the device camera and decodes frames as they're scanned, showing
     live progress ("2 of 4 frames") until the full payload is reassembled.

  Camera access uses the standard `getUserMedia` Web API — it works in the Tauri WebView with
  no extra native/plugin dependency (the OS's own permission prompt gates it), so no Rust
  command or capability entry is needed here.
*/

export function QrDisplayModal({ open, onClose, text }: { open: boolean; onClose: () => void; text: string }) {
  const { t } = useI18n()
  const [frames, setFrames] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setIndex(0)
    setError(null)
    try {
      setFrames(encodeToFrames(text))
    } catch (e) {
      setError((e as Error).message)
      setFrames([])
    }
  }, [open, text])

  const svg = frames[index] ? frameToSvg(frames[index]) : null

  return (
    <Modal open={open} onClose={onClose} title={t('qr.displayTitle')} wide>
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        {svg && (
          <div
            // aspect-square + the scalable SVG (viewBox only, no fixed px width/height —
            // see lib/qr.ts frameToSvg) let this shrink to fit a narrow phone screen instead
            // of overflowing or getting clipped by the modal.
            //
            // GROWS ON BIGGER SCREENS (320 → 420 → 560px). This is the code a phone camera has
            // to read, often from a foot or two away, so physical size on the displaying screen
            // is the single cheapest way to make a scan succeed: a bigger code means more camera
            // pixels per QR module. The 320px phone cap stays — a phone displaying to another
            // phone is limited by its own screen anyway.
            className="mx-auto aspect-square w-full max-w-[320px] rounded-xl border border-line bg-white p-3 sm:max-w-[420px] lg:max-w-[560px] [&>svg]:h-full [&>svg]:w-full"
            // qrcode-generator's own SVG output — no user-controlled HTML, just module cells.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
        {frames.length > 1 && (
          <div className="flex items-center justify-between gap-3">
            {/* min-h-11 (44px) — these get tapped repeatedly while holding a phone up to
                step through frames, so a comfortable touch target matters more here than on
                a one-off button. */}
            <Button
              variant="ghost"
              className="min-h-11 px-4 text-sm"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              {t('qr.prevFrame')}
            </Button>
            <span className="text-sm font-medium text-ink">
              {t('qr.frameOf', { index: index + 1, total: frames.length })}
            </span>
            <Button
              variant="ghost"
              className="min-h-11 px-4 text-sm"
              disabled={index === frames.length - 1}
              onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))}
            >
              {t('qr.nextFrame')}
            </Button>
          </div>
        )}
        {frames.length > 1 && <Alert kind="warn">{t('qr.multiFrameHint')}</Alert>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function QrScanModal({
  open,
  onClose,
  onScanned,
}: {
  open: boolean
  onClose: () => void
  /** Called once with the fully reassembled payload text. */
  onScanned: (text: string) => void
}) {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const collectorRef = useRef(new FrameCollector())
  const rafRef = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  // Tracks WHICH frames are held, not just how many — a bare "1 of 2" leaves the user
  // re-scanning codes they already have, hunting for the one they're missing.
  const [progress, setProgress] = useState<{ have: number; total: number; missing: number[] } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    collectorRef.current.reset()
    setProgress(null)
    setError(null)
    setPermissionDenied(false)

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        tick()
      } catch (e) {
        if (cancelled) return
        // NotAllowedError = the user (or an earlier accidental click) blocked camera access.
        // Re-calling getUserMedia will NOT re-prompt on any OS — only their OS settings can
        // undo that, so this gets a distinct message with exact steps, not the generic one.
        if (e instanceof Error && e.name === 'NotAllowedError') {
          setPermissionDenied(true)
        } else {
          setError(t('qr.errorCamera'))
        }
      }
    }

    function tick() {
      if (cancelled) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(imageData.data, imageData.width, imageData.height)
          if (code) handleScanned(code.data)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    function handleScanned(scanned: string) {
      const parsed = parseFrame(scanned)
      if (parsed.status !== 'ok') return // not one of our frames (e.g. camera glare) — keep scanning
      const result = collectorRef.current.add(parsed.frame)
      if (result === 'mismatch') {
        setError(t('qr.errorMismatch'))
        return
      }
      setProgress({ ...collectorRef.current.progress(), missing: collectorRef.current.missing() })
      if (collectorRef.current.isComplete) {
        stop()
        try {
          onScanned(collectorRef.current.finish())
        } catch {
          setError(t('qr.errorIncomplete'))
        }
      }
    }

    function stop() {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((tr) => tr.stop())
      streamRef.current = null
    }

    start()
    return () => {
      cancelled = true
      stop()
    }
  }, [open, onScanned, t, attempt])

  const retry = useCallback(() => {
    setPermissionDenied(false)
    setError(null)
    setAttempt((n) => n + 1) // bumps the effect dep so the hook's cleanup + start() re-run
  }, [])

  return (
    <Modal open={open} onClose={onClose} title={t('qr.scanTitle')}>
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        {permissionDenied && <CameraPermissionHelp onRetry={retry} />}
        {/* aspect-square keeps the feed a predictable, screen-filling shape on a phone in
            portrait (a bare <video> at native aspect can end up a thin, hard-to-aim sliver
            inside the modal) — object-cover crops to fill it, matching how phone QR scanners
            typically frame the viewfinder. The corner brackets are a purely visual scan-target
            hint (no functional effect on jsQR, which scans the whole frame regardless). */}
        <div className="relative aspect-square w-full max-w-sm mx-auto overflow-hidden rounded-xl border border-line bg-black">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <canvas ref={canvasRef} className="hidden" />
          <div className="pointer-events-none absolute inset-6 sm:inset-8" aria-hidden="true">
            <div className="absolute left-0 top-0 h-8 w-8 border-l-2 border-t-2 border-white/70" />
            <div className="absolute right-0 top-0 h-8 w-8 border-r-2 border-t-2 border-white/70" />
            <div className="absolute bottom-0 left-0 h-8 w-8 border-b-2 border-l-2 border-white/70" />
            <div className="absolute bottom-0 right-0 h-8 w-8 border-b-2 border-r-2 border-white/70" />
          </div>
        </div>
        {/* Per-frame capture state, not just a count. "1 of 2" tells the user something is
            missing but not WHICH, so they re-scan codes they already hold hunting for the gap.
            A tick per frame turns that into a directed action: go find the grey one. */}
        {progress && progress.total > 1 && (
          <div className="space-y-2">
            <Alert kind="ok">{t('qr.scanProgress', { have: progress.have, total: progress.total })}</Alert>
            <div className="flex flex-wrap justify-center gap-1.5">
              {Array.from({ length: progress.total }, (_, i) => {
                const captured = !progress.missing.includes(i)
                return (
                  <span
                    key={i}
                    // min-w-9 keeps these legible (and thumb-sized) on a phone held at arm's
                    // length while the other hand aims the camera.
                    className={[
                      'inline-flex min-w-9 items-center justify-center gap-1 border px-2 py-1 font-mono text-xs',
                      captured
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'border-line bg-surface-2 text-ink-muted',
                    ].join(' ')}
                  >
                    {captured && <span aria-hidden="true">✓</span>}
                    {i + 1}
                  </span>
                )
              })}
            </div>
            {progress.missing.length > 0 && (
              <p className="text-center text-xs text-ink-muted">
                {t('qr.scanStillNeed', { frames: progress.missing.map((i) => i + 1).join(', ') })}
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-ink-muted">{t('qr.scanHint')}</p>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function CameraPermissionHelp({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n()
  const os = detectOs()
  const stepsKey =
    os === 'other'
      ? null // no OS-specific steps to show — the generic message below still applies
      : (`qr.permissionSteps.${os}` as const)

  return (
    <Alert kind="error">
      <div className="space-y-2">
        <p>{t('qr.errorPermissionDenied')}</p>
        {stepsKey && <p className="text-xs">{t(stepsKey)}</p>}
        <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={onRetry}>
          {t('qr.retryCamera')}
        </Button>
      </div>
    </Alert>
  )
}
