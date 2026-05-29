import path from 'node:path';
import {
  LIGHTHOUSE_RAW_DIR,
  buildMedianLighthouseSummary,
  ensureDir,
  extractLighthouseMetrics,
  loadWatchlist,
  normalizeDevices,
  pathExists,
  safeSlug,
  selectedWatchlistUrls,
  timestampForFile,
  writeJson
} from './utils.mjs';
import { buildPerformanceSummary } from './normalize.mjs';

const runId = process.env.PERF_RUN_ID || timestampForFile();
const collectedAt = new Date().toISOString();
const watchlist = await loadWatchlist();
const devices = normalizeDevices(process.env.PERF_DEVICES, watchlist.defaultDevices);
const pages = selectedWatchlistUrls(watchlist);
const runsRequested = Math.max(1, Number.parseInt(process.env.LIGHTHOUSE_RUNS || '5', 10));
const baselinePath = path.join(LIGHTHOUSE_RAW_DIR, 'baseline.json');

let lighthouse;
let chromeLauncher;
let desktopConfig;
try {
  lighthouse = (await import('lighthouse')).default;
  chromeLauncher = await import('chrome-launcher');
  desktopConfig = (await import('lighthouse/core/config/desktop-config.js')).default;
} catch (error) {
  console.error('Lighthouse dependencies are missing. Run npm install before npm run collect:lighthouse.');
  console.error(error.message);
  process.exit(1);
}

await ensureDir(LIGHTHOUSE_RAW_DIR);

const chrome = await chromeLauncher.launch({
  chromeFlags: [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage'
  ]
});

let failed = false;

try {
  for (const page of pages) {
    for (const device of devices) {
      const runRecords = [];
      for (let runIndex = 1; runIndex <= runsRequested; runIndex += 1) {
        const fileName = `${runId}_${safeSlug(page.id)}_${device}_run-${runIndex}.json`;
        const outputPath = path.join(LIGHTHOUSE_RAW_DIR, fileName);
        const baseRecord = {
          type: 'lighthouse-run',
          runId,
          collectedAt: new Date().toISOString(),
          pageId: page.id,
          path: page.path,
          url: page.url,
          label: page.label,
          group: page.group,
          device,
          runIndex,
          runsRequested
        };

        try {
          console.log(`Lighthouse ${device.padEnd(7)} run ${runIndex}/${runsRequested} ${page.url}`);
          const result = await lighthouse(page.url, lighthouseFlags(chrome.port), lighthouseConfig(device));
          const extracted = extractLighthouseMetrics(result.lhr);
          const output = {
            ...baseRecord,
            ok: true,
            finalUrl: result.lhr.finalDisplayedUrl,
            lighthouseVersion: result.lhr.lighthouseVersion,
            fetchTime: result.lhr.fetchTime,
            extracted,
            lhr: result.lhr
          };
          await writeJson(outputPath, output);
          runRecords.push({ ...output, fileName });
        } catch (error) {
          failed = true;
          const output = {
            ...baseRecord,
            ok: false,
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          };
          await writeJson(outputPath, output);
          runRecords.push({ ...output, fileName });
          console.warn(`Lighthouse failed for ${page.url} (${device}, run ${runIndex}): ${error.message}`);
        }
      }

      const median = buildMedianLighthouseSummary(runRecords);
      const summaryPath = path.join(LIGHTHOUSE_RAW_DIR, `${runId}_${safeSlug(page.id)}_${device}_median.json`);
      await writeJson(summaryPath, {
        type: 'lighthouse-median',
        runId,
        collectedAt,
        pageId: page.id,
        path: page.path,
        url: page.url,
        label: page.label,
        group: page.group,
        device,
        runsRequested,
        successCount: median.successCount,
        failureCount: median.failureCount,
        median: median.median,
        average: median.successCount > 1 ? median.average : null,
        stats: median.successCount > 1 ? median.stats : null,
        representativeRunFile: median.representativeRunFile
      });
    }
  }

  await maybeCreateBaseline({ runId, collectedAt, watchlist, pages, devices, runsRequested, baselinePath });
} finally {
  await chrome.kill();
}

await buildPerformanceSummary();

if (failed) {
  process.exitCode = 1;
}

function lighthouseFlags(port) {
  return {
    port,
    logLevel: process.env.LIGHTHOUSE_LOG_LEVEL || 'error',
    output: 'json',
    onlyCategories: ['performance']
  };
}

function lighthouseConfig(device) {
  return device === 'desktop' ? desktopConfig : undefined;
}

async function maybeCreateBaseline({ runId, collectedAt, watchlist, pages, devices, runsRequested, baselinePath }) {
  const alreadyExists = await pathExists(baselinePath);
  if (alreadyExists) {
    return;
  }

  const defaultDevices = normalizeDevices(null, watchlist.defaultDevices);
  const hasUrlLimit = Boolean(process.env.PERF_URL_LIMIT || process.env.PERF_URL_IDS);
  const isFullWatchlist = !hasUrlLimit
    && pages.length === watchlist.urls.length
    && defaultDevices.every((device) => devices.includes(device))
    && runsRequested >= 5;
  const forced = process.env.PERF_SET_BASELINE === '1';

  if (!isFullWatchlist && !forced) {
    return;
  }

  await writeJson(baselinePath, {
    type: 'lighthouse-baseline',
    runId,
    createdAt: collectedAt,
    reason: forced ? 'forced by PERF_SET_BASELINE=1' : 'first complete local Lighthouse run',
    urlCount: pages.length,
    devices,
    runsRequested
  });
  console.log(`Created Lighthouse synthetic baseline from run ${runId}.`);
}
