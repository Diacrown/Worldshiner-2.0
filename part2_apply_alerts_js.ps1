# Part 2: replaces the old loadSlaAlerts/loadAlerts JS with the new HQ
# Alerts logic, and inserts the needed CSS + SheetJS script tag.
$path = "frontend\index.html"
if (-not (Test-Path $path)) { Write-Host "ERROR: run this from the repo root." -ForegroundColor Red; exit 1 }
$content = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
$content = $content -replace "`r`n", "`n"  # normalize to LF for reliable matching

function Replace-Literal($content, $old, $new, $label) {
  $count = ([regex]::Matches($content, [regex]::Escape($old))).Count
  if ($count -ne 1) { Write-Host "SKIPPED ($label): expected 1 match, found $count." -ForegroundColor Yellow; return $content }
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

$newJs = @'

// ---- Alerts (Diacrown/Diamore HQ only) ----
// The old India tracker's 7 status-driven categories, ported as-is into this
// view — same place in the sidebar it always had, just with the old logic
// instead of the generic SLA/Needs Attention feed this view used to show.
// Nothing is cached beyond the current page visit; every open re-fetches
// fresh counts, exactly like the old app recomputed everything live.
let hqAlertCats = [];       // [{id,label,limitLabel}], filled in by /hq-alerts/counts
let hqAlertCounts = {};     // { [catId]: n }
let hqAlertOpenCat = null;  // which category is expanded, or null
let hqAlertItemsCache = {}; // { [catId]: items[] } — cleared each time the view loads

async function refreshHqAlertBadge() {
  try {
    const office = $('officeSwitcher').value;
    const params = new URLSearchParams(); if (office) params.set('office', office);
    const data = await api(`/hq-alerts/counts?${params.toString()}`);
    hqAlertCats = data.cats; hqAlertCounts = data.counts;
    renderHqAlertPanel();
  } catch (e) { toast(e.message); }
}
function toggleHqAlertCat(catId) {
  hqAlertOpenCat = hqAlertOpenCat === catId ? null : catId;
  renderHqAlertPanel();
  if (hqAlertOpenCat && !hqAlertItemsCache[hqAlertOpenCat]) loadHqAlertCatItems(hqAlertOpenCat);
}
async function loadHqAlertCatItems(catId) {
  try {
    const office = $('officeSwitcher').value;
    const params = new URLSearchParams(); if (office) params.set('office', office);
    const { items } = await api(`/hq-alerts/${catId}?${params.toString()}`);
    hqAlertItemsCache[catId] = items;
    if (hqAlertOpenCat === catId) renderHqAlertPanel();
  } catch (e) { toast(e.message); }
}
function renderHqAlertPanel() {
  const office = $('officeSwitcher').value;
  const officeLabel = office ? (document.querySelector(`#officeSwitcher option[value="${office}"]`)?.textContent || office) : '';
  $('hqAlertScopeNote').textContent = office
    ? `Showing ${officeLabel} · counts include every office in your org`
    : 'Showing every office in your org';
  const total = Object.values(hqAlertCounts).reduce((a, b) => a + b, 0);
  if (!hqAlertCats.length) { $('hqAlertList').innerHTML = `<div class="hq-alert-empty">Loading…</div>`; return; }
  if (!total) {
    $('hqAlertList').innerHTML = `<div class="hq-alert-empty">✅ Nothing overdue right now — all caught up.</div>`;
    return;
  }
  $('hqAlertList').innerHTML = hqAlertCats.map(cat => {
    const n = hqAlertCounts[cat.id] || 0;
    const open = hqAlertOpenCat === cat.id;
    let body = '';
    if (open) {
      const items = hqAlertItemsCache[cat.id];
      if (!items) body = `<div class="hq-alert-empty">Loading…</div>`;
      else if (!items.length) body = `<div class="hq-alert-empty">No jobs here right now.</div>`;
      else body = items.map(it => {
        const hi = (it.overByH || 0) >= 24 || it.overdue;
        const pill = cat.id === 'duedate' ? (it.overdue ? 'OVERDUE' : 'DUE SOON') : 'OVER LIMIT';
        return `<div class="hq-alert-item ${hi ? 'hi' : 'mid'}" onclick="openJobDetail('${it.jobId}')">
          <div class="hq-alert-item-top"><span>${escapeHtml(it.jobName || '(untitled)')}</span><span class="hq-alert-pill">${pill}</span></div>
          <div class="hq-alert-item-reason">${escapeHtml(it.officeName || '')} · ${escapeHtml(it.reason)}</div>
        </div>`;
      }).join('');
    }
    return `<div class="hq-alert-cat">
      <div class="hq-alert-cat-head" onclick="toggleHqAlertCat('${cat.id}')">
        <span class="hq-alert-cat-arrow${open ? ' open' : ''}">▶</span>
        <span class="hq-alert-cat-name">${escapeHtml(cat.label)} <span class="hq-alert-cat-limit">(${escapeHtml(cat.limitLabel)})</span></span>
        <span class="hq-alert-cat-count${n ? ' hot' : ''}">${n}</span>
        <button class="hq-alert-cat-xl" title="Download this list as Excel" onclick="event.stopPropagation();downloadHqAlertExcel('${cat.id}')">⬇️</button>
      </div>
      ${open ? `<div class="hq-alert-cat-body">${body}</div>` : ''}
    </div>`;
  }).join('');
}
async function downloadHqAlertExcel(catId) {
  const cat = hqAlertCats.find(c => c.id === catId); if (!cat) return;
  let items = hqAlertItemsCache[catId];
  if (!items) { await loadHqAlertCatItems(catId); items = hqAlertItemsCache[catId]; }
  if (!items || !items.length) { toast(`No jobs currently in "${cat.label}" to export.`); return; }
  const header = ['Office', 'Status', 'PO Number', 'Design No.', 'Reason'];
  const extraCols = { cadIssuedTo: 'Cad Partner', vendor: 'Vendor' };
  const xlCols = { cadpending: ['cadIssuedTo'], readytoship: ['vendor'], duedate: ['vendor'] }[catId] || [];
  header.push(...xlCols.map(k => extraCols[k]));
  const rows = [header, ...items.map(it => [
    it.officeName || '', it.hqStatusCode || '', it.poNumber || '', it.designNo || '', it.reason || '',
    ...xlCols.map(k => it[k] || ''),
  ])];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  const sheetName = cat.label.replace(/[:\\/?*\[\]]/g, '-').slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${cat.label.replace(/[\\/:*?"<>|]/g, '-')}_${today}.xlsx`);
}

'@

$content = Replace-Span $content "async function loadSlaAlerts() {" "// ---- Executive Dashboard ----" ($newJs + "`n// ---- Executive Dashboard ----") "loadSlaAlerts/loadAlerts JS block"

$cssBlock = @'

  /* ── Alerts view (Diacrown/Diamore HQ only) — ported from india_factory_app.html's 7-category alert system, now living as a normal page in its original sidebar slot instead of a header dropdown ── */
  .hq-alert-scopenote{padding:6px 12px;font-size:10.5px;color:var(--text2);background:var(--s2);border:1px solid var(--border);border-radius:var(--rad) var(--rad) 0 0;border-bottom:none}
  .hq-alert-empty{padding:16px 14px;font-size:12.5px;color:var(--text2);font-style:italic;border:1px solid var(--border);border-top:none}
  #hqAlertList{border:1px solid var(--border);border-radius:0 0 var(--rad) var(--rad);overflow:hidden}
  .hq-alert-cat{border-bottom:1px solid var(--border);background:var(--s1)}
  .hq-alert-cat:last-child{border-bottom:none}
  .hq-alert-cat-head{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-size:13px}
  .hq-alert-cat-head:hover{background:var(--s2)}
  .hq-alert-cat-arrow{font-size:9px;color:var(--text2);transition:transform .12s ease}
  .hq-alert-cat-arrow.open{transform:rotate(90deg)}
  .hq-alert-cat-name{flex:1;font-weight:600;color:var(--text)}
  .hq-alert-cat-limit{font-weight:400;color:var(--text2);font-size:11px}
  .hq-alert-cat-count{background:var(--s3);border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;color:var(--text2)}
  .hq-alert-cat-count.hot{background:var(--red);color:#fff}
  .hq-alert-cat-xl{background:none;border:none;padding:2px 4px;font-size:13px;border-radius:4px}
  .hq-alert-cat-xl:hover{background:var(--s3)}
  .hq-alert-cat-body{background:var(--s2)}
  .hq-alert-item{padding:9px 14px;border-top:1px solid var(--border);cursor:pointer}
  .hq-alert-item:hover{background:var(--s3)}
  .hq-alert-item-top{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;font-weight:600;color:var(--text)}
  .hq-alert-pill{font-size:9.5px;font-weight:700;border-radius:8px;padding:1px 7px;white-space:nowrap}
  .hq-alert-item.mid .hq-alert-pill{background:var(--gold-bg);color:var(--gold-dark)}
  .hq-alert-item.hi .hq-alert-pill{background:var(--burgundy-bg);color:var(--red)}

'@

# Insert CSS right before the closing </style> tag (assumes exactly one <style> block)
$styleCloseCount = ([regex]::Matches($content, "</style>")).Count
if ($styleCloseCount -ne 1) {
  Write-Host "SKIPPED (CSS insert): expected exactly one </style> tag, found $styleCloseCount. Paste it manually instead." -ForegroundColor Yellow
} else {
  $content = $content.Replace("</style>", $cssBlock + "`n</style>")
  Write-Host "OK (CSS insert)" -ForegroundColor Green
}

# Insert SheetJS script tag right after config.js, if not already present
if ($content -notmatch "xlsx\.full\.min\.js") {
  $content = Replace-Literal $content '<script src="config.js"></script>' "<script src=""config.js""></script>`n<script src=""https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js""></script>" "SheetJS script tag"
} else {
  Write-Host "SKIPPED (SheetJS): already present in the file, nothing to add." -ForegroundColor Cyan
}

$content = $content -replace "`n", "`r`n"  # restore CRLF to match the rest of the repo
[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "`nDone. Open frontend\index.html and search for 'hqAlert' to confirm the new code is there." -ForegroundColor Cyan
