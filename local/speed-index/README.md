# Web Hub Speed Index Collector

Local/offline collector for the Web Hub `/speed-index` dashboard. Web Hub serves the UI from `static/speed-index/`; this folder owns the data pulls and normalization.

Raw Lighthouse output can be large, so `data/raw/` is ignored. The collector publishes the normalized dashboard payload to `../../static/speed-index/data/performance-summary.json` for local/dev use. In Databricks, set `SPEED_INDEX_SUMMARY_PATH` on the app and scheduled collector to point at a durable Volume path so new data can appear without redeploying Web Hub.

## Setup

```sh
npm install
export CRUX_API_KEY="your Chrome UX Report API key"
```

Optional environment variables:

```sh
export LIGHTHOUSE_RUNS=5
export PAGESPEED_RUNS=3
export PAGESPEED_API_KEY="your PageSpeed Insights API key" # falls back to PSI_API_KEY or CRUX_API_KEY
export PERF_ORIGIN="https://www.joinhomebase.com"
export PERF_DEVICES="mobile,desktop"
```

## Commands

```sh
npm run collect:crux        # CrUX History API weekly field trends
npm run collect:lighthouse  # local Lighthouse medians, default 5 runs per URL/device
npm run collect:pagespeed   # PageSpeed Insights API medians, default 3 runs per URL/device
npm run collect             # runs both collectors
npm run normalize           # rebuilds static/data/performance-summary.json from raw files
npm run publish:webhub      # publish normalized data into Web Hub static/speed-index/data
npm run collect:webhub      # 10 Lighthouse runs per URL/device and publish to Web Hub
npm run collect:pagespeed:webhub # 3 PSI runs per URL/device and publish to Web Hub
npm run migrate:lakebase    # create Speed Index Lakebase tables
npm run collect:pagespeed:lakebase # 3 PSI runs per URL/device and store in Lakebase
```

For a quick Lighthouse smoke test:

```sh
npm run smoke:lighthouse
```

## Daily Lab Trend Runs

For the ongoing trend, run Lighthouse with repeated samples:

```sh
LIGHTHOUSE_RUNS=5 npm run collect:lighthouse
```

Each URL/device stores the median, average, and stability stats from that collection. Historical runs that only have one successful sample stay marked as single-sample, and the dashboard hides averages for those rows instead of backfilling mixed-confidence data.

For Web Hub daily data, prefer:

```sh
npm run collect:webhub
```

That keeps the dashboard trend aligned around complete daily 10-sample runs.

For cloud-safe daily data, prefer PageSpeed Insights into Lakebase:

```sh
PAGESPEED_API_KEY="..." npm run migrate:lakebase
PAGESPEED_API_KEY="..." npm run collect:pagespeed:lakebase
```

That path does not require Chrome. It stores samples, per-URL/device medians, and the latest normalized dashboard summary in Lakebase. Web Hub reads the newest completed Lakebase summary first and falls back to `static/speed-index/data/performance-summary.json` only when Lakebase is unavailable or empty.

## Score Source

Dashboard scores come from the newest complete lab run. If a PageSpeed Insights run has been collected, that PSI Lighthouse score should be used for exec-facing score conversations because it matches the public tool more closely. Local Lighthouse remains useful for repeatable diagnostics, request-level breakdowns, resource weight, and run-over-run regressions.

The collector stores Lighthouse's `categories.performance.score`, and the dashboard displays it on the 0-100 Lighthouse scale using PageSpeed/Lighthouse bands: 0-49 poor, 50-89 needs improvement, and 90-100 good. The UI labels whether a row came from PageSpeed Insights or Local Lighthouse.

Mobile runs use Lighthouse's default mobile settings. Desktop runs use Lighthouse's built-in desktop preset. PageSpeed Insights also runs Lighthouse, but in Google's PSI environment, so its score can differ from local Lighthouse even when the tested URL is the same.

## Data Model

- `config/watchlist.json` is the canonical page list.
- `data/raw/crux/` stores raw CrUX History API responses and insufficient-data responses.
- `data/raw/lighthouse/` stores raw Lighthouse run output and per-URL median summaries.
- `data/raw/pagespeed/` stores raw PageSpeed Insights API output and per-URL median summaries.
- `static/data/performance-summary.json` is the normalized dashboard payload.
- `speed_index_runs`, `speed_index_samples`, and `speed_index_url_results` are the Lakebase tables used by the scheduled PageSpeed job.

The May 5 audit is included as an annotation baseline only. It is not treated as the current CrUX or Lighthouse source of truth.

## Databricks Job

Use `jobs/speed-index-pagespeed-job.example.json` as the starting point for a scheduled Databricks Job. Replace the workspace path and secret scope placeholders, add the required compute/serverless job settings for the workspace, then create or update the job with the Databricks CLI/API.
