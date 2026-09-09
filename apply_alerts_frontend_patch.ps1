# Patches frontend/index.html to swap the generic Alerts (SLA Breaches /
# Needs Attention) for the Diacrown/Diamore HQ 7-category alerts.
# Run from your repo root: powershell -ExecutionPolicy Bypass -File apply_alerts_frontend_patch.ps1

$path = "frontend\index.html"
if (-not (Test-Path $path)) { Write-Host "ERROR: run this from the repo root (where the 'frontend' folder is)." -ForegroundColor Red; exit 1 }

$content = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
$content = $content -replace "`r`n", "`n"  # normalize to LF for reliable matching
$backupPath = "frontend\index.html.bak-before-alerts"
[System.IO.File]::WriteAllText($backupPath, $content, [System.Text.Encoding]::UTF8)
Write-Host "Backup saved to $backupPath (restore with: copy that file back over frontend\index.html)" -ForegroundColor Cyan

function Replace-Literal($content, $old, $new, $label) {
  $count = ([regex]::Matches($content, [regex]::Escape($old))).Count
  if ($count -ne 1) { Write-Host "SKIPPED ($label): expected 1 exact match, found $count." -ForegroundColor Yellow; return $content }
  Write-Host "OK ($label)" -ForegroundColor Green
  return $content.Replace($old, $new)
}

function Replace-Span($content, $startAnchor, $endAnchor, $new, $label) {
  $pattern = [regex]::Escape($startAnchor) + "[\s\S]*?" + [regex]::Escape($endAnchor)
  $matches = [regex]::Matches($content, $pattern)
  if ($matches.Count -ne 1) { Write-Host "SKIPPED ($label): expected 1 span match, found $($matches.Count)." -ForegroundColor Yellow; return $content }
  Write-Host "OK ($label)" -ForegroundColor Green
  return $content.Substring(0, $matches[0].Index) + $new + $content.Substring($matches[0].Index + $matches[0].Length)
}

# 1. Nav visibility -> gate to officeIsHq
$content = Replace-Literal $content `
  "document.querySelector('[data-view=""sla""]').style.display = 'flex';" `
  "document.querySelector('[data-view=""sla""]').style.display = USER.officeIsHq ? 'flex' : 'none';" `
  "nav visibility line"

# 2. VIEWS.sla entry
$content = Replace-Literal $content `
  "  sla: { onEnter: () => loadSlaAlerts() }," `
  "  sla: { onEnter: () => { hqAlertItemsCache = {}; hqAlertOpenCat = null; refreshHqAlertBadge(); } }," `
  "VIEWS.sla entry"

# 3. SUBTAB_ENTER needsAttention entry -> remove
$content = Replace-Literal $content "`n  needsAttention: () => loadAlerts()," "" "SUBTAB_ENTER needsAttention removal"

# 4. slaView markup block (anchored, avoids emoji-matching issues)
$new4 = @'
        <div id="slaView" style="display:none">
          <div class="section-head"><div><h2>Alerts</h2><p>The old Diacrown/Diamore India tracker's 7 status-driven categories, worked out fresh every time you open this.</p></div></div>
          <div class="hq-alert-scopenote" id="hqAlertScopeNote"></div>
          <div id="hqAlertList"></div>
        </div>
'@
$content = Replace-Span $content '<div id="slaView" style="display:none">' '<div class="empty" id="alertsChaseEmpty" style="display:none">No client follow-ups due.</div>
          </div>
        </div>' $new4 "slaView markup block"

$content = $content -replace "`n", "`r`n"  # restore CRLF to match the rest of the repo
[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "`nPart 1 done. Now run part2_apply_alerts_js.ps1 next." -ForegroundColor Cyan
