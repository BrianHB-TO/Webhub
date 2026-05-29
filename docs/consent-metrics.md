# Consent Metrics Paper Trail

This document records the plan, decisions, live staging baseline, implementation notes, and troubleshooting runbook for adding DataGrail Consent Metrics to Web Hub. The broader Web Hub redesign baseline is documented in `docs/live-staging-redesign.md`.

## Live Databricks Staging Baseline

Captured before Consent Metrics implementation continued.

| Field | Value |
| --- | --- |
| App | `web-hub` |
| URL | `https://web-hub-373323366197249.aws.databricksapps.com` |
| App state | `RUNNING` |
| Active deployment | `01f14f2e2b1119b29e8a881d2cfb1f74` |
| Deployment created | `2026-05-14T00:45:13Z` |
| Deployment status | `SUCCEEDED` |
| Source path | `/Workspace/Users/bnguyen@joinhomebase.com/web-hub` |
| Snapshot source path | `/Workspace/Users/49b4af05-7301-4d07-9fb5-5ae469dcd68e/src/01f14f2e2b1119b29e8a881d2cfb1f74` |
| Local exported snapshot | `/private/tmp/web-hub-live-01f14f2e2b1119b29e8a881d2cfb1f74` |

Live staging is the design source of truth. Local `app.py` and `static/*.html` matched the live redesign at comparison time. The live snapshot also included pipeline/helper files that were absent locally: `cache_db.py`, `fetch_comments.py`, `jira_config.py`, `jira_fetch.py`, `metrics.py`, `pipeline.py`, `pipeline_db.py`, `run_pipeline`, and `status_time.py`. Local `report-data.json` differed from the live snapshot. Those baseline differences existed before the Consent Metrics implementation.

## Final Plan

- Add a new Web Hub tab labeled `Consent Metrics`, served at `/consent`.
- Move navigation to clean routes: `/requests`, `/progress`, `/dashboard`, `/consent`; keep old `.html` URLs as redirects.
- Build the DataGrail dashboard natively in the live Web Hub redesign style.
- Use Databricks SSO only. Any SSO Web Hub user can upload shared DataGrail exports.
- Store metric fields only in Lakebase; do not retain raw files or raw visitor IDs.
- Move the local DataGrail project to `local/data-grail-dashboard` and ignore it in Git.
- Add a bundled aggregate fallback at `static/consent-data.json`.
- Add a full parser, aggregation layer, migration/seed script, tests, and operational docs.

## Decision Log

| Question | Decision | Implementation consequence |
| --- | --- | --- |
| Who sees uploaded data? | Shared in Web Hub | Use Lakebase-backed shared storage. |
| Access model? | Databricks SSO only | No Consent password gate. |
| Who can upload? | Any SSO user | No uploader allowlist or new secret. |
| Retained data | Metric fields only | Store normalized fields and hashes, not raw files. |
| Upload mode | Append deduped events | Event hash uniqueness prevents double counting. |
| Default range | All uploaded data | Initial dashboard shows full imported history. |
| V1 filters | Date only | Backend supports `start` and `end`. |
| Initial data | Seed existing exports | Current dashboard baseline is available on first load. |
| Maps | Keep world, US, Canada | Bundle D3/topojson/geodata locally. |
| Import UI placement | Toolbar action | Upload tray opens from page toolbar. |
| Upload flow | Inline upload tray | No modal or separate page. |
| Import log | Recent imports in tray | Show latest batch/file counts. |
| Uploader identity | Best effort only | Store headers if Databricks exposes them. |
| Row-level event table | No row table in v1 | Browser receives aggregate JSON only. |
| Rollback support | Soft rollback model, SQL/runbook only | No public rollback UI or endpoint. |
| Rollback users | Engineer only | Runbook documents SQL path. |
| Metric definitions | Keep current rules | `accept_all` opt-in; `essential_only`, `DNT`, `GPC` opt-out; `custom` partial; `exit` dismissed. |
| Timezone | Export date/UTC | Bucket by `created_at[:10]`. |
| Batch uploads | Multiple files | Preview accepts file batches. |
| Batch failure | Reject whole batch | Atomic validation before staging. |
| Bad rows | Reject file | User sees file/row/actionable parse error. |
| Required fields | Metric fields only | Validate dashboard/dedupe fields, not every export column. |
| Unknown states | Import as Other | New DataGrail states remain visible. |
| Dedupe key | Current compound key | Hash `consent_container_version_id`, `dg_id`, `created_at`, `consent_state`, `method`, `url`, `policyName`. |
| Date controls | Preset plus custom | All time, last 30 days, current month, custom. |
| Aggregation location | Backend | Browser does not receive event rows. |
| Cache policy | No-cache | Refresh/page load sees latest shared data. |
| Live updates | Refresh on page load only | No polling in v1. |
| After upload | Refresh current range | User context is preserved. |
| Local unavailable DB | Read-only seed fallback | Page renders aggregate fallback; commit disabled. |
| Local reachable DB | Write to dev Lakebase | Local behavior matches production with dev defaults. |
| Migration | One script | `scripts/consent_migration.py` handles tables/grants/seed. |
| Script location | `web-hub/scripts` | Operational workflow stays with the app. |
| Freshness display | Last import plus range | Toolbar badges show context. |
| Privacy note | Small upload-tray note | Main dashboard stays focused. |
| First viewport | KPIs plus outcome trend | Upload remains available via toolbar. |
| Map metric | Opt-out rate | Matches current dashboard. |
| Map controls | Fixed opt-out | Other outcomes stay in charts. |
| Seed source | Read local source folder | Do not commit raw 45 MB exports. |
| Missing seed source | Clear error | Script stops before partial writes. |
| Versioning | Simple version | Snapshots include `consent-v1`. |
| Error detail | Actionable summary | No stack traces in UI. |
| Upload confirmation | Review then confirm | Preview stages data before shared commit. |
| Preview storage | Server staging token | Commit uses a staged token. |
| Staging TTL | 10 minutes | Expired previews cannot commit. |
| Cleanup | Opportunistic | Preview/commit calls clean expired staging. |
| Import unit | Batch with file details | Multi-file uploads are one operation. |
| Counts | Raw, new, duplicate | Preview/log explain dedupe behavior. |
| Zero-new upload | Log no-op import | Metrics stay unchanged. |
| Mobile | Responsive read/upload | Consent page supports mobile use. |
| Libraries | Bundle local assets | Consent does not depend on CDNs. |
| Existing Dashboard Chart.js | Do not change | Scope vendor change to Consent only. |
| Backend organization | New consent module | `app.py` keeps thin route handlers. |
| Tests | Pytest parser/API helpers | Add focused parser and aggregation coverage. |
| Test dependency | `requirements.txt` | No separate dev requirements file. |
| AI insights | No AI in v1 | Consent stays deterministic. |
| Aggregate export | No export in v1 | Keep scope on dashboard/upload. |
| Route naming | Clean routes | New canonical route is `/consent`. |
| Old `.html` URLs | Redirect to clean paths | Existing bookmarks still work. |
| Root route | `/requests` | Preserve current default page. |
| `index.html` | Meta redirect to `/requests` | Static fallback remains harmless. |
| Static file names | Keep HTML filenames | FastAPI maps clean routes to existing files. |
| Seed target | Current environment | Local defaults hit dev; app env hits prod. |
| Deployment scope | Local plus instructions | No production deploy without separate approval. |
| Bundled seed JSON | Aggregate only | Commit fallback metrics, not raw rows. |
| Refresh seed JSON | Flag-controlled | `--refresh-static` avoids accidental file churn. |
| Hashing | SHA-256 plain hashes | No new salt or secret. |
| Retention | Indefinite for now | Normalized events persist until policy changes. |
| Retention UI | Docs only | Upload tray mentions only no raw files/raw IDs. |
| Empty state | Upload-first | No-data page directs user to import. |
| DB outage | Fallback badge | Users can see fallback mode. |
| Fallback upload | Preview only | Commit blocked without Lakebase. |
| New secrets | None | Uses existing Lakebase/SSO. |
| Upload API | Preview plus commit | Separate endpoints for the two-step flow. |
| Preview dashboard | Counts only | Charts change only after commit. |
| Concurrency | DB uniqueness wins | Commit recomputes final counts. |
| Commit counts | Recompute | Handles overlapping user commits. |
| Visual QA | Desktop and mobile screenshots | Verify layout and maps locally. |
| Docs | AGENTS plus runbook | This document is the detailed paper trail. |
| Move DataGrail folder | Ignored local folder | `local/data-grail-dashboard/` is ignored. |
| Paper trail location | `docs/consent-metrics.md` | One comprehensive document. |
| Q&A log | Decision table | Every grill decision is captured here. |
| Implementation changelog | Manual section | File changes and verification are recorded below. |
| Dirty baseline | Record baseline status | See live/local baseline above. |

## Data Model

Tables created by `scripts/consent_migration.py`:

- `consent_import_batches`: staged/committed import batches, file metadata, counts, uploader when available, expiry, revert marker.
- `consent_staged_events`: short-lived normalized rows for preview/confirm, expired after 10 minutes.
- `consent_events`: deduped normalized metric rows with `event_hash` unique and `visitor_hash` for unique visitor counts.
- `consent_snapshots`: latest aggregate JSON snapshot with aggregation version.

Stored event fields:

- `event_hash`, `visitor_hash`
- `event_date`, `created_at`
- `consent_state`, `bucket`
- `method`, `country`, `region`, `policy_name`, `url_domain`
- `categories_seen`, `categories_enabled`

Raw uploaded files, raw `dg_id`, and raw URL are not retained. Raw URL is used only when computing the event hash.

## API Surface

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/consent` | GET | Consent Metrics page |
| `/consent.html` | GET | Redirect to `/consent` |
| `/api/consent/report` | GET | Aggregate metrics, optional `start`/`end` query params |
| `/api/consent/imports` | GET | Recent import batches |
| `/api/consent/upload/preview` | POST | Parse/stage multipart files and return counts/token |
| `/api/consent/upload/commit` | POST | Commit staged token and refresh metrics |

Clean route redirects were also added for `/requests.html`, `/progress.html`, and `/dashboard.html`.

## Migration And Seed

From the Web Hub repo:

```bash
python3 scripts/consent_migration.py --seed --refresh-static
```

Use `--skip-grants` only if the caller cannot grant service principal permissions.

The script expects raw DataGrail exports at:

```text
local/data-grail-dashboard/consent-logs
```

That folder is ignored by Git.

## Rollback Runbook

Rollback is engineer-only and SQL/runbook based. Mark the bad batch reverted, deactivate its events, then recompute the snapshot through the script or an engineer console.

```sql
UPDATE consent_import_batches
SET reverted_at = NOW(), status = 'reverted'
WHERE id = <bad_batch_id>;

UPDATE consent_events
SET active = FALSE
WHERE import_batch_id = <bad_batch_id>;
```

Then recompute and upsert the snapshot from active events. The app has no public rollback endpoint in v1.

## Baseline Metrics

The moved local DataGrail exports produce the same current dashboard baseline:

| Metric | Value |
| --- | --- |
| Deduped events | `47,855` |
| Unique visitors | `47,587` |
| Date range | `2026-04-17` to `2026-04-28` |
| Opt-in rate | `21.9%` |
| Opt-out rate | `11.0%` |
| Dismissed rate | `65.9%` |

## Implementation Change Log

Initial implementation changes:

- Added `consent_metrics.py` for parsing, normalization, aggregation, staging, commit, snapshot, fallback, and DB helpers.
- Added `scripts/consent_migration.py` for table creation, grants, seeding, and optional static fallback refresh.
- Added `static/consent.html` for the Web Hub native Consent Metrics page.
- Added `static/consent-data.json` aggregate fallback generated from the current local exports.
- Added local consent vendor assets under `static/vendor/consent/`.
- Added clean route handlers and Consent API routes to `app.py`.
- Updated nav links in Web Hub pages to use clean routes and include `Consent Metrics`.
- Added parser/aggregation tests in `tests/test_consent_metrics.py`.
- Updated `.gitignore` to keep `local/data-grail-dashboard/` out of Git.
- Moved `/Users/bnguyen/projects/data-grail-dashboard` to `web-hub/local/data-grail-dashboard`.

Verification results from the first implementation pass:

- `python3 -m pytest tests/test_consent_metrics.py`: 5 passed.
- `python3 -m py_compile consent_metrics.py scripts/consent_migration.py tests/test_consent_metrics.py app.py`: passed.
- `python3 -c "import app; print('ok')"`: passed with only existing urllib3/Python 3.9 environment warnings.
- Local route checks on port `8001`: `/requests`, `/consent`, `/api/consent/report`, and `/api/consent/imports` returned 200; `.html` page URLs returned clean-route redirects.
- Fallback upload preview parsed `consent_audit_log-april.json` and returned `9,177` raw rows, `9,177` new rows, and `can_commit: false` because local Lakebase was unavailable.
- Desktop and mobile screenshots were captured for `/consent`; mobile nav was adjusted after adding the fourth tab so labels render in readable rows instead of clipping.
