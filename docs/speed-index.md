# Speed Index

Speed Index is the Web Hub page for PageSpeed Insights and local Lighthouse lab trends across the joinhomebase.com watchlist.

## Runtime Shape

- Page route: `/speed-index`
- Static app: `static/speed-index/`
- Summary API: `/api/speed-index/summary`
- Bundled fallback data: `static/speed-index/data/performance-summary.json`
- Optional live data path: `SPEED_INDEX_SUMMARY_PATH`

The Web Hub app only reads the normalized summary. It does not run Lighthouse or PageSpeed collection in the FastAPI process.

## Collector

Collector code lives in `local/speed-index/`.

```bash
cd local/speed-index
npm install
npm run collect:webhub
```

`collect:webhub` runs 10 Lighthouse samples for each URL/device, stores raw output under ignored `data/raw/`, and publishes the normalized summary to `../../static/speed-index/data/performance-summary.json`.

For exec-facing score parity with PageSpeed Insights, run:

```bash
PAGESPEED_API_KEY=<optional but recommended> npm run collect:pagespeed:webhub
```

That collector calls the PageSpeed Insights API, stores raw output under `data/raw/pagespeed/`, and publishes PSI median scores into the same summary. It accepts `PAGESPEED_API_KEY`, `PSI_API_KEY`, or `CRUX_API_KEY`. The dashboard labels PSI rows as `PageSpeed Insights`; local Lighthouse rows stay labeled `Local Lighthouse`.

For the production/cloud path, use Lakebase:

```bash
npm run migrate:lakebase
PAGESPEED_API_KEY=<secret> npm run collect:pagespeed:lakebase
```

The Lakebase path creates and writes:

- `speed_index_runs`
- `speed_index_samples`
- `speed_index_url_results`

Web Hub reads the newest completed `speed_index_runs.summary` first. The bundled static summary remains a fallback for local development or Lakebase outages.

## Automated Data

For production automation, run the collector as a scheduled job and set `SPEED_INDEX_SUMMARY_PATH` to a durable path shared by the collector and the Web Hub app, such as a Databricks Volume file.

```bash
SPEED_INDEX_SUMMARY_PATH=/Volumes/<catalog>/<schema>/<volume>/speed-index/performance-summary.json \
LIGHTHOUSE_RUNS=10 \
PERF_DEVICES=mobile,desktop \
npm run collect:lighthouse
```

Set the same `SPEED_INDEX_SUMMARY_PATH` on the Web Hub app. Then `/api/speed-index/summary` reads the latest summary without requiring an app redeploy.

To automate PSI-aligned scoring, run the Lakebase collector from a scheduled Databricks Job:

```bash
PAGESPEED_RUNS=3 \
PERF_DEVICES=mobile,desktop \
npm run collect:pagespeed:lakebase
```

`local/speed-index/jobs/speed-index-pagespeed-job.example.json` is a job-template starting point. Replace the workspace file path, secret scope, and workspace compute settings before creating the real job.

## Data Quality

The normalizer only exposes complete full-watchlist Lighthouse runs in dashboard trends. Smoke tests and interrupted runs remain in raw storage but are excluded from the visible trend line.

Score values are Lighthouse category scores. PageSpeed Insights also uses Lighthouse for lab scoring, but the public PSI score can differ from local Lighthouse because PSI runs in Google's environment while local Lighthouse runs on this machine's Chrome/network. Use PSI rows when the question is "what will execs see in PageSpeed Insights?" and local rows when the question is "what changed in requests, bytes, scripts, and page weight?"
