# Live Staging Redesign Baseline

This is the source-of-truth design note for the Web Hub redesign that is live on Databricks staging. Treat the live staging shell as final when adding new pages or tabs.

## Captured Deployment

Captured on May 15, 2026 before the Consent Metrics implementation pass continued.

| Field | Value |
| --- | --- |
| Databricks app | `web-hub` |
| Staging URL | `https://web-hub-373323366197249.aws.databricksapps.com` |
| App state | `RUNNING` |
| Active deployment | `01f14f2e2b1119b29e8a881d2cfb1f74` |
| Deployment created | `2026-05-14T00:45:13Z` |
| Deployment status | `SUCCEEDED` |
| Source path | `/Workspace/Users/bnguyen@joinhomebase.com/web-hub` |
| Snapshot source path | `/Workspace/Users/49b4af05-7301-4d07-9fb5-5ae469dcd68e/src/01f14f2e2b1119b29e8a881d2cfb1f74` |
| Exported local snapshot | `/private/tmp/web-hub-live-01f14f2e2b1119b29e8a881d2cfb1f74` |

At capture time, local `app.py` and `static/*.html` matched the live staging redesign. The exported live snapshot also had helper and pipeline files that were not present locally: `cache_db.py`, `fetch_comments.py`, `jira_config.py`, `jira_fetch.py`, `metrics.py`, `pipeline.py`, `pipeline_db.py`, `run_pipeline`, and `status_time.py`. Local `report-data.json` differed from the live snapshot. Those were baseline differences before Consent Metrics work.

## Canonical Shell

- Static HTML pages with inline CSS and JavaScript remain the app pattern.
- The page shell uses a sticky dark top nav, a compact WebHub brand mark, and pill-style nav links.
- Canonical navigation after Consent Metrics is `/requests`, `/progress`, `/dashboard`, and `/consent`.
- Old `.html` page URLs should redirect to the clean routes instead of becoming primary links.
- Mobile nav should wrap or collapse into readable rows when needed so every tab label remains visible.

## Design Language

- Use `Plus Jakarta Sans`.
- Keep the app light-mode and work-focused: dense internal-tool layouts, restrained cards, compact controls, and no marketing hero treatment.
- Keep the existing purple direction, centered on Homebase purple `#7E3DD4`, with dark plum text/nav and soft lavender surfaces.
- Use 8px radii for cards, panels, inputs, chart containers, and map containers unless matching an existing pill control.
- Prefer full-width content areas with constrained inner width. Do not create nested cards or decorative page-section cards.
- Favor concise labels, scan-friendly metrics, sticky filters where useful, and chart/table views that support repeated operational use.

## Live Pages

### Requests

The request intake page is the default working surface. It uses the shared top nav, a two-column desktop layout, and a narrower single-column mobile layout.

- Left/context rail explains what makes a strong request.
- Main form collects name, title, description, page URL, design link, and screenshots.
- The workflow moves through form, AI refinement chat, structured ticket preview, Jira submission, and a success state.
- UI elements are compact, rounded to 8px, and styled as an internal tool rather than a landing page.

### Progress

The sprint progress page is a dense ticket board organized around current work.

- Header and status filter controls stay compact.
- Workstream sections group ticket rows.
- Rows prioritize key, title, status, and assignee.
- Loading and empty states use the same light surfaces, purple accent, and 8px panel style as the rest of Web Hub.

### Dashboard

The retro dashboard page is analytics-heavy and password-gated in addition to Databricks SSO.

- KPI cards lead the page.
- Sticky filter bar supports date, sprint, assignee, status, and workstream filtering.
- Tabs and chart grids expose analytics without changing page shell.
- Chart.js is the live pattern for retro dashboard visualizations.
- The AI insight chat is a floating operational assistant, not a separate hero or marketing feature.

### Consent Metrics

Consent Metrics should follow the same shell and design language while adding DataGrail-specific upload and reporting workflows.

- Use `/consent` as the canonical route and `Consent Metrics` as the nav label.
- Keep upload in the page toolbar/tray, not a modal-first workflow.
- Use aggregate metrics, chart cards, tables, and maps that fit the Web Hub analytical style.
- Keep raw DataGrail exports local-only or in ignored operational storage; the browser should receive aggregate data, not event rows.

## Backend And Runtime

- `app.py` hosts the FastAPI API app and static routes.
- Lakebase is the shared storage layer.
- Databricks Workspace SSO protects the deployed app.
- `/dashboard` keeps its additional password gate.
- `/consent` uses Databricks SSO only.
- Existing Jira, Claude, report, and Lakebase patterns should be reused rather than introducing a new framework.

## Working Rule

When local files, older documentation, or the previous standalone DataGrail dashboard conflict with this live staging baseline, follow the live Web Hub redesign. Update this document when staging changes intentionally.
