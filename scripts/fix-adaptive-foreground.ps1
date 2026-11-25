# Shrink the Android ADAPTIVE-ICON foreground PNGs into Android's safe zone.
#
# WHY: Android composites an adaptive icon on a 108x108dp canvas but only GUARANTEES the
# centre 72x72dp is visible -- the outer ~33% is a bleed area the launcher may mask away so it
# can crop the icon to a circle / squircle / rounded square. `tauri icon` generates
# ic_launcher_foreground.png from the full-bleed source icon, whose "SB" mark spans 78% of the
# tile. That is well outside the 66% safe zone, so the S and B were visibly CLIPPED on the
# phone's home screen.
#
# This redraws each foreground PNG with the artwork scaled to SAFE_FRACTION of the canvas,
# centred, on transparency (the launcher supplies its own shaped background). It rescales the
# EXISTING PNGs rather than re-rasterizing the SVG so no new image dependency is needed --
# `sharp` is not installed here, and adding a native module for a one-off icon fix is a poor
# trade.
#
# ⚠️ Re-running this on ALREADY-SHRUNK files would shrink them again. It is idempotent-unsafe
# by nature, so run it only after `npx tauri icon` has regenerated the originals.
#
# Run:  npx tauri icon src-tauri/icons/source-icon.svg
#       powershell -File scripts/fix-adaptive-foreground.ps1

Add-Type -AssemblyName System.Drawing

# Fraction of the canvas the mark should occupy. Android's guaranteed-visible area is 72/108
# = 0.667; 0.62 leaves a little margin so the glyphs never touch the mask edge even on
# launchers that crop aggressively (a circular mask cuts the corners hardest).
$SAFE_FRACTION = 0.62

$root = Split-Path -Parent $PSScriptRoot
$resDir = Join-Path $root "src-tauri\gen\android\app\src\main\res"
$targets = Get-ChildItem -Path $resDir -Recurse -Filter "ic_launcher_foreground.png" -ErrorAction Stop

if ($targets.Count -eq 0) { Write-Error "no ic_launcher_foreground.png found under $resDir"; exit 1 }

foreach ($file in $targets) {
    $src = [System.Drawing.Image]::FromFile($file.FullName)
    $w = $src.Width
    $h = $src.Height

    # New canvas, same dimensions, fully transparent.
    $dst = New-Object System.Drawing.Bitmap($w, $h)
    $dst.MakeTransparent()
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Draw the original scaled down and centred.
    $newW = [int][Math]::Round($w * $SAFE_FRACTION)
    $newH = [int][Math]::Round($h * $SAFE_FRACTION)
    $x = [int][Math]::Round(($w - $newW) / 2)
    $y = [int][Math]::Round(($h - $newH) / 2)
    $g.DrawImage($src, $x, $y, $newW, $newH)

    $g.Dispose()
    $src.Dispose()

    # Write to a temp file first, then replace -- writing to the path we just read from fails
    # while the source Image still holds the handle on some runtimes.
    $tmp = "$($file.FullName).tmp"
    $dst.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $dst.Dispose()
    Move-Item -Force $tmp $file.FullName

    Write-Output "scaled $($file.Directory.Name)/$($file.Name)  ${w}x${h} -> mark at ${newW}x${newH}"
}

Write-Output "done - foreground artwork now inside Android's safe zone ($SAFE_FRACTION of canvas)"
