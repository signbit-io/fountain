# Free the Tauri dev ports before Vite starts. Vite uses strictPort:true on 1420 (see
# vite.config.ts), so a leftover process from a crashed `tauri dev` makes the next launch
# fail. This clears ONLY 1420 (Vite) + 1421 (HMR) — it does NOT touch other node processes,
# so a platform (:8787) / signer (:8790) running alongside is left alone. Wired as `predev`,
# so `npm run tauri dev` self-cleans every launch. No-op when the ports are already free.

$freed = 0
foreach ($port in 1420, 1421) {
  $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $pids) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Write-Host "[clean-dev-ports] freed :$port (pid $procId)"
    $freed++
  }
}
if ($freed -eq 0) { Write-Host "[clean-dev-ports] ports 1420/1421 already free" }
