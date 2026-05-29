# web-hub

Internal tool for the Homebase web team: Retro Dashboard, Request Intake, Sprint Progress.
Migrated from Vercel + Upstash KV to Databricks Apps + Lakebase.

## Architecture

```
web-hub/
├── app.py              # FastAPI backend (API + static serving + dashboard middleware)
├── lakebase.py         # Lakebase connection (OAuth token rotation, psycopg pool)
├── app.yaml            # Databricks Apps config + env vars
├── requirements.txt    # fastapi, uvicorn, databricks-sdk, psycopg, httpx
├── comments.json       # Ticket comments for AI context
├── static/             # Self-contained HTML pages (inline JS/CSS)
│   ├── index.html          # Redirect to /requests
│   ├── requests.html       # AI-assisted Jira ticket creation
│   ├── progress.html       # Current sprint board by workstream
│   ├── dashboard.html      # Retro analytics (Chart.js, KPI cards, AI insights)
│   └── dashboard-login.html # Dashboard password gate
└── CLAUDE.md
```

### How the app works

FastAPI serves the API sub-app and static files. **Mount order is critical**:
```python
app.mount("/api", api_app)
app.mount("/", StaticFiles(directory="static", html=True))
```

Port **8000** is required by Databricks Apps. Workspace SSO handles authentication for all pages. Dashboard has an additional password gate via middleware.

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/report` | GET | Read retro report from Lakebase (820KB JSONB) |
| `/api/auth` | GET/POST | Dashboard password gate (check / set cookie) |
| `/api/chat` | POST | Proxy to Anthropic Claude API |
| `/api/jira` | POST | Create Jira tickets + upload attachments |

### Deployment

```bash
# Sync to workspace
databricks sync . /Workspace/Users/bnguyen@joinhomebase.com/web-hub --exclude .git --exclude __pycache__

# Deploy
databricks apps deploy web-hub --source-code-path /Workspace/Users/bnguyen@joinhomebase.com/web-hub
```

### Local development

```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Connects to the dev Lakebase branch automatically (no env vars needed).

## Lakebase

### Connection Architecture

- OAuth token rotation via `WorkspaceClient().postgres.generate_database_credential()`
- `psycopg_pool.ConnectionPool` (min=1, max=5)
- Auto-detects environment: `DATABRICKS_APP_NAME` present = deployed (production), absent = local (dev branch)

### Database

- **Project**: `projects/web-hub-db`
- **Production host**: `ep-divine-haze-d1jbjmnq.database.us-west-2.cloud.databricks.com`
- **Dev host**: `ep-winter-term-d1btxtp7.database.us-west-2.cloud.databricks.com`
- **Service principal**: `49b4af05-7301-4d07-9fb5-5ae469dcd68e`

### Table Schema

```sql
CREATE TABLE retro_reports (
    id SERIAL PRIMARY KEY,
    report_key VARCHAR(50) NOT NULL UNIQUE DEFAULT 'retro-report',
    data JSONB NOT NULL,          -- Full report (~820KB): quarters, allTickets, sprints
    generated_at TIMESTAMPTZ NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    size_bytes INTEGER
);
```

Single row, upserted every 4 hours by the jira-retro pipeline.

### Adding new tables

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE <table> TO "49b4af05-7301-4d07-9fb5-5ae469dcd68e";
GRANT USAGE, SELECT ON SEQUENCE <table>_id_seq TO "49b4af05-7301-4d07-9fb5-5ae469dcd68e";
```

## Data Pipeline (jira-retro)

The `~/jira-retro/` repo runs every 4h on GitHub Actions:
1. Fetches Jira sprint data, computes metrics
2. Writes `report-data.json` (~820KB)
3. Uploads to both Upstash KV (`upload-kv.ts`) AND Lakebase (`upload-lakebase.ts`) — dual-write during migration

All calculations happen in the pipeline. Lakebase just stores the pre-computed result.

## Auth Model

- **Workspace SSO**: All pages are behind Databricks SSO automatically
- **Dashboard password**: Additional gate on `/dashboard` — checks `webhub-dashboard` cookie (SHA-256 hash of password, 30-day expiry)
- **Cookie security**: HttpOnly, Secure, SameSite=Lax, timing-safe comparison via hmac.compare_digest

## Environment Variables (app.yaml)

Non-secrets: `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPORT`, `PGSSLMODE`, `ENDPOINT_NAME`
Secrets: `WEBHUB_DASHBOARD_PASSWORD`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `ANTHROPIC_API_KEY`

## Design System

Matches the existing webhub design — Plus Jakarta Sans, Chart.js 4.4.4 for charts, purple brand (#7E3DD4).
Frontend pages are self-contained HTML with inline JS/CSS (no React build step).
