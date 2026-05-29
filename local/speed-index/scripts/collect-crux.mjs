import path from 'node:path';
import {
  CRUX_METRICS,
  CRUX_RAW_DIR,
  DEVICE_TO_CRUX_FORM_FACTOR,
  ensureDir,
  loadWatchlist,
  normalizeDevices,
  safeSlug,
  selectedWatchlistUrls,
  timestampForFile,
  writeJson
} from './utils.mjs';
import { buildPerformanceSummary } from './normalize.mjs';

const API_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord';

const apiKey = process.env.CRUX_API_KEY;
if (!apiKey) {
  console.error('CRUX_API_KEY is required for npm run collect:crux.');
  process.exit(1);
}

const watchlist = await loadWatchlist();
const devices = normalizeDevices(process.env.PERF_DEVICES, watchlist.defaultDevices);
const pages = selectedWatchlistUrls(watchlist);
const collectionPeriodCount = Number.parseInt(process.env.CRUX_COLLECTION_PERIODS || '40', 10);
const collectedAt = new Date().toISOString();
const stamp = timestampForFile(new Date(collectedAt));

await ensureDir(CRUX_RAW_DIR);

const targets = [
  {
    id: 'origin',
    type: 'origin',
    label: 'Origin',
    url: watchlist.origin,
    bodyKey: 'origin'
  },
  ...pages.map((page) => ({
    id: page.id,
    type: 'url',
    label: page.label,
    path: page.path,
    url: page.url,
    bodyKey: 'url'
  }))
];

let successCount = 0;
let insufficientCount = 0;
let failureCount = 0;

for (const target of targets) {
  for (const device of devices) {
    const body = {
      [target.bodyKey]: target.url,
      formFactor: DEVICE_TO_CRUX_FORM_FACTOR[device],
      metrics: CRUX_METRICS,
      collectionPeriodCount
    };
    const fileName = `${stamp}_${safeSlug(target.id)}_${device}.json`;
    const outputPath = path.join(CRUX_RAW_DIR, fileName);
    const record = {
      type: 'crux-history',
      collectedAt,
      target: {
        id: target.id,
        type: target.type,
        label: target.label,
        path: target.path || null,
        url: target.url
      },
      device,
      formFactor: DEVICE_TO_CRUX_FORM_FACTOR[device],
      request: {
        endpoint: API_ENDPOINT,
        body: { ...body, metrics: CRUX_METRICS }
      }
    };

    try {
      const response = await fetch(`${API_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text };
      }
      const output = {
        ...record,
        ok: response.ok,
        status: response.status,
        response: payload
      };
      await writeJson(outputPath, output);

      if (response.ok) {
        successCount += 1;
        console.log(`CrUX ${device.padEnd(7)} ${target.type.padEnd(6)} ${target.url} ok`);
      } else if (response.status === 404) {
        insufficientCount += 1;
        console.log(`CrUX ${device.padEnd(7)} ${target.type.padEnd(6)} ${target.url} insufficient data`);
      } else {
        failureCount += 1;
        console.warn(`CrUX ${device.padEnd(7)} ${target.type.padEnd(6)} ${target.url} failed (${response.status})`);
      }
    } catch (error) {
      failureCount += 1;
      await writeJson(outputPath, {
        ...record,
        ok: false,
        status: null,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      });
      console.warn(`CrUX ${device.padEnd(7)} ${target.type.padEnd(6)} ${target.url} failed (${error.message})`);
    }
  }
}

await buildPerformanceSummary();

console.log(`CrUX complete: ${successCount} ok, ${insufficientCount} insufficient, ${failureCount} failed.`);
if (failureCount) {
  process.exitCode = 1;
}
