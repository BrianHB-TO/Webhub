import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'watchlist.json');
export const CRUX_RAW_DIR = path.join(PROJECT_ROOT, 'data', 'raw', 'crux');
export const LIGHTHOUSE_RAW_DIR = path.join(PROJECT_ROOT, 'data', 'raw', 'lighthouse');
export const PAGESPEED_RAW_DIR = path.join(PROJECT_ROOT, 'data', 'raw', 'pagespeed');
export const SUMMARY_PATH = process.env.PERF_SUMMARY_PATH || process.env.SPEED_INDEX_SUMMARY_PATH
  ? path.resolve(PROJECT_ROOT, process.env.PERF_SUMMARY_PATH || process.env.SPEED_INDEX_SUMMARY_PATH)
  : path.join(PROJECT_ROOT, 'static', 'data', 'performance-summary.json');

export const DEVICE_TO_CRUX_FORM_FACTOR = {
  mobile: 'PHONE',
  desktop: 'DESKTOP'
};

export const CRUX_METRICS = [
  'largest_contentful_paint',
  'interaction_to_next_paint',
  'cumulative_layout_shift',
  'first_contentful_paint',
  'experimental_time_to_first_byte',
  'largest_contentful_paint_resource_type',
  'largest_contentful_paint_image_time_to_first_byte',
  'largest_contentful_paint_image_resource_load_delay',
  'largest_contentful_paint_image_resource_load_duration',
  'largest_contentful_paint_image_element_render_delay'
];

export const FIELD_THRESHOLDS = {
  lcp: { good: 2500, needsImprovement: 4000, unit: 'ms' },
  inp: { good: 200, needsImprovement: 500, unit: 'ms' },
  cls: { good: 0.1, needsImprovement: 0.25, unit: 'score' },
  fcp: { good: 1800, needsImprovement: 3000, unit: 'ms' },
  ttfb: { good: 800, needsImprovement: 1800, unit: 'ms' }
};

export const LAB_REGRESSION_RULES = {
  fcp: { label: 'FCP', minRatio: 0.2, minDelta: 300, unit: 'ms' },
  lcp: { label: 'LCP', minRatio: 0.2, minDelta: 300, unit: 'ms' },
  speedIndex: { label: 'Speed Index', minRatio: 0.2, minDelta: 300, unit: 'ms' },
  tbt: { label: 'TBT', minRatio: 0.2, minDelta: 100, unit: 'ms' },
  totalBytes: { label: 'Total bytes', minRatio: 0.15, minDelta: 0, unit: 'bytes' }
};

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, body, 'utf8');
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listJsonFiles(dirPath) {
  if (!(await pathExists(dirPath))) {
    return [];
  }
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dirPath, entry.name))
    .sort();
}

export async function loadWatchlist() {
  const config = await readJson(CONFIG_PATH);
  const origin = process.env.PERF_ORIGIN || config.origin;
  const urls = config.urls.map((entry) => {
    const url = new URL(entry.path, origin).toString();
    return { ...entry, url };
  });
  return { ...config, origin, urls };
}

export function normalizeDevices(value, defaults = ['mobile', 'desktop']) {
  const raw = value || defaults.join(',');
  const devices = raw
    .split(',')
    .map((device) => device.trim().toLowerCase())
    .filter(Boolean)
    .filter((device) => Object.hasOwn(DEVICE_TO_CRUX_FORM_FACTOR, device));
  return [...new Set(devices.length ? devices : defaults)];
}

export function selectedWatchlistUrls(watchlist) {
  const limit = Number.parseInt(process.env.PERF_URL_LIMIT || '', 10);
  if (Number.isFinite(limit) && limit > 0) {
    return watchlist.urls.slice(0, limit);
  }
  const explicitIds = (process.env.PERF_URL_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (explicitIds.length) {
    const allowed = new Set(explicitIds);
    return watchlist.urls.filter((entry) => allowed.has(entry.id) || allowed.has(entry.path));
  }
  return watchlist.urls;
}

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function safeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'unknown';
}

export function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) {
    return null;
  }
  const middle = Math.floor(clean.length / 2);
  if (clean.length % 2) {
    return clean[middle];
  }
  return (clean[middle - 1] + clean[middle]) / 2;
}

export function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) {
    return null;
  }
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function metricStats(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) {
    return {
      sampleCount: 0,
      average: null,
      median: null,
      min: null,
      max: null,
      stddev: null
    };
  }
  const avg = average(clean);
  const variance = average(clean.map((value) => (value - avg) ** 2));
  return {
    sampleCount: clean.length,
    average: avg,
    median: median(clean),
    min: Math.min(...clean),
    max: Math.max(...clean),
    stddev: Math.sqrt(variance)
  };
}

export function coerceNumber(value) {
  if (value === null || value === undefined || value === 'NaN') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function classifyMetric(metricKey, value) {
  const thresholds = FIELD_THRESHOLDS[metricKey];
  if (!thresholds || value === null || value === undefined) {
    return 'unknown';
  }
  if (value <= thresholds.good) {
    return 'good';
  }
  if (value <= thresholds.needsImprovement) {
    return 'needs-improvement';
  }
  return 'poor';
}

export function worstStatus(statuses) {
  const rank = {
    poor: 4,
    'needs-improvement': 3,
    unknown: 2,
    good: 1
  };
  return statuses
    .filter(Boolean)
    .sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || 'unknown';
}

export function formatCollectionDate(dateLike) {
  if (!dateLike) {
    return null;
  }
  if (typeof dateLike === 'string') {
    return dateLike;
  }
  const { year, month, day } = dateLike;
  if (!year || !month || !day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function extractLighthouseMetrics(lhr) {
  const audits = lhr?.audits || {};
  const numeric = (id) => coerceNumber(audits[id]?.numericValue);
  const detailsItems = (id) => audits[id]?.details?.items || [];
  const resourceItems = detailsItems('resource-summary');
  const networkItems = detailsItems('network-requests');
  const thirdPartyItems = detailsItems('third-party-summary');
  const resourceBytes = (type) => {
    const item = resourceItems.find((entry) => entry.resourceType === type);
    return coerceNumber(item?.transferSize) || 0;
  };

  const lcpElement = detailsItems('largest-contentful-paint-element')[0]?.node || null;
  const networkTransfer = networkItems.reduce((sum, item) => sum + (coerceNumber(item.transferSize) || 0), 0);
  const thirdPartyBytes = thirdPartyItems.reduce((sum, item) => sum + (coerceNumber(item.transferSize) || 0), 0)
    || resourceBytes('third-party');

  return {
    performanceScore: coerceNumber(lhr?.categories?.performance?.score),
    fcp: numeric('first-contentful-paint'),
    lcp: numeric('largest-contentful-paint'),
    speedIndex: numeric('speed-index'),
    tbt: numeric('total-blocking-time'),
    cls: numeric('cumulative-layout-shift'),
    ttfb: numeric('server-response-time') ?? numeric('time-to-first-byte'),
    totalBytes: numeric('total-byte-weight') ?? networkTransfer,
    requestCount: networkItems.length || null,
    jsBytes: resourceBytes('script'),
    imageBytes: resourceBytes('image'),
    thirdPartyBytes,
    lcpElement: lcpElement ? {
      snippet: lcpElement.snippet || null,
      selector: lcpElement.selector || null,
      path: lcpElement.path || null,
      nodeLabel: lcpElement.nodeLabel || null
    } : null,
    resourceSummary: resourceItems.map((item) => ({
      resourceType: item.resourceType,
      requestCount: coerceNumber(item.requestCount) || 0,
      transferSize: coerceNumber(item.transferSize) || 0
    })),
    thirdPartySummary: thirdPartyItems.slice(0, 12).map((item) => ({
      entity: item.entity || item.name || 'Unknown',
      transferSize: coerceNumber(item.transferSize) || 0,
      blockingTime: coerceNumber(item.blockingTime) || 0,
      mainThreadTime: coerceNumber(item.mainThreadTime) || 0
    })),
    topRequests: topNetworkRequests(networkItems),
    domainSummary: domainSummary(networkItems),
    opportunities: opportunitySummary(audits),
    mainThreadBreakdown: detailsItems('mainthread-work-breakdown').map((item) => ({
      group: item.group || null,
      label: item.groupLabel || item.group || 'Other',
      duration: coerceNumber(item.duration) || 0
    })),
    bootupScripts: detailsItems('bootup-time')
      .map((item) => ({
        url: item.url,
        host: hostForUrl(item.url),
        total: coerceNumber(item.total) || 0,
        scripting: coerceNumber(item.scripting) || 0,
        scriptParseCompile: coerceNumber(item.scriptParseCompile) || 0
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12)
  };
}

function topNetworkRequests(networkItems) {
  return networkItems
    .map((item) => ({
      url: item.url,
      host: hostForUrl(item.url),
      transferSize: coerceNumber(item.transferSize) || 0,
      resourceSize: coerceNumber(item.resourceSize) || 0,
      resourceType: item.resourceType || 'Other',
      mimeType: item.mimeType || null,
      statusCode: coerceNumber(item.statusCode),
      priority: item.priority || null,
      protocol: item.protocol || null
    }))
    .filter((item) => item.url && item.transferSize > 0)
    .sort((a, b) => b.transferSize - a.transferSize)
    .slice(0, 24);
}

function domainSummary(networkItems) {
  const domains = new Map();
  for (const item of networkItems) {
    const host = hostForUrl(item.url);
    if (!host) {
      continue;
    }
    const current = domains.get(host) || {
      host,
      requestCount: 0,
      transferSize: 0,
      resourceSize: 0,
      types: {}
    };
    current.requestCount += 1;
    current.transferSize += coerceNumber(item.transferSize) || 0;
    current.resourceSize += coerceNumber(item.resourceSize) || 0;
    const type = item.resourceType || 'Other';
    current.types[type] = (current.types[type] || 0) + 1;
    domains.set(host, current);
  }
  return [...domains.values()]
    .sort((a, b) => b.transferSize - a.transferSize)
    .slice(0, 16);
}

function opportunitySummary(audits) {
  const opportunityAudits = [
    ['total-byte-weight', 'Network payload'],
    ['unused-javascript', 'Unused JavaScript'],
    ['unused-css-rules', 'Unused CSS'],
    ['render-blocking-resources', 'Render blocking'],
    ['uses-responsive-images', 'Responsive images'],
    ['modern-image-formats', 'Image format'],
    ['efficient-animated-content', 'Animated media'],
    ['unminified-javascript', 'Unminified JS'],
    ['unminified-css', 'Unminified CSS']
  ];

  return opportunityAudits.flatMap(([id, label]) => {
    const audit = audits[id];
    const items = audit?.details?.items || [];
    if (!items.length) {
      return [];
    }
    return [{
      id,
      label,
      title: audit.title || label,
      score: coerceNumber(audit.score),
      numericValue: coerceNumber(audit.numericValue),
      items: items
        .map((item) => ({
          url: item.url,
          host: hostForUrl(item.url),
          totalBytes: coerceNumber(item.totalBytes) || coerceNumber(item.transferSize) || 0,
          wastedBytes: coerceNumber(item.wastedBytes) || 0,
          wastedMs: coerceNumber(item.wastedMs) || 0,
          wastedPercent: coerceNumber(item.wastedPercent)
        }))
        .filter((item) => item.url)
        .sort((a, b) => (b.wastedBytes || b.totalBytes || b.wastedMs) - (a.wastedBytes || a.totalBytes || a.wastedMs))
        .slice(0, 10)
    }];
  });
}

function hostForUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function buildMedianLighthouseSummary(runRecords) {
  const successful = runRecords.filter((record) => record.ok && record.extracted);
  const metricKeys = [
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
  const medianMetrics = Object.fromEntries(
    metricKeys.map((key) => [key, median(successful.map((record) => record.extracted[key]))])
  );
  const averageMetrics = Object.fromEntries(
    metricKeys.map((key) => [key, average(successful.map((record) => record.extracted[key]))])
  );
  const stats = Object.fromEntries(
    metricKeys.map((key) => [key, metricStats(successful.map((record) => record.extracted[key]))])
  );

  const representative = successful
    .map((record) => ({
      record,
      distance: Math.abs((record.extracted.lcp || 0) - (medianMetrics.lcp || 0))
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.record || null;

  return {
    successCount: successful.length,
    failureCount: runRecords.length - successful.length,
    median: {
      ...medianMetrics,
      lcpElement: representative?.extracted?.lcpElement || null,
      resourceSummary: representative?.extracted?.resourceSummary || [],
      thirdPartySummary: representative?.extracted?.thirdPartySummary || [],
      topRequests: representative?.extracted?.topRequests || [],
      domainSummary: representative?.extracted?.domainSummary || [],
      opportunities: representative?.extracted?.opportunities || [],
      mainThreadBreakdown: representative?.extracted?.mainThreadBreakdown || [],
      bootupScripts: representative?.extracted?.bootupScripts || []
    },
    average: averageMetrics,
    stats,
    representativeRunFile: representative?.fileName || null
  };
}
