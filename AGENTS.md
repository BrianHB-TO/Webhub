# AGENTS.md

Operational instructions for Codex and other coding agents working in this repo.

## Project Overview

`web-hub` is an internal Homebase web team tool for Retro Dashboard, Request Intake, Sprint Progress, Consent Metrics, and Speed Index. It was migrated from Vercel + Upstash KV to Databricks Apps + Lakebase.

## Common Commands

```bash
# Local setup
pip install -r requirements.txt

# Local development
uvicorn app:app --host 0.0.0.0 --port 8000

# Sync to Databricks workspace
databricks sync . /Workspace/Users/bnguyen@joinhomebase.com/web-hub --exclude .git --exclude __pycache__

# Deploy Databricks App
databricks apps deploy web-hub --source-code-path /Workspace/Users/bnguyen@joinhomebase.com/web-hub
```

Port `8000` is required by Databricks Apps.

## Architecture

```text
web-hub/
├── app.py                  # FastAPI backend, API app, static serving, dashboard middleware
├── lakebase.py             # Lakebase connection, OAuth token rotation, psycopg pool
├── consent_metrics.py      # DataGrail consent parsing, aggregation, Lakebase helpers
├── app.yaml                # Databricks Apps config and env vars
├── requirements.txt        # fastapi, uvicorn, databricks-sdk, psycopg, httpx
├── comments.json           # Ticket comments for AI context
├── static/                 # Self-contained HTML pages with inline JS/CSS
│   ├── index.html          # Redirect to /requests
│   ├── requests.html       # AI-assisted Jira ticket creation
│   ├── progress.html       # Current sprint board by workstream
│   ├── dashboard.html      # Retro analytics, Chart.js, KPI cards, AI insights
│   ├── consent.html        # DataGrail Consent Metrics dashboard
│   ├── speed-index/        # Published Speed Index dashboard and normalized summary
│   └── dashboard-login.html # Dashboard password gate
├── docs/
│   ├── consent-metrics.md  # Full Consent Metrics plan, decisions, and runbook
│   ├── speed-index.md      # Speed Index collector, runtime, and automation runbook
│   └── live-staging-redesign.md # Source-of-truth live Web Hub redesign baseline
├── scripts/
│   └── consent_migration.py # Consent tables/grants/seed workflow
├── local/
│   ├── data-grail-dashboard/ # Ignored local-only raw DataGrail exports/reference dashboard
│   └── speed-index/          # Local Lighthouse/CrUX collector for Speed Index data
├── CLAUDE.md               # Legacy Claude instructions
└── AGENTS.md               # Codex/agent instructions
```

FastAPI serves the API sub-app and static files. Mount order is critical:

```python
app.mount("/api", api_app)
app.mount("/", StaticFiles(directory="static", html=True))
```

Do not reverse those mounts or `/api/*` routes can be shadowed by static serving.

## API Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/report` | GET | Read retro report from Lakebase, around 820KB JSONB |
| `/api/auth` | GET/POST | Dashboard password gate, check or set cookie |
| `/api/chat` | POST | Proxy to Anthropic Claude API |
| `/api/jira` | POST | Create Jira tickets and upload attachments |
| `/api/consent/report` | GET | Read aggregate DataGrail consent metrics, optional `start`/`end` |
| `/api/consent/imports` | GET | Read recent Consent Metrics import batches |
| `/api/consent/upload/preview` | POST | Stage DataGrail export files and return raw/new/duplicate counts |
| `/api/consent/upload/commit` | POST | Commit a staged consent import token |
| `/api/speed-index/summary` | GET | Read the latest normalized Speed Index summary from `SPEED_INDEX_SUMMARY_PATH` or bundled static fallback |

Canonical page routes are clean routes: `/requests`, `/progress`, `/dashboard`, `/consent`, and `/speed-index`. Old `.html` page URLs should redirect to the clean route.

## Lakebase

- OAuth token rotation uses `WorkspaceClient().postgres.generate_database_credential()`.
- Connections use `psycopg_pool.ConnectionPool` with min 1 and max 5.
- Environment detection is automatic: `DATABRICKS_APP_NAME` present means deployed production; absent means local dev branch.

Database details:

- Project: `projects/web-hub-db`
- Production host: `ep-divine-haze-d1jbjmnq.database.us-west-2.cloud.databricks.com`
- Dev host: `ep-winter-term-d1btxtp7.database.us-west-2.cloud.databricks.com`
- Service principal: `49b4af05-7301-4d07-9fb5-5ae469dcd68e`

Main table:

```sql
CREATE TABLE retro_reports (
    id SERIAL PRIMARY KEY,
    report_key VARCHAR(50) NOT NULL UNIQUE DEFAULT 'retro-report',
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    size_bytes INTEGER
);
```

There is a single row, upserted every 4 hours by the `jira-retro` pipeline.

Consent Metrics tables are created by:

```bash
python3 scripts/consent_migration.py --seed --refresh-static
```

The script creates `consent_import_batches`, `consent_staged_events`, `consent_events`, and `consent_snapshots`, then grants the app service principal access. It reads raw DataGrail exports from `local/data-grail-dashboard/consent-logs`, which is intentionally ignored by Git.

When adding tables, grant the Databricks app service principal access:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE <table> TO "49b4af05-7301-4d07-9fb5-5ae469dcd68e";
GRANT USAGE, SELECT ON SEQUENCE <table>_id_seq TO "49b4af05-7301-4d07-9fb5-5ae469dcd68e";
```

## Data Pipeline

The `~/jira-retro/` repo runs every 4 hours on GitHub Actions:

1. Fetch Jira sprint data and compute metrics.
2. Write `report-data.json`, around 820KB.
3. Upload to both Upstash KV via `upload-kv.ts` and Lakebase via `upload-lakebase.ts`.

All calculations happen in that pipeline. Lakebase stores the precomputed result.

## Auth Model

- Databricks Workspace SSO protects all pages automatically.
- `/dashboard` has an additional password gate using the `webhub-dashboard` cookie.
- `/consent` uses Databricks Workspace SSO only. Any SSO Web Hub user can upload a shared DataGrail export.
- The dashboard cookie stores a SHA-256 hash of the password with a 30-day expiry.
- Cookie security should remain HttpOnly, Secure, SameSite=Lax.
- Password comparisons should stay timing-safe via `hmac.compare_digest`.

## Environment Variables

Non-secrets in `app.yaml`:

- `PGHOST`
- `PGDATABASE`
- `PGUSER`
- `PGPORT`
- `PGSSLMODE`
- `ENDPOINT_NAME`

Secrets:

- `WEBHUB_DASHBOARD_PASSWORD`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `ANTHROPIC_API_KEY`

Do not commit real secret values.

## Frontend And Design

- Static pages are self-contained HTML with inline JavaScript and CSS.
- There is no React build step.
- Design should match the existing webhub style.
- Treat `docs/live-staging-redesign.md` as the source-of-truth baseline for the live Databricks staging redesign.
- Font: Plus Jakarta Sans.
- Charts: Chart.js 4.4.4.
- Brand purple: `#7E3DD4`.
- Consent Metrics bundles its Chart.js, D3, topojson, and map assets locally under `static/vendor/consent/`.

Keep changes consistent with the current dense internal-tool UI. Avoid introducing a separate design system or build pipeline unless the task explicitly calls for it.

## Agent Guardrails

- Keep `app.py` route and mount order intact unless you are intentionally changing the serving model.
- Keep local development on port `8000`.
- Preserve the local-vs-deployed Lakebase environment detection in `lakebase.py`.
- Treat the Jira and Anthropic credentials as secrets; only refer to env var names.
- For database schema changes, update grants for the app service principal.
- For frontend changes, keep pages static and self-contained unless there is a concrete reason to add tooling.
- Treat `docs/consent-metrics.md` as the paper trail and troubleshooting runbook for Consent Metrics.
- Do not commit raw DataGrail export files. Keep `local/data-grail-dashboard/` ignored.
- Do not commit raw Lighthouse output. Keep `local/speed-index/data/raw/` ignored and publish only the normalized Speed Index summary.
- For deployment work, sync before deploying with the Databricks commands above.
