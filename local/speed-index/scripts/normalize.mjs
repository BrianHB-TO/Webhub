import path from 'node:path';
import {
  CRUX_RAW_DIR,
  FIELD_THRESHOLDS,
  LAB_REGRESSION_RULES,
  LIGHTHOUSE_RAW_DIR,
  PAGESPEED_RAW_DIR,
  SUMMARY_PATH,
  average,
  classifyMetric,
  coerceNumber,
  extractLighthouseMetrics,
  formatCollectionDate,
  metricStats,
  listJsonFiles,
  loadWatchlist,
  readJson,
  worstStatus,
  writeJson
} from './utils.mjs';

const AUDIT_BASELINE = {
  id: 'may-5-blog-audit',
  date: '2026-05-05',
  label: 'May 5 blog audit',
  sourcePath: '/Users/bnguyen/projects/homebase-perf-audit/joinhomebase-cwv-audit.md',
  scope: 'Blog only; field note is site-wide CrUX from the audit.',
  field: {
    siteWide: {
      inp: 610,
      inpStatus: 'poor',
      lcp: 2800,
      lcpStatus: 'needs-improvement'
    }
  },
  lab: {
    mobile: {
      environment: 'Lighthouse mobile, Moto G Power, Slow 4G',
      performanceScore: 0.42,
      fcp: 5600,
      lcp: 6700,
      tbt: 900,
      cls: 0
    }
  },
  searchConsole: {
    mobile: { poor: 249, needsImprovement: 1176, good: 57 },
    desktop: { poor: 0, needsImprovement: 254, good: 1228 }
  },
  annotations: [
    'Blog LCP issue centered on lazy-loaded above-the-fold images in Webflow Collection Lists.',
    'Statsig sidecar defer was rejected because experiments need synchronous pre-paint evaluation.',
    'PJS font preload, blog GSAP scoping, and IX2 cleanup were called out as likely follow-up wins.'
  ]
};

const CRUX_METRIC_MAP = {
  largest_contentful_paint: 'lcp',
  interaction_to_next_paint: 'inp',
  cumulative_layout_shift: 'cls',
  first_contentful_paint: 'fcp',
  experimental_time_to_first_byte: 'ttfb',
  largest_contentful_paint_image_time_to_first_byte: 'lcpImageTtfb',
  largest_contentful_paint_image_resource_load_delay: 'lcpImageLoadDelay',
  largest_contentful_paint_image_resource_load_duration: 'lcpImageLoadDuration',
  largest_contentful_paint_image_element_render_delay: 'lcpImageRenderDelay'
};

export async function buildPerformanceSummary() {
  const watchlist = await loadWatchlist();
  const cruxRecords = await readRawRecords(CRUX_RAW_DIR);
  const lighthouseRecords = await readRawRecords(LIGHTHOUSE_RAW_DIR);
  const pagespeedRecords = await readRawRecords(PAGESPEED_RAW_DIR);
  const dashboardLighthouseRecords = dashboardLabRecords(
    lighthouseRecords,
    watchlist,
    'lighthouse-median',
    'lighthouse-run',
    'local-lighthouse',
    'Local Lighthouse'
  );
  const dashboardPagespeedRecords = dashboardLabRecords(
    pagespeedRecords,
    watchlist,
    'pagespeed-median',
    'pagespeed-run',
    'pagespeed-insights',
    'PageSpeed Insights'
  );
  const dashboardLabRecordSet = [...dashboardLighthouseRecords, ...dashboardPagespeedRecords];
  const cruxLatest = latestCruxByTarget(cruxRecords);
  const lighthouseLatest = latestLighthouseByPage(dashboardLabRecordSet);
  const lighthouseRunsByFile = rawLighthouseRunsByFile(dashboardLabRecordSet);
  const lighthouseRunsByTarget = rawLighthouseRunsByTarget(dashboardLabRecordSet);
  const lighthouseHistory = lighthouseHistoryByPage(dashboardLabRecordSet, lighthouseRunsByFile, lighthouseRunsByTarget);
  const lighthouseBaseline = lighthouseBaselineByPage(dashboardLabRecordSet);
  const baselineRunId = getBaselineRunId(lighthouseRecords);

  const pages = watchlist.urls.map((page) => {
    const field = deviceEntries(watchlist.defaultDevices, (device) => {
      const target = cruxLatest.get(`${page.id}:${device}`);
      return normalizeCruxRecord(target);
    });
    const lab = deviceEntries(watchlist.defaultDevices, (device) => {
      const latest = lighthouseLatest.get(`${page.id}:${device}`);
      const baseline = lighthouseBaseline.get(`${page.id}:${device}`);
      const history = lighthouseHistory.get(`${page.id}:${device}`) || [];
      return normalizeLighthouseRecord(latest, baseline, history, lighthouseRunsByFile, lighthouseRunsByTarget);
    });

    return {
      id: page.id,
      path: page.path,
      url: page.url,
      label: page.label,
      group: page.group,
      priority: page.priority,
      tags: page.tags,
      field,
      lab
    };
  });

  const originField = deviceEntries(watchlist.defaultDevices, (device) => {
    const target = cruxLatest.get(`origin:${device}`);
    return normalizeCruxRecord(target);
  });

  const regressions = pages.flatMap((page) => {
    return Object.entries(page.lab).flatMap(([device, lab]) => {
      return (lab.regressions || []).map((regression) => ({
        pageId: page.id,
        label: page.label,
        path: page.path,
        device,
        ...regression
      }));
    });
  });

  const fieldGaps = pages.flatMap((page) => {
    return Object.entries(page.field)
      .filter(([, field]) => field.state !== 'ok')
      .map(([device, field]) => ({
        pageId: page.id,
        label: page.label,
        path: page.path,
        device,
        state: field.state,
        message: field.message
      }));
  });

  const latestLabRun = dashboardLabRecordSet
    .filter((record) => record.type === 'lighthouse-median')
    .sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt)))[0] || null;
  const insights = buildInsights(pages, watchlist.defaultDevices);

  const summary = {
    meta: {
      generatedAt: new Date().toISOString(),
      origin: watchlist.origin,
      watchlistCount: pages.length,
      devices: watchlist.defaultDevices,
      sources: {
        field: 'Chrome UX Report History API',
        lab: 'PageSpeed Insights median runs when collected; local Lighthouse diagnostics otherwise'
      },
      thresholds: {
        field: FIELD_THRESHOLDS,
        labRegression: LAB_REGRESSION_RULES
      },
      latestLabRunId: latestLabRun?.runId || null,
      lighthouseBaselineRunId: baselineRunId,
      latestCruxCollectionPeriod: latestCollectionPeriod(originField)
    },
    overview: {
      originField,
      fieldGapCount: fieldGaps.length,
      labRegressionCount: regressions.length,
      labRunCount: dashboardLabRecordSet.filter((record) => record.type === 'lighthouse-run').length,
      cruxRecordCount: cruxRecords.length,
      fieldGaps: fieldGaps.slice(0, 24),
      regressions: regressions.slice(0, 24)
    },
    baselines: [AUDIT_BASELINE],
    insights,
    runs: {
      lab: lighthouseRunLog(dashboardLabRecordSet, baselineRunId)
    },
    pages,
    trends: {
      origin: originField
    }
  };

  await writeJson(SUMMARY_PATH, summary);
  return summary;
}

async function readRawRecords(dirPath) {
  const files = await listJsonFiles(dirPath);
  const records = [];
  for (const filePath of files) {
    try {
      const record = await readJson(filePath);
      records.push({ ...record, _file: filePath, _fileName: path.basename(filePath) });
    } catch (error) {
      console.warn(`Skipping unreadable raw record ${filePath}: ${error.message}`);
    }
  }
  return records;
}

function latestCruxByTarget(records) {
  const latest = new Map();
  for (const record of records.filter((entry) => entry.type === 'crux-history')) {
    const key = `${record.target?.id || record.target?.type || 'unknown'}:${record.device}`;
    const existing = latest.get(key);
    if (!existing || String(record.collectedAt).localeCompare(String(existing.collectedAt)) > 0) {
      latest.set(key, record);
    }
  }
  return latest;
}

function latestLighthouseByPage(records) {
  const latest = new Map();
  for (const record of records.filter((entry) => entry.type === 'lighthouse-median')) {
    const key = `${record.pageId}:${record.device}`;
    const existing = latest.get(key);
    if (!existing || String(record.collectedAt).localeCompare(String(existing.collectedAt)) > 0) {
      latest.set(key, record);
    }
  }
  return latest;
}

function dashboardLabRecords(records, watchlist, medianType, runType, source, sourceLabel) {
  const completeRunIds = completeLabRunIds(records, watchlist, medianType);
  return records
    .filter((record) => {
      if (record.type !== medianType && record.type !== runType) {
        return true;
      }
      return completeRunIds.has(record.runId);
    })
    .map((record) => labRecord(record, medianType, runType, source, sourceLabel));
}

function labRecord(record, medianType, runType, source, sourceLabel) {
  if (record.type === medianType) {
    return { ...record, type: 'lighthouse-median', source: record.source || source, sourceLabel: record.sourceLabel || sourceLabel };
  }
  if (record.type === runType) {
    return { ...record, type: 'lighthouse-run', source: record.source || source, sourceLabel: record.sourceLabel || sourceLabel };
  }
  return record;
}

function completeLabRunIds(records, watchlist, medianType) {
  const expectedTargets = new Set(
    watchlist.urls.flatMap((page) => watchlist.defaultDevices.map((device) => `${page.id}:${device}`))
  );
  const grouped = new Map();

  for (const record of records.filter((entry) => entry.type === medianType)) {
    const run = grouped.get(record.runId) || new Set();
    const target = `${record.pageId}:${record.device}`;
    if (expectedTargets.has(target)) {
      run.add(target);
    }
    grouped.set(record.runId, run);
  }

  return new Set(
    [...grouped.entries()]
      .filter(([, targets]) => targets.size === expectedTargets.size)
      .map(([runId]) => runId)
  );
}

function lighthouseBaselineByPage(records) {
  const baselineRunId = getBaselineRunId(records);
  const baseline = new Map();
  if (!baselineRunId) {
    return baseline;
  }
  for (const record of records.filter((entry) => entry.type === 'lighthouse-median' && entry.runId === baselineRunId)) {
    baseline.set(`${record.pageId}:${record.device}`, record);
  }
  return baseline;
}

function lighthouseHistoryByPage(records, runByFileName = new Map(), runsByTarget = new Map()) {
  const history = new Map();
  for (const record of records.filter((entry) => entry.type === 'lighthouse-median')) {
    const key = `${record.pageId}:${record.device}`;
    const existing = history.get(key) || [];
    const median = enrichLighthouseMedian(record, runByFileName);
    existing.push(labHistorySnapshot(record, median, runsByTarget.get(rawRunTargetKey(record))));
    history.set(key, existing);
  }
  for (const [key, entries] of history) {
    history.set(key, entries.sort((a, b) => String(a.collectedAt).localeCompare(String(b.collectedAt))));
  }
  return history;
}

function rawLighthouseRunsByFile(records) {
  return new Map(
    records
      .filter((record) => record.type === 'lighthouse-run' && record._fileName)
      .map((record) => [record._fileName, record])
  );
}

function rawLighthouseRunsByTarget(records) {
  const grouped = new Map();
  for (const record of records.filter((entry) => entry.type === 'lighthouse-run')) {
    const key = rawRunTargetKey(record);
    const existing = grouped.get(key) || [];
    existing.push(record);
    grouped.set(key, existing);
  }
  return grouped;
}

function rawRunTargetKey(record) {
  return `${record.runId}:${record.pageId}:${record.device}`;
}

function labHistorySnapshot(record, median, rawRuns = []) {
  const aggregate = labAggregateForRecord(record, rawRuns);
  return {
    runId: record.runId,
    collectedAt: record.collectedAt,
    source: record.source || 'local-lighthouse',
    sourceLabel: record.sourceLabel || 'Local Lighthouse',
    successCount: record.successCount,
    failureCount: record.failureCount,
    runsRequested: record.runsRequested,
    sampleQuality: aggregate ? 'multi-sample' : 'single-sample',
    fcp: coerceNumber(median?.fcp),
    lcp: coerceNumber(median?.lcp),
    speedIndex: coerceNumber(median?.speedIndex),
    tbt: coerceNumber(median?.tbt),
    cls: coerceNumber(median?.cls),
    ttfb: coerceNumber(median?.ttfb),
    performanceScore: coerceNumber(median?.performanceScore),
    totalBytes: coerceNumber(median?.totalBytes),
    requestCount: coerceNumber(median?.requestCount),
    jsBytes: coerceNumber(median?.jsBytes),
    imageBytes: coerceNumber(median?.imageBytes),
    thirdPartyBytes: coerceNumber(median?.thirdPartyBytes),
    resourceSummary: median?.resourceSummary || [],
    domainSummary: (median?.domainSummary || []).slice(0, 12),
    opportunities: (median?.opportunities || []).slice(0, 6),
    topRequests: (median?.topRequests || []).slice(0, 12),
    bootupScripts: (median?.bootupScripts || []).slice(0, 8),
    average: aggregate?.average || null,
    stats: aggregate?.stats || null
  };
}

function labAggregateForRecord(record, rawRuns = []) {
  if (record.average && record.stats && (coerceNumber(record.successCount) || 0) > 1) {
    return {
      average: record.average,
      stats: record.stats
    };
  }

  const successful = rawRuns.filter((run) => run.ok && run.extracted);
  if (successful.length <= 1) {
    return null;
  }

  const metricKeys = labAggregateMetricKeys();
  return {
    average: Object.fromEntries(
      metricKeys.map((key) => [key, average(successful.map((run) => coerceNumber(run.extracted?.[key])))])
    ),
    stats: Object.fromEntries(
      metricKeys.map((key) => [key, metricStats(successful.map((run) => coerceNumber(run.extracted?.[key])))])
    )
  };
}

function labAggregateMetricKeys() {
  return [
    'performanceScore',
    'fcp',
    'lcp',
    'speedIndex',
    'tbt',
    'cls',
    'ttfb',
    'totalBytes',
    'requestCount',
    'jsBytes',
    'imageBytes',
    'thirdPartyBytes'
  ];
}

function lighthouseRunLog(records, baselineRunId) {
  const grouped = new Map();
  for (const record of records.filter((entry) => entry.type === 'lighthouse-median')) {
    const current = grouped.get(record.runId) || {
      runId: record.runId,
      collectedAt: record.collectedAt,
      source: record.source || 'local-lighthouse',
      sourceLabel: record.sourceLabel || 'Local Lighthouse',
      pages: new Set(),
      devices: new Set(),
      medianCount: 0,
      multiSampleMedians: 0,
      singleSampleMedians: 0,
      successCount: 0,
      failureCount: 0,
      runsRequested: 0
    };
    current.collectedAt = minString(current.collectedAt, record.collectedAt);
    current.pages.add(record.pageId);
    current.devices.add(record.device);
    current.medianCount += 1;
    if ((coerceNumber(record.successCount) || 0) > 1) {
      current.multiSampleMedians += 1;
    } else {
      current.singleSampleMedians += 1;
    }
    current.successCount += coerceNumber(record.successCount) || 0;
    current.failureCount += coerceNumber(record.failureCount) || 0;
    current.runsRequested += coerceNumber(record.runsRequested) || 0;
    grouped.set(record.runId, current);
  }
  return [...grouped.values()]
    .map((run) => ({
      runId: run.runId,
      collectedAt: run.collectedAt,
      source: run.source,
      sourceLabel: run.sourceLabel,
      baseline: run.runId === baselineRunId,
      pageCount: run.pages.size,
      devices: [...run.devices].sort(),
      medianCount: run.medianCount,
      multiSampleMedians: run.multiSampleMedians,
      singleSampleMedians: run.singleSampleMedians,
      sampleQuality: runSampleQuality(run),
      averageRunsPerMedian: run.medianCount ? run.successCount / run.medianCount : null,
      successCount: run.successCount,
      failureCount: run.failureCount,
      runsRequested: run.runsRequested
    }))
    .sort((a, b) => String(a.collectedAt).localeCompare(String(b.collectedAt)));
}

function runSampleQuality(run) {
  if (run.medianCount && run.multiSampleMedians === run.medianCount) {
    return 'multi-sample';
  }
  if (run.multiSampleMedians && run.singleSampleMedians) {
    return 'mixed';
  }
  if (run.multiSampleMedians) {
    return 'multi-sample';
  }
  return 'single-sample';
}

function minString(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left).localeCompare(String(right)) <= 0 ? left : right;
}

function getBaselineRunId(records) {
  return records
    .filter((record) => record.type === 'lighthouse-baseline')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0]?.runId || null;
}

function deviceEntries(devices, build) {
  return Object.fromEntries(devices.map((device) => [device, build(device)]));
}

function normalizeCruxRecord(record) {
  if (!record) {
    return {
      state: 'not-collected',
      status: 'unknown',
      message: 'insufficient CrUX data',
      latest: {},
      trend: []
    };
  }
  if (!record.ok) {
    return {
      state: 'insufficient-data',
      status: 'unknown',
      message: cruxErrorMessage(record),
      latest: {},
      trend: []
    };
  }

  const responseRecord = record.response?.record;
  const periods = responseRecord?.collectionPeriods || [];
  const metrics = responseRecord?.metrics || {};
  const latestIndex = Math.max(0, periods.length - 1);
  const latest = {};
  const trendRows = periods.map((period, index) => ({
    startDate: formatCollectionDate(period.firstDate),
    endDate: formatCollectionDate(period.lastDate)
  }));

  for (const [apiKey, summaryKey] of Object.entries(CRUX_METRIC_MAP)) {
    const series = metrics[apiKey]?.percentilesTimeseries?.p75s || [];
    const latestValue = coerceNumber(series[latestIndex]);
    latest[summaryKey] = latestValue;
    for (let index = 0; index < trendRows.length; index += 1) {
      trendRows[index][summaryKey] = coerceNumber(series[index]);
    }
  }

  latest.lcpResourceType = latestFraction(metrics.largest_contentful_paint_resource_type, latestIndex);
  const cwvStatus = worstStatus([
    classifyMetric('lcp', latest.lcp),
    classifyMetric('inp', latest.inp),
    classifyMetric('cls', latest.cls)
  ]);

  return {
    state: 'ok',
    status: cwvStatus,
    message: null,
    collectedAt: record.collectedAt,
    collectionPeriod: {
      startDate: trendRows[latestIndex]?.startDate || null,
      endDate: trendRows[latestIndex]?.endDate || null
    },
    latest,
    metricStatus: {
      lcp: classifyMetric('lcp', latest.lcp),
      inp: classifyMetric('inp', latest.inp),
      cls: classifyMetric('cls', latest.cls)
    },
    trend: trendRows
  };
}

function latestFraction(metric, index) {
  const fractions = metric?.fractionTimeseries;
  if (!fractions) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(fractions).map(([key, values]) => [key, coerceNumber(values?.[index])])
  );
}

function cruxErrorMessage(record) {
  if (record.status === 404) {
    return 'insufficient CrUX data';
  }
  return record.error?.message || record.response?.error?.message || 'CrUX request failed';
}

function normalizeLighthouseRecord(latestRecord, baselineRecord, history = [], runByFileName = new Map(), runsByTarget = new Map()) {
  if (!latestRecord) {
    return {
      state: 'not-collected',
      status: 'unknown',
      message: 'no local Lighthouse run',
      latest: null,
      baseline: baselineRecord?.median || null,
      history,
      regressions: []
    };
  }

  const latest = enrichLighthouseMedian(latestRecord, runByFileName);
  const baseline = baselineRecord ? enrichLighthouseMedian(baselineRecord, runByFileName) : null;
  const regressions = baseline ? compareLabMetrics(latest, baseline) : [];
  const status = labStatus(latest, regressions);
  const latestSnapshot = labHistorySnapshot(latestRecord, latest, runsByTarget.get(rawRunTargetKey(latestRecord)));
  const previous = previousSnapshot(history, latestRecord.runId);
  const comparison = previous ? {
    previous,
    latest: latestSnapshot,
    delta: compareLabSnapshots(latestSnapshot, previous),
    drivers: changeDrivers(latestSnapshot, previous)
  } : null;

  return {
    state: latestRecord.successCount ? 'ok' : 'failed',
    status,
    message: latestRecord.successCount ? null : 'all Lighthouse runs failed',
    runId: latestRecord.runId,
    collectedAt: latestRecord.collectedAt,
    source: latestRecord.source || 'local-lighthouse',
    sourceLabel: latestRecord.sourceLabel || 'Local Lighthouse',
    successCount: latestRecord.successCount,
    failureCount: latestRecord.failureCount,
    runsRequested: latestRecord.runsRequested,
    sampleQuality: latestSnapshot.sampleQuality,
    average: latestSnapshot.average,
    stats: latestSnapshot.stats,
    latest,
    baseline,
    history,
    comparison,
    regressions
  };
}

function previousSnapshot(history, latestRunId) {
  const latestIndex = history.findIndex((entry) => entry.runId === latestRunId);
  if (latestIndex > 0) {
    return history[latestIndex - 1];
  }
  return history.length > 1 ? history.at(-2) : null;
}

function compareLabSnapshots(latest, previous) {
  const keys = [
    'performanceScore',
    'fcp',
    'lcp',
    'speedIndex',
    'tbt',
    'cls',
    'ttfb',
    'totalBytes',
    'requestCount',
    'jsBytes',
    'imageBytes',
    'thirdPartyBytes'
  ];
  return Object.fromEntries(keys.map((key) => {
    const latestValue = coerceNumber(latest?.[key]);
    const previousValue = coerceNumber(previous?.[key]);
    if (!Number.isFinite(latestValue) || !Number.isFinite(previousValue)) {
      return [key, { latest: latestValue, previous: previousValue, delta: null, ratio: null }];
    }
    const delta = latestValue - previousValue;
    return [key, {
      latest: latestValue,
      previous: previousValue,
      delta,
      ratio: previousValue ? delta / previousValue : null
    }];
  }));
}

function changeDrivers(latest, previous) {
  const delta = compareLabSnapshots(latest, previous);
  const rules = [
    { key: 'lcp', label: 'LCP', unit: 'ms', threshold: 300, worse: 1 },
    { key: 'fcp', label: 'FCP', unit: 'ms', threshold: 300, worse: 1 },
    { key: 'speedIndex', label: 'Speed Index', unit: 'ms', threshold: 300, worse: 1 },
    { key: 'tbt', label: 'TBT', unit: 'ms', threshold: 100, worse: 1 },
    { key: 'ttfb', label: 'TTFB', unit: 'ms', threshold: 100, worse: 1 },
    { key: 'totalBytes', label: 'Total bytes', unit: 'bytes', threshold: 250 * 1024, worse: 1 },
    { key: 'requestCount', label: 'Requests', unit: 'count', threshold: 10, worse: 1 },
    { key: 'jsBytes', label: 'JS bytes', unit: 'bytes', threshold: 150 * 1024, worse: 1 },
    { key: 'imageBytes', label: 'Image bytes', unit: 'bytes', threshold: 250 * 1024, worse: 1 },
    { key: 'thirdPartyBytes', label: 'Third-party bytes', unit: 'bytes', threshold: 150 * 1024, worse: 1 },
    { key: 'performanceScore', label: 'Score', unit: 'score', threshold: 0.05, worse: -1 },
    { key: 'cls', label: 'CLS', unit: 'score', threshold: 0.02, worse: 1 }
  ];
  const metricDrivers = rules.flatMap((rule) => {
    const item = delta[rule.key];
    if (!item || !Number.isFinite(item.delta) || Math.abs(item.delta) < rule.threshold) {
      return [];
    }
    const worse = rule.worse === -1 ? item.delta < 0 : item.delta > 0;
    return [{
      type: worse ? 'worse' : 'improved',
      metric: rule.key,
      label: rule.label,
      unit: rule.unit,
      previous: item.previous,
      latest: item.latest,
      delta: item.delta,
      ratio: item.ratio
    }];
  });

  return [
    ...metricDrivers,
    ...domainDrivers(latest, previous),
    ...resourceDrivers(latest, previous)
  ]
    .sort((a, b) => driverMagnitude(b) - driverMagnitude(a))
    .slice(0, 12);
}

function domainDrivers(latest, previous) {
  const previousHosts = new Map((previous.domainSummary || []).map((item) => [item.host, item]));
  return (latest.domainSummary || []).flatMap((item) => {
    const before = previousHosts.get(item.host);
    const delta = (coerceNumber(item.transferSize) || 0) - (coerceNumber(before?.transferSize) || 0);
    if (Math.abs(delta) < 150 * 1024) {
      return [];
    }
    return [{
      type: delta > 0 ? 'worse' : 'improved',
      metric: 'hostBytes',
      label: item.host || 'Unknown host',
      unit: 'bytes',
      previous: coerceNumber(before?.transferSize) || 0,
      latest: coerceNumber(item.transferSize) || 0,
      delta,
      ratio: before?.transferSize ? delta / before.transferSize : null
    }];
  });
}

function resourceDrivers(latest, previous) {
  const previousResources = new Map((previous.resourceSummary || []).map((item) => [item.resourceType, item]));
  return (latest.resourceSummary || []).flatMap((item) => {
    const before = previousResources.get(item.resourceType);
    const delta = (coerceNumber(item.transferSize) || 0) - (coerceNumber(before?.transferSize) || 0);
    if (Math.abs(delta) < 150 * 1024) {
      return [];
    }
    return [{
      type: delta > 0 ? 'worse' : 'improved',
      metric: 'resourceBytes',
      label: `${item.resourceType || 'resource'} resources`,
      unit: 'bytes',
      previous: coerceNumber(before?.transferSize) || 0,
      latest: coerceNumber(item.transferSize) || 0,
      delta,
      ratio: before?.transferSize ? delta / before.transferSize : null
    }];
  });
}

function driverMagnitude(item) {
  if (item.unit === 'bytes') {
    return Math.abs(item.delta) / 1024;
  }
  if (item.unit === 'score') {
    return Math.abs(item.delta) * 1000;
  }
  return Math.abs(item.delta);
}

function enrichLighthouseMedian(record, runByFileName) {
  const median = record?.median || {};
  const rawRun = runByFileName.get(record?.representativeRunFile);
  if (!rawRun?.lhr) {
    return median;
  }
  const extracted = extractLighthouseMetrics(rawRun.lhr);
  return {
    ...median,
    topRequests: median.topRequests?.length ? median.topRequests : extracted.topRequests,
    domainSummary: median.domainSummary?.length ? median.domainSummary : extracted.domainSummary,
    opportunities: median.opportunities?.length ? median.opportunities : extracted.opportunities,
    mainThreadBreakdown: median.mainThreadBreakdown?.length ? median.mainThreadBreakdown : extracted.mainThreadBreakdown,
    bootupScripts: median.bootupScripts?.length ? median.bootupScripts : extracted.bootupScripts,
    thirdPartyBytes: median.thirdPartyBytes || extracted.thirdPartyBytes,
    thirdPartySummary: median.thirdPartySummary?.length ? median.thirdPartySummary : extracted.thirdPartySummary
  };
}

function buildInsights(pages, devices) {
  const rows = labRows(pages, devices);
  return {
    fixQueue: buildFixQueue(rows),
    hostRollups: buildHostRollups(rows),
    resourceRollups: buildResourceRollups(rows),
    opportunityRollups: buildOpportunityRollups(rows),
    scriptRollups: buildScriptRollups(rows),
    templateRollups: buildTemplateRollups(rows)
  };
}

function labRows(pages, devices) {
  return pages.flatMap((page) => {
    return devices.map((device) => {
      const lab = page.lab?.[device] || {};
      return {
        page,
        device,
        lab,
        latest: lab.latest || {}
      };
    });
  }).filter((row) => row.lab.state === 'ok' && row.latest);
}

function buildFixQueue(rows) {
  const fixes = [
    aggregateFix({
      id: 'lcp-delivery',
      category: 'LCP',
      title: 'Fix above-the-fold LCP delivery',
      recommendedAction: 'Prioritize the visible LCP element, remove lazy loading above the fold, add preload/fetchpriority where appropriate, and defer competing below-fold work.',
      rows: rows.filter((row) => metric(row, 'lcp') > 4000),
      score: (row) => businessWeight(row.page) + clamp(((metric(row, 'lcp') - 4000) / 1000) * 14, 0, 90)
    }),
    aggregateFix({
      id: 'js-main-thread',
      category: 'JS/TBT',
      title: 'Reduce script and main-thread pressure',
      recommendedAction: 'Defer non-critical scripts, trim Webflow/shared chunks, scope animation libraries, and delay marketing/vendor work until after the initial render.',
      rows: rows.filter((row) => metric(row, 'tbt') > 600 || bootupTotal(row) > 1500),
      score: (row) => businessWeight(row.page) + clamp((metric(row, 'tbt') / 100) * 5, 0, 90) + clamp((bootupTotal(row) / 1000) * 8, 0, 60)
    }),
    aggregateFix({
      id: 'page-weight',
      category: 'Weight',
      title: 'Cut oversized page payloads',
      recommendedAction: 'Reduce large media, trim shared bundles, remove unused resources, and keep high-intent/template pages below the current heavy-page outliers.',
      rows: rows.filter((row) => metric(row, 'totalBytes') > 5 * 1024 * 1024),
      score: (row) => businessWeight(row.page) + clamp(((metric(row, 'totalBytes') - 5 * 1024 * 1024) / (1024 * 1024)) * 14, 0, 90)
    }),
    aggregateFix({
      id: 'request-count',
      category: 'Requests',
      title: 'Consolidate high request-count pages',
      recommendedAction: 'Remove low-value third-party calls, combine duplicate tag destinations, and reduce template-level asset fanout.',
      rows: rows.filter((row) => metric(row, 'requestCount') > 100),
      score: (row) => businessWeight(row.page) + clamp(((metric(row, 'requestCount') - 100) / 10) * 8, 0, 80)
    }),
    aggregateFix({
      id: 'image-delivery',
      category: 'Images',
      title: 'Optimize image and animated media delivery',
      recommendedAction: 'Resize responsive images, convert legacy/animated assets where possible, lazy-load below-fold media, and prioritize the true hero asset only.',
      rows: rows.filter((row) => imageBytes(row) > 2 * 1024 * 1024 || opportunityWaste(row, ['uses-responsive-images', 'modern-image-formats', 'efficient-animated-content'], 'wastedBytes') > 250 * 1024),
      score: (row) => businessWeight(row.page) + clamp((imageBytes(row) / (1024 * 1024)) * 16, 0, 80) + clamp((opportunityWaste(row, ['uses-responsive-images', 'modern-image-formats', 'efficient-animated-content'], 'wastedBytes') / (1024 * 1024)) * 20, 0, 60)
    }),
    aggregateFix({
      id: 'third-party',
      category: 'Third-party',
      title: 'Govern third-party and tag-manager load',
      recommendedAction: 'Audit GTM destinations and vendor tags, delay non-critical vendors, and remove duplicate or low-value destinations from shared templates.',
      rows: rows.filter((row) => externalTransfer(row) > 1.5 * 1024 * 1024),
      score: (row) => businessWeight(row.page) + clamp((externalTransfer(row) / (1024 * 1024)) * 18, 0, 90)
    }),
    aggregateFix({
      id: 'unused-js',
      category: 'Unused JS',
      title: 'Remove or delay unused JavaScript',
      recommendedAction: 'Use the Lighthouse unused-JS evidence to trim GTM destinations, shared Webflow chunks, chat/recaptcha, and libraries that do not affect initial render.',
      rows: rows.filter((row) => opportunityWaste(row, ['unused-javascript'], 'wastedBytes') > 200 * 1024 || scriptBytes(row) > 2 * 1024 * 1024),
      score: (row) => businessWeight(row.page) + clamp((opportunityWaste(row, ['unused-javascript'], 'wastedBytes') / (1024 * 1024)) * 28, 0, 90) + clamp((scriptBytes(row) / (1024 * 1024)) * 12, 0, 60)
    }),
    aggregateFix({
      id: 'render-blocking',
      category: 'Render blocking',
      title: 'Reduce render-blocking CSS and JS',
      recommendedAction: 'Inline critical CSS, defer non-critical shared CSS/JS, and remove unused shared resources from templates that do not need them.',
      rows: rows.filter((row) => opportunityWaste(row, ['render-blocking-resources'], 'wastedMs') > 250),
      score: (row) => businessWeight(row.page) + clamp((opportunityWaste(row, ['render-blocking-resources'], 'wastedMs') / 100) * 6, 0, 90)
    })
  ];

  return fixes
    .filter((fix) => fix && fix.affectedRows)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 8);
}

function aggregateFix({ id, category, title, recommendedAction, rows, score }) {
  const affectedRows = rows
    .map((row) => ({
      ...pageRef(row),
      rowImpact: Math.round(score(row))
    }))
    .sort((a, b) => b.rowImpact - a.rowImpact);
  if (!affectedRows.length) {
    return null;
  }

  const pageIds = unique(affectedRows.map((row) => row.pageId));
  const devices = unique(affectedRows.map((row) => row.device));
  const groups = unique(affectedRows.map((row) => row.group));
  const rawImpact = rows.reduce((sum, row) => sum + score(row), 0);
  const leverage = pageIds.length * 8 + groups.length * 6 + (devices.length > 1 ? 18 : 0);
  const metrics = fixMetrics(rows);

  return {
    id,
    category,
    title,
    recommendedAction,
    impact: Math.round(rawImpact + leverage),
    confidence: rows.every((row) => (row.lab.successCount || 0) >= 5) ? 'high' : 'medium',
    affectedPages: pageIds.length,
    affectedRows: affectedRows.length,
    affected: affectedRows,
    devices,
    groups,
    pageIds,
    metrics,
    topEvidence: affectedRows.slice(0, 6),
    topHosts: topHostsForRows(rows).slice(0, 5),
    topOpportunities: topOpportunitiesForRows(rows).slice(0, 5)
  };
}

function fixMetrics(rows) {
  return {
    maxLcp: max(rows, (row) => metric(row, 'lcp')),
    maxTbt: max(rows, (row) => metric(row, 'tbt')),
    totalBytes: sum(rows, (row) => metric(row, 'totalBytes')),
    totalRequests: sum(rows, (row) => metric(row, 'requestCount')),
    imageBytes: sum(rows, imageBytes),
    scriptBytes: sum(rows, scriptBytes),
    thirdPartyBytes: sum(rows, thirdPartyBytes),
    wastedBytes: sum(rows, (row) => opportunityWaste(row, ['unused-javascript', 'unused-css-rules', 'uses-responsive-images', 'modern-image-formats', 'efficient-animated-content'], 'wastedBytes')),
    wastedMs: sum(rows, (row) => opportunityWaste(row, ['render-blocking-resources'], 'wastedMs')),
    scriptBootupMs: sum(rows, bootupTotal)
  };
}

function buildHostRollups(rows) {
  const rollups = new Map();
  for (const row of rows) {
    for (const host of row.latest.domainSummary || []) {
      const key = host.host || 'unknown';
      const current = rollups.get(key) || baseRollup({ id: key, label: key });
      current.transferSize += coerceNumber(host.transferSize) || 0;
      current.resourceSize += coerceNumber(host.resourceSize) || 0;
      current.requestCount += coerceNumber(host.requestCount) || 0;
      addCoverage(current, row);
      addTypes(current.types, host.types);
      current.examples.push({
        ...pageRef(row),
        transferSize: coerceNumber(host.transferSize) || 0,
        requestCount: coerceNumber(host.requestCount) || 0
      });
      rollups.set(key, current);
    }
  }
  return finalizeRollups([...rollups.values()], (item) => item.transferSize, 24);
}

function buildResourceRollups(rows) {
  const rollups = new Map();
  for (const row of rows) {
    for (const resource of row.latest.resourceSummary || []) {
      const type = resource.resourceType || 'resource';
      const key = `${row.device}:${row.page.group}:${type}`;
      const current = rollups.get(key) || baseRollup({
        id: key,
        label: type,
        device: row.device,
        group: row.page.group,
        resourceType: type
      });
      current.transferSize += coerceNumber(resource.transferSize) || 0;
      current.requestCount += coerceNumber(resource.requestCount) || 0;
      addCoverage(current, row);
      current.examples.push({
        ...pageRef(row),
        transferSize: coerceNumber(resource.transferSize) || 0,
        requestCount: coerceNumber(resource.requestCount) || 0
      });
      rollups.set(key, current);
    }
  }
  return finalizeRollups([...rollups.values()], (item) => item.transferSize, 48);
}

function buildOpportunityRollups(rows) {
  const rollups = new Map();
  for (const row of rows) {
    for (const opportunity of row.latest.opportunities || []) {
      const key = opportunity.id || opportunity.label || 'opportunity';
      const current = rollups.get(key) || baseRollup({
        id: key,
        label: opportunity.title || opportunity.label || key,
        category: opportunity.label || key
      });
      const totalBytes = sum(opportunity.items || [], (item) => coerceNumber(item.totalBytes) || 0);
      const wastedBytes = sum(opportunity.items || [], (item) => coerceNumber(item.wastedBytes) || 0);
      const wastedMs = sum(opportunity.items || [], (item) => coerceNumber(item.wastedMs) || 0);
      current.transferSize += totalBytes;
      current.wastedBytes += wastedBytes;
      current.wastedMs += wastedMs;
      addCoverage(current, row);
      current.examples.push({
        ...pageRef(row),
        totalBytes,
        wastedBytes,
        wastedMs
      });
      current.items.push(...(opportunity.items || []).slice(0, 3).map((item) => ({
        url: item.url,
        host: safeHost(item.url),
        totalBytes: coerceNumber(item.totalBytes) || 0,
        wastedBytes: coerceNumber(item.wastedBytes) || 0,
        wastedMs: coerceNumber(item.wastedMs) || 0
      })));
      rollups.set(key, current);
    }
  }
  return finalizeRollups([...rollups.values()], (item) => item.wastedBytes + item.wastedMs * 1024 + item.transferSize * 0.05, 24);
}

function buildScriptRollups(rows) {
  const rollups = new Map();
  for (const row of rows) {
    for (const script of row.latest.bootupScripts || []) {
      const key = script.url || script.host || 'unknown-script';
      const current = rollups.get(key) || baseRollup({
        id: key,
        label: shortUrl(script.url || script.host || 'unknown script'),
        url: script.url || null,
        host: script.host || safeHost(script.url)
      });
      current.total += coerceNumber(script.total) || 0;
      current.scripting += coerceNumber(script.scripting) || 0;
      current.scriptParseCompile += coerceNumber(script.scriptParseCompile) || 0;
      addCoverage(current, row);
      current.examples.push({
        ...pageRef(row),
        total: coerceNumber(script.total) || 0,
        scripting: coerceNumber(script.scripting) || 0,
        scriptParseCompile: coerceNumber(script.scriptParseCompile) || 0
      });
      rollups.set(key, current);
    }
  }
  return finalizeRollups([...rollups.values()], (item) => item.total, 24);
}

function buildTemplateRollups(rows) {
  const rollups = new Map();
  for (const row of rows) {
    const key = `${row.device}:${row.page.group}`;
    const current = rollups.get(key) || baseRollup({
      id: key,
      label: row.page.group,
      device: row.device,
      group: row.page.group
    });
    current.transferSize += metric(row, 'totalBytes');
    current.requestCount += metric(row, 'requestCount');
    current.lcp += metric(row, 'lcp');
    current.tbt += metric(row, 'tbt');
    current.score += Number.isFinite(row.latest.performanceScore) ? row.latest.performanceScore * 100 : 0;
    addCoverage(current, row);
    current.examples.push(pageRef(row));
    rollups.set(key, current);
  }
  return [...rollups.values()]
    .map((item) => {
      const rowCount = Math.max(1, item.examples.length);
      return finalizeRollup({
        ...item,
        avgLcp: item.lcp / rowCount,
        avgTbt: item.tbt / rowCount,
        avgScore: item.score / rowCount
      });
    })
    .sort((a, b) => b.transferSize - a.transferSize);
}

function baseRollup(seed) {
  return {
    ...seed,
    transferSize: 0,
    resourceSize: 0,
    requestCount: 0,
    wastedBytes: 0,
    wastedMs: 0,
    total: 0,
    scripting: 0,
    scriptParseCompile: 0,
    lcp: 0,
    tbt: 0,
    score: 0,
    types: {},
    pageIds: new Set(),
    devices: new Set(),
    groups: new Set(),
    examples: [],
    items: []
  };
}

function finalizeRollups(items, score, limit) {
  return items
    .map(finalizeRollup)
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

function finalizeRollup(item) {
  const examples = item.examples
    .sort((a, b) => (b.transferSize || b.total || b.wastedBytes || b.rowImpact || b.lcp || 0) - (a.transferSize || a.total || a.wastedBytes || a.rowImpact || a.lcp || 0))
    .slice(0, 8);
  return {
    ...item,
    pageIds: [...item.pageIds],
    devices: [...item.devices],
    groups: [...item.groups],
    affectedPages: item.pageIds.size,
    affectedRows: item.examples.length,
    examples,
    items: item.items
      .sort((a, b) => (b.wastedBytes || b.totalBytes || b.wastedMs || 0) - (a.wastedBytes || a.totalBytes || a.wastedMs || 0))
      .slice(0, 12)
  };
}

function addCoverage(item, row) {
  item.pageIds.add(row.page.id);
  item.devices.add(row.device);
  item.groups.add(row.page.group);
}

function addTypes(target, types = {}) {
  for (const [type, count] of Object.entries(types || {})) {
    target[type] = (target[type] || 0) + (coerceNumber(count) || 0);
  }
}

function pageRef(row) {
  return {
    pageId: row.page.id,
    label: row.page.label,
    path: row.page.path,
    group: row.page.group,
    priority: row.page.priority,
    device: row.device,
    score: row.latest.performanceScore,
    fcp: metric(row, 'fcp'),
    lcp: metric(row, 'lcp'),
    tbt: metric(row, 'tbt'),
    totalBytes: metric(row, 'totalBytes'),
    requestCount: metric(row, 'requestCount')
  };
}

function topHostsForRows(rows) {
  const hosts = new Map();
  for (const row of rows) {
    for (const host of row.latest.domainSummary || []) {
      const key = host.host || 'unknown';
      const current = hosts.get(key) || { host: key, transferSize: 0, requestCount: 0, pageIds: new Set() };
      current.transferSize += coerceNumber(host.transferSize) || 0;
      current.requestCount += coerceNumber(host.requestCount) || 0;
      current.pageIds.add(row.page.id);
      hosts.set(key, current);
    }
  }
  return [...hosts.values()]
    .map((item) => ({ ...item, affectedPages: item.pageIds.size, pageIds: [...item.pageIds] }))
    .sort((a, b) => b.transferSize - a.transferSize);
}

function topOpportunitiesForRows(rows) {
  const opportunities = new Map();
  for (const row of rows) {
    for (const opportunity of row.latest.opportunities || []) {
      const key = opportunity.id || opportunity.label || 'opportunity';
      const current = opportunities.get(key) || { id: key, label: opportunity.title || opportunity.label || key, wastedBytes: 0, wastedMs: 0, pageIds: new Set() };
      current.wastedBytes += sum(opportunity.items || [], (item) => coerceNumber(item.wastedBytes) || 0);
      current.wastedMs += sum(opportunity.items || [], (item) => coerceNumber(item.wastedMs) || 0);
      current.pageIds.add(row.page.id);
      opportunities.set(key, current);
    }
  }
  return [...opportunities.values()]
    .map((item) => ({ ...item, affectedPages: item.pageIds.size, pageIds: [...item.pageIds] }))
    .sort((a, b) => (b.wastedBytes + b.wastedMs * 1024) - (a.wastedBytes + a.wastedMs * 1024));
}

function metric(row, key) {
  return coerceNumber(row.latest?.[key]) || 0;
}

function imageBytes(row) {
  return metric(row, 'imageBytes') || resourceSize(row.latest, 'image');
}

function scriptBytes(row) {
  return metric(row, 'jsBytes') || resourceSize(row.latest, 'script');
}

function thirdPartyBytes(row) {
  return metric(row, 'thirdPartyBytes') || resourceSize(row.latest, 'third-party');
}

function resourceSize(latest, type) {
  return latest?.resourceSummary?.find((item) => item.resourceType === type)?.transferSize || 0;
}

function externalTransfer(row) {
  return (row.latest.domainSummary || [])
    .filter((item) => !isHomebaseHost(item.host))
    .reduce((sum, item) => sum + (coerceNumber(item.transferSize) || 0), 0);
}

function isHomebaseHost(host = '') {
  return /(^|\.)joinhomebase\.com$/.test(host) || /website-files\.com$/.test(host);
}

function bootupTotal(row) {
  return sum(row.latest.bootupScripts || [], (script) => coerceNumber(script.total) || 0);
}

function opportunityWaste(row, ids, field) {
  const allowed = new Set(ids);
  return sum((row.latest.opportunities || []).filter((opportunity) => allowed.has(opportunity.id)), (opportunity) => {
    return sum(opportunity.items || [], (item) => coerceNumber(item[field]) || 0);
  });
}

function businessWeight(page) {
  let weight = ({ 1: 70, 2: 45, 3: 20 }[page.priority] || 10);
  if (page.group === 'Payroll') weight += 15;
  if (page.path === '/pricing' || (page.tags || []).includes('conversion')) weight += 10;
  if (page.group === 'Blog posts') weight += 20;
  if ((page.tags || []).includes('category') || (page.tags || []).includes('author')) weight -= 20;
  return Math.max(10, weight);
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function shortUrl(url) {
  if (!url) {
    return 'unknown';
  }
  try {
    const parsed = new URL(url);
    const value = parsed.pathname || parsed.hostname;
    return value.length > 90 ? `...${value.slice(-90)}` : value;
  } catch {
    return String(url).length > 90 ? `...${String(url).slice(-90)}` : String(url);
  }
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

function sum(items, pick) {
  return items.reduce((total, item) => total + (pick(item) || 0), 0);
}

function max(items, pick) {
  return Math.max(0, ...items.map((item) => pick(item) || 0));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function compareLabMetrics(latest, baseline) {
  return Object.entries(LAB_REGRESSION_RULES).flatMap(([key, rule]) => {
    const latestValue = coerceNumber(latest[key]);
    const baselineValue = coerceNumber(baseline[key]);
    if (!latestValue || !baselineValue) {
      return [];
    }
    const delta = latestValue - baselineValue;
    const ratio = delta / baselineValue;
    if (delta > rule.minDelta && ratio > rule.minRatio) {
      return [{
        metric: key,
        label: rule.label,
        latest: latestValue,
        baseline: baselineValue,
        delta,
        ratio,
        unit: rule.unit
      }];
    }
    return [];
  });
}

function labStatus(latest, regressions) {
  if (regressions.length) {
    return 'regression';
  }
  const lcpStatus = classifyMetric('lcp', latest.lcp);
  const clsStatus = classifyMetric('cls', latest.cls);
  const tbtStatus = latest.tbt === null || latest.tbt === undefined
    ? 'unknown'
    : latest.tbt <= 200
      ? 'good'
      : latest.tbt <= 600
        ? 'needs-improvement'
        : 'poor';
  return worstStatus([lcpStatus, clsStatus, tbtStatus]);
}

function latestCollectionPeriod(originField) {
  const periods = Object.values(originField)
    .map((entry) => entry.collectionPeriod?.endDate)
    .filter(Boolean)
    .sort();
  return periods.at(-1) || null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = await buildPerformanceSummary();
  console.log(`Wrote ${SUMMARY_PATH}`);
  console.log(`Pages: ${summary.pages.length}, CrUX raw records: ${summary.overview.cruxRecordCount}, Lighthouse runs: ${summary.overview.labRunCount}`);
}
