import path from 'node:path';
import {
  PAGESPEED_RAW_DIR,
  buildMedianLighthouseSummary,
  ensureDir,
  extractLighthouseMetrics,
  loadWatchlist,
  normalizeDevices,
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
const runsRequested = Math.max(1, Number.parseInt(process.env.PAGESPEED_RUNS || process.env.PSI_RUNS || '3', 10));
const apiKey = process.env.PAGESPEED_API_KEY || process.env.PSI_API_KEY || process.env.CRUX_API_KEY || '';

await ensureDir(PAGESPEED_RAW_DIR);

let failed = false;

for (const page of pages) {
  for (const device of devices) {
    const runRecords = [];
    for (let runIndex = 1; runIndex <= runsRequested; runIndex += 1) {
      const fileName = `${runId}_${safeSlug(page.id)}_${device}_run-${runIndex}.json`;
      const outputPath = path.join(PAGESPEED_RAW_DIR, fileName);
      const baseRecord = {
        type: 'pagespeed-run',
        source: 'pagespeed-insights',
        sourceLabel: 'PageSpeed Insights',
        runId,
        collectedAt: new Date().toISOString(),
        pageId: page.id,
        path: page.path,
        url: page.url,
        label: page.label,
        group: page.group,
        device,
        strategy: device === 'desktop' ? 'desktop' : 'mobile',
        runIndex,
        runsRequested
      };

      try {
        console.log(`PageSpeed ${device.padEnd(7)} run ${runIndex}/${runsRequested} ${page.url}`);
        const response = await fetch(pagespeedUrl(page.url, device));
        const body = await response.json();
        if (!response.ok || body.error) {
          throw new Error(body.error?.message || `PageSpeed API returned ${response.status}`);
        }

        const lhr = body.lighthouseResult;
        const extracted = extractLighthouseMetrics(lhr);
        const output = {
          ...baseRecord,
          ok: true,
          finalUrl: lhr?.finalDisplayedUrl || body.id || page.url,
          lighthouseVersion: lhr?.lighthouseVersion || null,
          fetchTime: lhr?.fetchTime || null,
          captchaResult: body.captchaResult || null,
          loadingExperience: body.loadingExperience || null,
          originLoadingExperience: body.originLoadingExperience || null,
          extracted,
          lhr
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
        console.warn(`PageSpeed failed for ${page.url} (${device}, run ${runIndex}): ${error.message}`);
      }
    }

    const median = buildMedianLighthouseSummary(runRecords);
    const summaryPath = path.join(PAGESPEED_RAW_DIR, `${runId}_${safeSlug(page.id)}_${device}_median.json`);
    await writeJson(summaryPath, {
      type: 'pagespeed-median',
      source: 'pagespeed-insights',
      sourceLabel: 'PageSpeed Insights',
      runId,
      collectedAt,
      pageId: page.id,
      path: page.path,
      url: page.url,
      label: page.label,
      group: page.group,
      device,
      strategy: device === 'desktop' ? 'desktop' : 'mobile',
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

await buildPerformanceSummary();

if (failed) {
  process.exitCode = 1;
}

function pagespeedUrl(url, device) {
  const params = new URLSearchParams({
    url,
    strategy: device === 'desktop' ? 'desktop' : 'mobile'
  });
  for (const category of ['performance']) {
    params.append('category', category);
  }
  if (apiKey) {
    params.set('key', apiKey);
  }
  return `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`;
}
