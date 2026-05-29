# WebHub

Internal Homebase web team hub hosted as a Databricks App.

## Current Staging App

- App: `web-hub`
- URL: <https://web-hub-373323366197249.aws.databricksapps.com>
- Databricks source path: `/Workspace/Users/bnguyen@joinhomebase.com/web-hub`
- Lakebase project: `projects/web-hub-db`
- Production endpoint: `projects/web-hub-db/branches/production/endpoints/primary`
- Database: `databricks_postgres`

## What This Repo Contains

- `app.py`: FastAPI routes, auth, Jira ticket creation, dashboard/report APIs, Consent Metrics APIs, and Speed Index summary API.
- `static/`: self-contained frontend pages for Requests, In Progress, Dashboard, Consent Metrics, and Speed Index.
- `consent_metrics.py`: DataGrail consent parsing, staging, commit, aggregation, and Lakebase persistence.
- `local/speed-index/`: local/offline Lighthouse and PageSpeed collector source for the `/speed-index` dashboard.
- `docs/`: implementation notes and runbooks.

## Data Model

WebHub code is deployed from the Databricks workspace, but app data is stored in Lakebase.

Primary Lakebase tables:

- `retro_reports`: current retro dashboard payload, refreshed by the `web-hub-pipeline` Databricks job.
- `consent_import_batches`
- `consent_staged_events`
- `consent_events`
- `consent_snapshots`
- `speed_index_runs`
- `speed_index_samples`
- `speed_index_url_results`

The Requests page creates Jira tickets through `/api/jira`; it does not currently store request submissions in Lakebase.

The Speed Index dashboard reads the latest completed `speed_index_runs.summary` payload from Lakebase and falls back to the static placeholder JSON only when Lakebase is unavailable or empty.

## Local Development

```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Local dev falls back to the dev Lakebase branch when Databricks app env vars are absent.

## Deploy

```bash
databricks sync . /Workspace/Users/bnguyen@joinhomebase.com/web-hub --exclude .git --exclude __pycache__
databricks apps deploy web-hub --source-code-path /Workspace/Users/bnguyen@joinhomebase.com/web-hub
```

## Secrets

`app.yaml` intentionally contains placeholders for secrets. Set real values in Databricks staging/runtime configuration, not in GitHub.

Required secret env vars:

- `WEBHUB_DASHBOARD_PASSWORD`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `ANTHROPIC_API_KEY`
