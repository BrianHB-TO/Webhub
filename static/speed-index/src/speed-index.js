const app = document.querySelector('#app');

const state = {
  summary: null,
  tab: 'URLs',
  device: 'mobile',
  selectedPageId: null,
  urlSubtab: 'Trend',
  metric: 'lcp',
  search: '',
  sort: 'impact'
};

const TOP_TABS = ['URLs', 'Trends', 'Detail'];
const URL_SUBTABS = ['Trend', 'Fixes', 'Network', 'Diagnostics'];
const METRICS = [
  { key: 'score', source: 'performanceScore', label: 'Performance score', shortLabel: 'Score', unit: 'score', lowerBetter: false, good: 90, poor: 50 },
  { key: 'lcp', label: 'LCP', unit: 'ms', lowerBetter: true, good: 2500, poor: 4000 },
  { key: 'fcp', label: 'FCP', unit: 'ms', lowerBetter: true, good: 1800, poor: 3000 },
  { key: 'speedIndex', label: 'Speed Index', shortLabel: 'SI', unit: 'ms', lowerBetter: true, good: 3400, poor: 5800 },
  { key: 'tbt', label: 'TBT', unit: 'ms', lowerBetter: true, good: 200, poor: 600 },
  { key: 'cls', label: 'CLS', unit: 'number', lowerBetter: true, good: 0.1, poor: 0.25 },
  { key: 'totalBytes', label: 'Bytes', unit: 'bytes', lowerBetter: true, good: 2.5 * 1024 * 1024, poor: 5 * 1024 * 1024 }
];

init();

async function init() {
  try {
    state.summary = await loadSummary();
    state.selectedPageId = state.summary.pages?.[0]?.id || null;
    app.addEventListener('click', handleClick);
    app.addEventListener('input', handleInput);
    app.addEventListener('change', handleChange);
    render();
  } catch (error) {
    app.innerHTML = `<main class="empty-state">Dashboard data failed to load: ${escapeHtml(error.message)}</main>`;
  }
}

function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action } = target.dataset;
  if (action === 'tab') state.tab = target.dataset.tab;
  if (action === 'device') state.device = target.dataset.device;
  if (action === 'page') state.selectedPageId = target.dataset.pageId;
  if (action === 'subtab') state.urlSubtab = target.dataset.subtab;
  if (action === 'metric') {
    state.metric = target.dataset.metric;
    state.urlSubtab = 'Trend';
  }
  render();
}

function handleInput(event) {
  if (event.target.matches('[data-bind="search"]')) {
    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;
    state.search = event.target.value;
    syncSelectedPage();
    render({
      restoreFocus: {
        selector: '[data-bind="search"]',
        selectionStart,
        selectionEnd
      }
    });
  }
}

function handleChange(event) {
  if (event.target.matches('[data-bind="sort"]')) {
    state.sort = event.target.value;
    render();
  }
  if (event.target.matches('[data-bind="page"]')) {
    state.selectedPageId = event.target.value;
    render();
  }
  if (event.target.matches('[data-bind="metric"]')) {
    state.metric = event.target.value;
    render();
  }
}

async function loadSummary() {
  const fallback = new URL('data/performance-summary.json', document.baseURI);
  const candidates = [
    window.SPEED_INDEX_DATA_URL,
    '/api/speed-index/summary',
    fallback
  ].filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: 'no-store' });
      if (!response.ok) {
        lastError = new Error(`Failed to load ${candidate}: ${response.status}`);
        continue;
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No Speed Index data source is available.');
}

function render(options = {}) {
  if (!state.summary) return;
  app.innerHTML = `
    ${renderHeader()}
    ${state.tab === 'URLs' ? renderUrlsTab() : ''}
    ${state.tab === 'Trends' ? renderTrendsTab() : ''}
    ${state.tab === 'Detail' ? renderDetailTab() : ''}
  `;
  restoreFocus(options.restoreFocus);
}

function renderHeader() {
  const meta = state.summary.meta || {};
  const latestRun = state.summary.runs?.lab?.at(-1);
  return `<header class="topbar">
    <div class="brand-block">
      <div class="eyebrow">${escapeHtml(hostname(meta.origin) || 'joinhomebase.com')}</div>
      <h1>Web Speed Index</h1>
      <p>${escapeHtml(formatDateTime(meta.generatedAt))} · ${escapeHtml(latestRun?.sourceLabel || 'Lab')} medians · ${formatCount(meta.watchlistCount)} URLs</p>
    </div>
    <div class="top-actions">
      <nav class="seg" aria-label="Dashboard view">
        ${TOP_TABS.map((tab) => `<button type="button" data-action="tab" data-tab="${tab}" class="${state.tab === tab ? 'active' : ''}">${tab}</button>`).join('')}
      </nav>
      <nav class="seg compact" aria-label="Device">
        ${['mobile', 'desktop'].map((device) => `<button type="button" data-action="device" data-device="${device}" class="${state.device === device ? 'active' : ''}">${titleCase(device)}</button>`).join('')}
      </nav>
    </div>
  </header>`;
}

function renderUrlsTab() {
  const page = selectedPage();
  if (!page) return '<main class="empty-state">No URLs available.</main>';
  const lab = labFor(page);
  return `<main class="urls-layout">
    ${renderSidebar()}
    <section class="workspace">
      ${renderPageHeader(page, lab)}
      ${renderMetricRail(page, lab)}
      <nav class="click-tabs" aria-label="URL detail tabs">
        ${URL_SUBTABS.map((tab) => `<button type="button" data-action="subtab" data-subtab="${tab}" class="${state.urlSubtab === tab ? 'active' : ''}">${tab}</button>`).join('')}
      </nav>
      ${state.urlSubtab === 'Trend' ? renderUrlTrend(page, lab) : ''}
      ${state.urlSubtab === 'Fixes' ? renderUrlFixes(page, lab) : ''}
      ${state.urlSubtab === 'Network' ? renderUrlNetwork(page, lab) : ''}
      ${state.urlSubtab === 'Diagnostics' ? renderUrlDiagnostics(page, lab) : ''}
    </section>
  </main>`;
}

function renderSidebar() {
  const rows = sortedPages();
  return `<aside class="url-sidebar">
    <div class="sidebar-controls">
      <div class="sidebar-topline">
        <span class="eyebrow">${formatCount(rows.length)} pages</span>
        <span class="soft">${titleCase(state.device)}</span>
      </div>
      <div class="filter-row">
        <input data-bind="search" value="${escapeHtml(state.search)}" type="search" placeholder="Filter URLs">
        <select data-bind="sort" aria-label="Sort URLs">
          ${[
            ['impact', 'Sort by impact'],
            ['score', 'Sort by score'],
            ['lcp', 'Sort by LCP'],
            ['bytes', 'Sort by bytes']
          ].map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="page-list">
      ${rows.map((page) => renderPageListRow(page)).join('') || '<div class="empty-state small">No matching URLs.</div>'}
    </div>
  </aside>`;
}

function renderPageListRow(page) {
  const lab = labFor(page);
  const latest = lab.latest || {};
  const score = scoreValue(latest.performanceScore);
  const impact = pageImpact(page.id);
  const active = page.id === state.selectedPageId;
  return `<button type="button" class="page-row ${active ? 'active' : ''}" data-action="page" data-page-id="${escapeHtml(page.id)}">
    <span class="page-row-main">
      <strong>${escapeHtml(page.label)}</strong>
      <span>${escapeHtml(page.path)}</span>
    </span>
    ${sparkline(lab.history || [], 'score', 54, 22)}
    <span class="score ${scoreClass(score)}">${formatScore(latest.performanceScore)}</span>
    <span class="impact">${formatCount(impact)}</span>
  </button>`;
}

function renderPageHeader(page, lab) {
  const latest = lab.latest || {};
  return `<header class="page-header">
    <div>
      <div class="eyebrow">${escapeHtml(page.group || 'URL')}</div>
      <h2>${escapeHtml(page.label)}</h2>
      <p class="path">${escapeHtml(page.path)}</p>
    </div>
    <div class="header-cluster">
      ${pill(statusKind(lab.status), statusTitle(lab.status || lab.state || 'unknown'))}
      ${pill('info', labSourceLabel(lab))}
      ${pill(sampleKind(lab.sampleQuality), sampleLabel(lab.sampleQuality))}
      <a class="ghost-button" href="${escapeHtml(pageSpeedInsightsUrl(page.url))}" target="_blank" rel="noreferrer">Open PSI</a>
      <a class="ghost-button" href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">Open page</a>
    </div>
    <div class="page-kpis">
      ${miniStat(scoreLabel(lab), formatScore(latest.performanceScore))}
      ${miniStat('LCP', formatMs(latest.lcp))}
      ${miniStat('TBT', formatMs(latest.tbt))}
      ${miniStat('Bytes', formatBytes(latest.totalBytes))}
    </div>
  </header>`;
}

function renderMetricRail(page, lab) {
  const latest = lab.latest || {};
  return `<div class="metric-rail">
    ${METRICS.map((metric) => {
      const value = latestMetricValue(latest, metric.key);
      const active = state.metric === metric.key;
      const status = metricStatus(metric, value);
      return `<button type="button" class="metric-tile ${active ? 'active' : ''}" data-action="metric" data-metric="${metric.key}">
        <span class="eyebrow">${escapeHtml(metricTileLabel(metric, lab))}</span>
        <strong>${escapeHtml(formatByMetric(metric, value))}</strong>
        <small>${escapeHtml(metricHint(metric, value, status, lab))}</small>
      </button>`;
    }).join('')}
  </div>`;
}

function renderUrlTrend(page, lab) {
  const metric = metricByKey(state.metric);
  const history = lab.history || [];
  const comparison = lab.comparison;
  return `<div class="trend-shell">
    <section class="panel main-panel">
      <div class="panel-heading">
        <div>
          <div class="eyebrow">${escapeHtml(metricTileLabel(metric, lab))} trend</div>
          <h3>${escapeHtml(page.label)} over ${formatCount(history.length)} snapshots</h3>
        </div>
        <select data-bind="metric" aria-label="Trend metric">
          ${METRICS.map((item) => `<option value="${item.key}" ${item.key === metric.key ? 'selected' : ''}>${item.label}</option>`).join('')}
        </select>
      </div>
      ${trendChart(history, [metric], { height: 280 })}
      <div class="trend-footer">
        <span>${sampleLabel(lab.sampleQuality)} · latest run ${escapeHtml(shortRun(lab.runId))}</span>
        <span>${comparison ? escapeHtml(changeSummary(comparison)) : 'No previous run'}</span>
      </div>
    </section>
    <aside class="panel rail-panel">
      <div class="panel-heading tight">
        <div>
          <div class="eyebrow">Run notes</div>
          <h3>Latest changes</h3>
        </div>
      </div>
      ${renderChangeRail(lab)}
    </aside>
  </div>`;
}

function renderChangeRail(lab) {
  const drivers = lab.comparison?.drivers || [];
  const latest = lab.history?.at(-1);
  const rows = [
    latest ? {
      title: sampleLabel(latest.sampleQuality),
      body: `${formatCount(latest.successCount)} successful samples · ${shortDateTime(latest.collectedAt)}`,
      kind: sampleKind(latest.sampleQuality)
    } : null,
    ...drivers.map((driver) => ({
      title: driver.label,
      body: `${formatMetricValue(driver.previous, driver.unit)} to ${formatMetricValue(driver.latest, driver.unit)} (${formatSignedDelta(driver.delta, driver.unit)})`,
      kind: driver.type === 'worse' ? 'bad' : 'good'
    }))
  ].filter(Boolean);
  if (!rows.length) return '<div class="empty-state small">No run notes for this URL yet.</div>';
  return `<div class="note-list">${rows.map((row) => `<article>
    <div>${pill(row.kind, row.title)}</div>
    <p>${escapeHtml(row.body)}</p>
  </article>`).join('')}</div>`;
}

function renderUrlFixes(page) {
  const fixes = fixesForPage(page.id);
  const totalImpact = fixes.reduce((sum, fix) => sum + (fix.row?.rowImpact || fix.impact || 0), 0);
  const top = fixes[0];
  return `<section class="stack">
    <div class="summary-strip">
      ${bigStat('Open fixes', fixes.length || '0', 'Scoped to this URL/device')}
      ${bigStat('Combined impact', formatCount(totalImpact), 'Lighthouse impact units')}
      ${bigStat('Top theme', top?.category || 'None', top?.confidence ? `${top.confidence} confidence` : 'No matching fix')}
      ${bigStat('Largest evidence', formatBytes(top?.row?.totalBytes), top?.title || 'Run Lighthouse to populate')}
    </div>
    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="eyebrow">Fix queue</div>
          <h3>What to ship next on this page</h3>
        </div>
      </div>
      <div class="fix-list">
        ${fixes.map((fix, index) => fixRow(fix, index)).join('') || '<div class="empty-state">No fix queue items affect this URL on the selected device.</div>'}
      </div>
    </section>
  </section>`;
}

function fixRow(fix, index) {
  const row = fix.row || {};
  return `<article class="fix-row">
    <span class="rank">${index + 1}</span>
    <div class="fix-main">
      <strong>${escapeHtml(fix.title)}</strong>
      <p>${escapeHtml(fix.recommendedAction)}</p>
      <div class="pill-row">${pill('info', fix.category)}${pill('neutral', `${fix.confidence || 'unknown'} confidence`)}</div>
    </div>
    ${miniStat('Impact', formatCount(row.rowImpact || fix.impact))}
    ${miniStat('LCP', formatMs(row.lcp))}
    ${miniStat('TBT', formatMs(row.tbt))}
    ${miniStat('Bytes', formatBytes(row.totalBytes))}
  </article>`;
}

function renderUrlNetwork(page, lab) {
  const latest = lab.latest || {};
  return `<section class="panel">
    <div class="panel-heading">
      <div>
        <div class="eyebrow">Network</div>
        <h3>${formatCount(latest.requestCount)} requests · ${formatBytes(latest.totalBytes)} transferred</h3>
      </div>
      ${pill('info', `${formatBytes(latest.thirdPartyBytes || 0)} third-party`)}
    </div>
    ${networkTable(latest)}
  </section>`;
}

function networkTable(latest) {
  const requests = latest.topRequests || [];
  const maxBytes = Math.max(...requests.map((item) => item.transferSize || 0), 1);
  return `<div class="waterfall">
    <div class="waterfall-head"><span>Request</span><span>Type</span><span>Transfer</span><span>Priority</span><span>Weight</span></div>
    ${requests.slice(0, 18).map((request) => requestRow(request, maxBytes)).join('') || '<div class="empty-state">No request-level data for this run.</div>'}
  </div>`;
}

function requestRow(request, maxBytes) {
  const width = Math.max(2, ((request.transferSize || 0) / maxBytes) * 100);
  const typeClass = String(request.resourceType || 'other').toLowerCase();
  return `<article class="waterfall-row">
    <div class="request-name">
      <strong>${escapeHtml(shortRequestUrl(request.url))}</strong>
      <span>${escapeHtml(request.host || 'unknown host')}</span>
    </div>
    ${pill('neutral', request.resourceType || 'Other')}
    <span class="tabular">${formatBytes(request.transferSize)}</span>
    <span class="soft">${escapeHtml(request.priority || 'missing')}</span>
    <span class="bar-track"><span class="bar-fill ${escapeHtml(typeClass)}" style="width:${width}%"></span></span>
  </article>`;
}

function renderUrlDiagnostics(page, lab) {
  const latest = lab.latest || {};
  const opportunities = latest.opportunities || [];
  const mainThread = latest.mainThreadBreakdown || [];
  const scripts = latest.bootupScripts || [];
  return `<div class="diagnostics-grid">
    <section class="panel">
      <div class="panel-heading tight">
        <div>
          <div class="eyebrow">Diagnostics</div>
          <h3>Lighthouse opportunities</h3>
        </div>
      </div>
      <div class="diagnostic-list">
        ${opportunities.slice(0, 8).map(opportunityRow).join('') || '<div class="empty-state">No Lighthouse opportunities in this run.</div>'}
      </div>
    </section>
    <section class="panel">
      <div class="panel-heading tight">
        <div>
          <div class="eyebrow">Main thread</div>
          <h3>Work breakdown</h3>
        </div>
      </div>
      <div class="metric-list">
        ${mainThread.slice(0, 8).map((item) => metricListRow(item.label, formatMs(item.duration))).join('') || '<div class="empty-state">No main-thread breakdown.</div>'}
      </div>
    </section>
    <section class="panel panel-wide">
      <div class="panel-heading tight">
        <div>
          <div class="eyebrow">Scripts</div>
          <h3>Bootup cost</h3>
        </div>
      </div>
      <div class="script-list">
        ${scripts.slice(0, 10).map(scriptRow).join('') || '<div class="empty-state">No bootup script table.</div>'}
      </div>
    </section>
  </div>`;
}

function opportunityRow(item) {
  const waste = item.items?.reduce((sum, row) => sum + (row.wastedBytes || 0), 0) || 0;
  const delay = item.items?.reduce((sum, row) => sum + (row.wastedMs || 0), 0) || 0;
  const kind = waste > 500 * 1024 || delay > 250 ? 'bad' : 'warn';
  return `<article class="diagnostic-row">
    <span class="dot ${kind}"></span>
    <div>
      <strong>${escapeHtml(item.title || item.label)}</strong>
      <p>${escapeHtml(opportunityMeta(item, waste, delay))}</p>
    </div>
    ${pill(kind, kind === 'bad' ? 'Fail' : 'Watch')}
  </article>`;
}

function scriptRow(item) {
  return `<article class="script-row">
    <div>
      <strong>${escapeHtml(shortRequestUrl(item.url))}</strong>
      <span>${escapeHtml(item.host || 'unknown host')}</span>
    </div>
    ${miniStat('Total', formatMs(item.total))}
    ${miniStat('Scripting', formatMs(item.scripting))}
    ${miniStat('Parse', formatMs(item.scriptParseCompile))}
  </article>`;
}

function renderTrendsTab() {
  const page = selectedPage();
  const lab = labFor(page);
  const runs = state.summary.runs?.lab || [];
  const latestRun = runs.at(-1);
  return `<main class="trend-page">
    <header class="section-header">
      <div>
        <div class="eyebrow">Lab history</div>
        <h2>Run-over-run changes</h2>
      </div>
      <select data-bind="page" aria-label="Trend page">${pageOptions()}</select>
    </header>
    <div class="summary-strip">
      ${bigStat('Logged lab runs', runs.length, latestRun ? `${shortDate(latestRun.collectedAt)} · ${sampleLabel(latestRun.sampleQuality)}` : 'No runs')}
      ${bigStat(`Selected URL · ${state.device}`, page?.label || 'No page', `${formatCount(lab.history?.length || 0)} snapshots`)}
      ${bigStat('Latest change', lab.comparison ? changeSummary(lab.comparison) : 'No prior run', lab.comparison ? `${shortDate(lab.comparison.previous.collectedAt)} to ${shortDate(lab.comparison.latest.collectedAt)}` : 'Run twice to compare')}
    </div>
    <div class="trend-grid">
      <section class="panel run-log">
        <div class="panel-heading tight"><div><div class="eyebrow">Run log</div><h3>Collections</h3></div></div>
        ${runs.slice().reverse().map(runLogRow).join('') || '<div class="empty-state">No Lighthouse run log yet.</div>'}
      </section>
      <section class="panel">
        <div class="panel-heading tight">
          <div><div class="eyebrow">${escapeHtml(page?.path || '')}</div><h3>Timing trend</h3></div>
        </div>
        ${trendChart(lab.history || [], METRICS.filter((metric) => ['lcp', 'fcp', 'speedIndex', 'tbt'].includes(metric.key)), { height: 330 })}
        <hr>
        ${trendChart(lab.history || [], METRICS.filter((metric) => ['totalBytes'].includes(metric.key)), { height: 230 })}
      </section>
    </div>
  </main>`;
}

function runLogRow(run) {
  return `<article class="run-row">
    <div>
      <strong>${escapeHtml(shortDateTime(run.collectedAt))}${run.baseline ? ' · baseline' : ''}</strong>
      <span>${escapeHtml(run.runId)}</span>
    </div>
    ${miniStat('Pages', formatCount(run.pageCount))}
    ${miniStat('OK', formatCount(run.successCount))}
    ${miniStat('Avg', formatNumber(run.averageRunsPerMedian))}
    ${pill(sampleKind(run.sampleQuality), sampleLabel(run.sampleQuality))}
  </article>`;
}

function renderDetailTab() {
  const page = selectedPage();
  if (!page) return '<main class="empty-state">No page selected.</main>';
  const lab = labFor(page);
  const latest = lab.latest || {};
  return `<main class="detail-page">
    <header class="section-header">
      <div>
        <div class="eyebrow">${escapeHtml(labSourceLabel(lab))} run · ${escapeHtml(shortRun(lab.runId))}</div>
        <h2>${escapeHtml(page.label)}</h2>
        <p class="path">${escapeHtml(page.path)}</p>
      </div>
      <select data-bind="page" aria-label="Detail page">${pageOptions()}</select>
    </header>
    <div class="detail-grid">
      <section class="score-panel panel">
        ${scoreDonut(latest.performanceScore)}
        ${pill(statusKind(lab.status), statusTitle(lab.status || 'unknown'))}
        <div class="metric-list">
          ${metricListRow('FCP', formatMs(latest.fcp))}
          ${metricListRow('LCP', formatMs(latest.lcp))}
          ${metricListRow('Speed Index', formatMs(latest.speedIndex))}
          ${metricListRow('TBT', formatMs(latest.tbt))}
          ${metricListRow('CLS', formatNumber(latest.cls))}
        </div>
      </section>
      <section class="panel load-panel">
        <div class="panel-heading tight"><div><div class="eyebrow">Load milestones</div><h3>What the run looked like</h3></div></div>
        ${loadTimeline(latest)}
      </section>
      <section class="panel panel-wide">
        <div class="panel-heading tight"><div><div class="eyebrow">Top requests</div><h3>Largest transfers in the representative run</h3></div></div>
        ${networkTable(latest)}
      </section>
      <section class="panel">
        <div class="panel-heading tight"><div><div class="eyebrow">Domains</div><h3>Transfer by host</h3></div></div>
        <div class="metric-list">${(latest.domainSummary || []).slice(0, 10).map((item) => metricListRow(item.host, `${formatBytes(item.transferSize)} · ${formatCount(item.requestCount)} req`)).join('')}</div>
      </section>
      <section class="panel">
        <div class="panel-heading tight"><div><div class="eyebrow">LCP element</div><h3>Representative element</h3></div></div>
        <div class="code-block">${escapeHtml(formatLcpElement(latest.lcpElement))}</div>
      </section>
    </div>
  </main>`;
}

function trendChart(history, series, options = {}) {
  const rows = (history || []).filter((row) => series.some((metric) => Number.isFinite(historyMetricValue(row, metric))));
  if (rows.length < 2) {
    return '<div class="empty-state">Need at least two run snapshots for this chart.</div>';
  }
  const width = 760;
  const height = options.height || 300;
  const pad = { top: 22, right: 24, bottom: 42, left: 58 };
  const values = series.flatMap((metric) => rows.map((row) => historyMetricValue(row, metric)).filter(Number.isFinite));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const yMin = Math.max(0, min - spread * 0.12);
  const yMax = max + spread * 0.12;
  const x = (index) => pad.left + (index / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right);
  const y = (value) => height - pad.bottom - ((value - yMin) / Math.max(1, yMax - yMin)) * (height - pad.top - pad.bottom);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const grid = ticks.map((step) => {
    const yy = pad.top + step * (height - pad.top - pad.bottom);
    const value = yMax - step * (yMax - yMin);
    return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}"></line>
      <text class="chart-label" x="${pad.left - 10}" y="${yy + 4}" text-anchor="end">${escapeHtml(formatByMetric(series[0], value))}</text>`;
  }).join('');
  const lines = series.map((metric) => {
    const d = rows.map((row, index) => {
      const value = historyMetricValue(row, metric);
      return Number.isFinite(value) ? `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(value).toFixed(1)}` : null;
    }).filter(Boolean).join(' ');
    const points = rows.map((row, index) => {
      const value = historyMetricValue(row, metric);
      if (!Number.isFinite(value)) return '';
      return `<circle class="chart-point metric-${metric.key}" cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="3.2">
        <title>${escapeHtml(`${shortDateTime(row.collectedAt)} · ${metric.label}: ${formatByMetric(metric, value)}`)}</title>
      </circle>`;
    }).join('');
    return `<path class="chart-line metric-${metric.key}" d="${d}"></path>${points}`;
  }).join('');
  const hover = rows.map((row, index) => chartHover(row, index, rows, series, x, pad, width, height)).join('');
  const legend = series.map((metric, index) => `<span><i class="legend-dot metric-${metric.key}"></i>${escapeHtml(metric.label)}</span>`).join('');
  return `<div class="chart-wrap">
    <div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Performance trend chart">
      ${grid}
      <line class="chart-axis" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"></line>
      ${lines}
      ${hover}
      <text class="chart-label" x="${pad.left}" y="${height - 12}">${escapeHtml(shortDate(rows[0].collectedAt))}</text>
      <text class="chart-label" x="${width - pad.right}" y="${height - 12}" text-anchor="end">${escapeHtml(shortDate(rows.at(-1).collectedAt))}</text>
    </svg>
  </div>`;
}

function chartHover(row, index, rows, series, x, pad, width, height) {
  const plotWidth = width - pad.left - pad.right;
  const step = plotWidth / Math.max(1, rows.length - 1);
  const left = index === 0 ? pad.left : x(index) - step / 2;
  const right = index === rows.length - 1 ? width - pad.right : x(index) + step / 2;
  const tipWidth = 196;
  const tipHeight = 28 + series.length * 18;
  const tipX = clamp(x(index) + 12, pad.left + 4, width - tipWidth - 8);
  const tipY = pad.top + 8;
  return `<g class="chart-hover" tabindex="0">
    <rect class="chart-zone" x="${left.toFixed(1)}" y="${pad.top}" width="${Math.max(1, right - left).toFixed(1)}" height="${height - pad.top - pad.bottom}"></rect>
    <line class="chart-hover-line" x1="${x(index).toFixed(1)}" x2="${x(index).toFixed(1)}" y1="${pad.top}" y2="${height - pad.bottom}"></line>
    <g class="tooltip">
      <rect x="${tipX}" y="${tipY}" width="${tipWidth}" height="${tipHeight}" rx="7"></rect>
      <text class="tooltip-title" x="${tipX + 10}" y="${tipY + 20}">${escapeHtml(shortDateTime(row.collectedAt))}</text>
      ${series.map((metric, rowIndex) => `<text class="tooltip-row" x="${tipX + 10}" y="${tipY + 42 + rowIndex * 18}">
        <tspan>${escapeHtml(metric.label)}</tspan><tspan dx="8">${escapeHtml(formatByMetric(metric, historyMetricValue(row, metric)))}</tspan>
      </text>`).join('')}
    </g>
  </g>`;
}

function scoreDonut(scoreRaw) {
  const score = scoreValue(scoreRaw);
  const radius = 78;
  const circumference = 2 * Math.PI * radius;
  const dash = Math.max(0, Math.min(100, score)) / 100 * circumference;
  return `<div class="score-donut">
    <svg width="184" height="184" viewBox="0 0 184 184" aria-label="Performance score ${formatCount(score)}">
      <circle cx="92" cy="92" r="${radius}" class="donut-track"></circle>
      <circle cx="92" cy="92" r="${radius}" class="donut-value ${scoreClass(score)}" stroke-dasharray="${dash} ${circumference}" transform="rotate(-90 92 92)"></circle>
      <text x="92" y="106" text-anchor="middle">${formatCount(score)}</text>
    </svg>
  </div>`;
}

function loadTimeline(latest) {
  const items = [
    ['TTFB', latest.ttfb],
    ['FCP', latest.fcp],
    ['LCP', latest.lcp],
    ['Speed Index', latest.speedIndex],
    ['TBT', latest.tbt]
  ].filter(([, value]) => Number.isFinite(value));
  if (!items.length) return '<div class="empty-state">No milestone timings in this run.</div>';
  const max = Math.max(...items.map(([, value]) => value), 1);
  return `<div class="load-timeline">${items.map(([label, value]) => `<article>
    <span>${escapeHtml(label)}</span>
    <b>${escapeHtml(formatMs(value))}</b>
    <i><em style="width:${Math.max(2, value / max * 100)}%"></em></i>
  </article>`).join('')}</div>`;
}

function fixesForPage(pageId) {
  return (state.summary.insights?.fixQueue || []).flatMap((fix) => {
    const row = (fix.affected || []).find((item) => item.pageId === pageId && item.device === state.device);
    return row ? [{ ...fix, row }] : [];
  }).sort((a, b) => (b.row?.rowImpact || b.impact || 0) - (a.row?.rowImpact || a.impact || 0));
}

function pageImpact(pageId) {
  return fixesForPage(pageId).reduce((sum, fix) => sum + (fix.row?.rowImpact || 0), 0);
}

function filteredPages() {
  const search = state.search.trim().toLowerCase();
  return (state.summary.pages || []).filter((page) => {
    const haystack = `${page.label} ${page.path} ${page.group}`.toLowerCase();
    return !search || haystack.includes(search);
  });
}

function sortedPages() {
  return filteredPages().slice().sort((a, b) => {
    const labA = labFor(a).latest || {};
    const labB = labFor(b).latest || {};
    if (state.sort === 'score') return scoreValue(labA.performanceScore) - scoreValue(labB.performanceScore);
    if (state.sort === 'lcp') return (labB.lcp || 0) - (labA.lcp || 0);
    if (state.sort === 'bytes') return (labB.totalBytes || 0) - (labA.totalBytes || 0);
    return pageImpact(b.id) - pageImpact(a.id);
  });
}

function selectedPage() {
  return (state.summary.pages || []).find((page) => page.id === state.selectedPageId) || sortedPages()[0] || null;
}

function syncSelectedPage() {
  if (!filteredPages().some((page) => page.id === state.selectedPageId)) {
    state.selectedPageId = filteredPages()[0]?.id || null;
  }
}

function labFor(page) {
  return page?.lab?.[state.device] || {};
}

function restoreFocus(target) {
  if (!target?.selector) {
    return;
  }
  const element = app.querySelector(target.selector);
  if (!(element instanceof HTMLElement)) {
    return;
  }
  element.focus({ preventScroll: true });
  if (typeof element.setSelectionRange === 'function' && Number.isFinite(target.selectionStart)) {
    const selectionEnd = Number.isFinite(target.selectionEnd) ? target.selectionEnd : target.selectionStart;
    element.setSelectionRange(target.selectionStart, selectionEnd);
  }
}

function metricByKey(key) {
  return METRICS.find((metric) => metric.key === key) || METRICS[1];
}

function latestMetricValue(latest, key) {
  if (key === 'score') return scoreValue(latest.performanceScore);
  return latest?.[key];
}

function historyMetricValue(row, metric) {
  if (metric.key === 'score') return scoreValue(row.performanceScore);
  return row?.[metric.key];
}

function metricStatus(metric, value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (metric.lowerBetter) {
    if (value <= metric.good) return 'good';
    if (value >= metric.poor) return 'poor';
    return 'warn';
  }
  if (value >= metric.good) return 'good';
  if (value < metric.poor) return 'poor';
  return 'warn';
}

function metricHint(metric, value, status, lab = {}) {
  if (!Number.isFinite(value)) return 'missing';
  if (metric.key === 'score') {
    return lab?.source === 'pagespeed-insights'
      ? 'PSI API median · 0-49 poor · 50-89 needs improvement'
      : 'local Lighthouse median · PSI may differ';
  }
  if (status === 'poor') return metric.lowerBetter ? 'over poor threshold' : 'below poor threshold';
  if (status === 'good') return 'good band';
  return 'watch';
}

function metricTileLabel(metric, lab = {}) {
  if (metric.key === 'score') {
    return scoreLabel(lab);
  }
  return metric.shortLabel || metric.label;
}

function pageOptions() {
  return (state.summary.pages || []).map((page) => `<option value="${escapeHtml(page.id)}" ${page.id === state.selectedPageId ? 'selected' : ''}>${escapeHtml(page.label)}</option>`).join('');
}

function sparkline(history, metricKey, width = 90, height = 32) {
  const metric = metricByKey(metricKey);
  const values = (history || []).map((row) => historyMetricValue(row, metric)).filter(Number.isFinite);
  if (values.length < 2) return `<svg class="spark" width="${width}" height="${height}" aria-hidden="true"></svg>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = index / Math.max(1, values.length - 1) * width;
    const y = height - ((value - min) / range) * (height - 6) - 3;
    return [x, y];
  });
  const d = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${width}" height="${height}" aria-hidden="true"><path d="${d}"></path></svg>`;
}

function pill(kind, label) {
  return `<span class="pill ${escapeHtml(kind || 'neutral')}">${escapeHtml(label || 'missing')}</span>`;
}

function miniStat(label, value) {
  return `<span class="mini-stat"><small>${escapeHtml(label)}</small><b>${escapeHtml(String(value ?? 'missing'))}</b></span>`;
}

function bigStat(label, value, note) {
  return `<article class="big-stat">
    <span class="eyebrow">${escapeHtml(label)}</span>
    <strong>${escapeHtml(String(value ?? 'missing'))}</strong>
    <small>${escapeHtml(note || '')}</small>
  </article>`;
}

function metricListRow(label, value) {
  return `<article><span>${escapeHtml(label || 'missing')}</span><strong>${escapeHtml(value ?? 'missing')}</strong></article>`;
}

function opportunityMeta(item, waste, delay) {
  if (waste) return `${formatBytes(waste)} potential waste across ${formatCount(item.items?.length || 0)} requests`;
  if (delay) return `${formatMs(delay)} potential delay across ${formatCount(item.items?.length || 0)} requests`;
  if (Number.isFinite(item.numericValue)) return formatMs(item.numericValue);
  return `${formatCount(item.items?.length || 0)} request rows`;
}

function changeSummary(comparison) {
  const drivers = comparison?.drivers || [];
  const worse = drivers.filter((driver) => driver.type === 'worse').length;
  const improved = drivers.filter((driver) => driver.type === 'improved').length;
  if (worse && improved) return `${worse} worse / ${improved} better`;
  if (worse) return `${worse} worse`;
  if (improved) return `${improved} improved`;
  return 'Stable';
}

function formatByMetric(metric, value) {
  return formatMetricValue(value, metric.unit);
}

function formatMetricValue(value, unit) {
  if (!Number.isFinite(value)) return 'missing';
  if (unit === 'score') return formatCount(value);
  if (unit === 'ms') return formatMs(value);
  if (unit === 'bytes') return formatBytes(value);
  if (unit === 'count') return formatCount(value);
  return formatNumber(value);
}

function formatSignedDelta(value, unit) {
  if (!Number.isFinite(value)) return 'missing';
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${prefix}${formatMetricValue(Math.abs(value), unit)}`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return 'missing';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s`;
  return `${Math.round(value)}ms`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'missing';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(value < 1 ? 3 : 1).replace(/\.?0+$/, '') : 'missing';
}

function formatCount(value) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : 'missing';
}

function formatScore(value) {
  return Number.isFinite(value) ? formatCount(value * 100) : 'missing';
}

function scoreValue(value) {
  if (!Number.isFinite(value)) return null;
  return value <= 1 ? value * 100 : value;
}

function scoreClass(score) {
  if (!Number.isFinite(score)) return 'unknown';
  if (score < 50) return 'bad';
  if (score < 90) return 'warn';
  return 'good';
}

function statusKind(status) {
  if (status === 'good') return 'good';
  if (status === 'needs-improvement' || status === 'regression') return 'warn';
  if (status === 'poor' || status === 'failed') return 'bad';
  return 'neutral';
}

function sampleKind(value) {
  if (value === 'multi-sample') return 'good';
  if (value === 'mixed') return 'warn';
  return 'neutral';
}

function sampleLabel(value) {
  if (value === 'multi-sample') return 'Multi-sample';
  if (value === 'single-sample') return 'Single sample';
  if (value === 'mixed') return 'Mixed';
  return 'missing';
}

function labSourceLabel(lab) {
  return lab?.sourceLabel || (lab?.source === 'pagespeed-insights' ? 'PageSpeed Insights' : 'Local Lighthouse');
}

function scoreLabel(lab) {
  return lab?.source === 'pagespeed-insights' ? 'PSI score' : 'Local score';
}

function pageSpeedInsightsUrl(url) {
  const params = new URLSearchParams({ url });
  return `https://pagespeed.web.dev/analysis?${params.toString()}`;
}

function statusTitle(status = 'unknown') {
  return String(status).replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortRun(runId) {
  return runId ? String(runId).replace(/\.\d+Z$/, 'Z') : 'missing';
}

function shortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function shortDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatDateTime(value) {
  return value ? `Updated ${shortDateTime(value)}` : 'Seed data';
}

function hostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function shortRequestUrl(url) {
  if (!url) return 'unknown request';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname || '/';
    const search = parsed.search ? `${parsed.search.slice(0, 18)}${parsed.search.length > 18 ? '...' : ''}` : '';
    return `${path.length > 82 ? `...${path.slice(-82)}` : path}${search}`;
  } catch {
    const text = String(url);
    return text.length > 96 ? `...${text.slice(-96)}` : text;
  }
}

function formatLcpElement(element) {
  if (!element) return 'Not available in this representative Lighthouse report.';
  return element.nodeLabel || element.selector || element.snippet || 'Available in raw Lighthouse report.';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
