"""FastAPI backend for Web Hub Databricks App."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
from pathlib import Path
import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import consent_metrics
from lakebase import get_connection


# ---------------------------------------------------------------------------
# Main app
# ---------------------------------------------------------------------------

app = FastAPI()

JIRA_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")


# ---------------------------------------------------------------------------
# Root redirect
# ---------------------------------------------------------------------------

@app.get("/")
async def root_redirect():
    return RedirectResponse(url="/requests", status_code=302)


@app.get("/requests")
async def requests_page():
    return FileResponse("static/requests.html")


@app.get("/requests.html")
async def requests_html_redirect():
    return RedirectResponse(url="/requests", status_code=301)


@app.get("/progress")
async def progress_page():
    return FileResponse("static/progress.html")


@app.get("/progress.html")
async def progress_html_redirect():
    return RedirectResponse(url="/progress", status_code=301)


@app.get("/consent")
async def consent_page():
    return FileResponse("static/consent.html")


@app.get("/consent.html")
async def consent_html_redirect():
    return RedirectResponse(url="/consent", status_code=301)


@app.get("/speed-index")
async def speed_index_page():
    return RedirectResponse(url="/speed-index/", status_code=307)


@app.get("/speed-index/")
async def speed_index_page_index():
    return FileResponse("static/speed-index/index.html")


@app.get("/speed-index.html")
async def speed_index_html_redirect():
    return RedirectResponse(url="/speed-index/", status_code=301)


# ---------------------------------------------------------------------------
# Dashboard auth helper
# ---------------------------------------------------------------------------

def _check_dashboard_cookie(request: Request) -> bool:
    cookie = request.cookies.get("webhub-dashboard", "")
    expected = os.environ.get("WEBHUB_DASHBOARD_PASSWORD", "")
    if not expected or not cookie:
        return False
    expected_hash = hashlib.sha256(expected.encode()).hexdigest()
    return hmac.compare_digest(cookie, expected_hash)


# ---------------------------------------------------------------------------
# Dashboard gate — explicit routes BEFORE the static mount
# ---------------------------------------------------------------------------

@app.get("/dashboard.html")
async def dashboard_html_redirect():
    return RedirectResponse(url="/dashboard", status_code=301)


@app.get("/dashboard")
async def dashboard_gate(request: Request):
    # Bypass auth for local development
    if not os.environ.get("DATABRICKS_APP_NAME"):
        return FileResponse("static/dashboard.html")
    if not _check_dashboard_cookie(request):
        return RedirectResponse(url="/dashboard-login.html")
    return FileResponse("static/dashboard.html")


# ---------------------------------------------------------------------------
# API routes (mounted directly on main app at /api/*)
# ---------------------------------------------------------------------------

@app.get("/api/comments")
async def get_comments():
    """Return ticket comments data, sourced from the latest report blob in Lakebase.

    The pipeline embeds `commentsByKey` as a top-level field of `retro_reports.data`
    so comments refresh atomically with the rest of the report. Falls back to the
    legacy local `comments.json` only when Lakebase is unreachable (local dev).
    """
    try:
        conn = get_connection()
        row = conn.execute(
            "SELECT data->'commentsByKey' FROM retro_reports WHERE report_key = %s",
            ("retro-report",),
        ).fetchone()
        conn.close()
        comments = (row[0] if row and row[0] is not None else {})
        response = JSONResponse(content=comments)
        response.headers["Cache-Control"] = "public, max-age=60"
        return response
    except Exception:
        import json, pathlib
        f = pathlib.Path(__file__).parent / "comments.json"
        if f.exists():
            return JSONResponse(content=json.loads(f.read_text()))
        return JSONResponse({})


@app.get("/api/report")
async def get_report():
    """Return the retro report JSONB data."""
    try:
        conn = get_connection()
        row = conn.execute(
            "SELECT data FROM retro_reports WHERE report_key = %s",
            ("retro-report",),
        ).fetchone()
        conn.close()
    except Exception:
        # Fallback to local JSON file for local development
        import json, pathlib
        local = pathlib.Path(__file__).parent / "report-data.json"
        if local.exists():
            data = json.loads(local.read_text())
            response = JSONResponse(content=data)
            response.headers["Cache-Control"] = "no-cache"
            return response
        return JSONResponse({"error": "Database unavailable and no local data"}, status_code=500)
    if row is None:
        return JSONResponse({"error": "Report not found"}, status_code=404)
    response = JSONResponse(content=row[0])
    response.headers["Cache-Control"] = "public, max-age=900"
    return response


def _speed_index_summary_from_lakebase() -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            """
            SELECT summary
            FROM speed_index_runs
            WHERE status IN ('completed', 'completed_with_errors')
              AND summary IS NOT NULL
            ORDER BY finished_at DESC NULLS LAST, started_at DESC
            LIMIT 1
            """
        ).fetchone()
    finally:
        conn.close()
    if not row or row[0] is None:
        return None
    data = row[0]
    if isinstance(data, str):
        data = json.loads(data)
    if isinstance(data, dict):
        data.setdefault("meta", {})
        data["meta"]["runtime"] = {"storage": "lakebase", "fallback": False}
    return data


def _speed_index_summary_from_file() -> tuple[dict, Path]:
    configured_path = os.environ.get("SPEED_INDEX_SUMMARY_PATH")
    summary_path = Path(configured_path) if configured_path else Path("static/speed-index/data/performance-summary.json")
    if not summary_path.is_absolute():
        summary_path = Path(__file__).parent / summary_path
    data = json.loads(summary_path.read_text())
    if isinstance(data, dict):
        data.setdefault("meta", {})
        data["meta"]["runtime"] = {"storage": "static", "fallback": True, "path": str(summary_path)}
    return data, summary_path


@app.get("/api/speed-index/summary")
async def get_speed_index_summary():
    """Return the latest Speed Index dashboard summary."""
    lakebase_error = None
    try:
        data = _speed_index_summary_from_lakebase()
        if data is not None:
            response = JSONResponse(content=data)
            response.headers["Cache-Control"] = "no-cache"
            return response
    except Exception as exc:
        lakebase_error = str(exc)

    try:
        data, summary_path = _speed_index_summary_from_file()
    except FileNotFoundError:
        return JSONResponse(
            {
                "error": "Speed Index summary not found",
                "lakebase_error": lakebase_error,
            },
            status_code=404,
        )
    except Exception as exc:
        return JSONResponse(
            {
                "error": f"Could not load Speed Index summary: {exc}",
                "lakebase_error": lakebase_error,
            },
            status_code=500,
        )
    if lakebase_error and isinstance(data, dict):
        data.setdefault("meta", {})
        data["meta"]["runtime"] = {
            **data["meta"].get("runtime", {}),
            "lakebaseError": lakebase_error,
        }

    response = JSONResponse(content=data)
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/auth")
async def get_auth(request: Request):
    """Check whether the caller has dashboard access."""
    dashboard_access = _check_dashboard_cookie(request)
    return JSONResponse({"authenticated": True, "dashboardAccess": dashboard_access})


@app.post("/api/auth")
async def post_auth(request: Request):
    """Authenticate for a given scope and set a cookie."""
    body = await request.json()
    password = body.get("password", "")
    scope = body.get("scope", "")

    if scope != "dashboard":
        return JSONResponse({"error": "Unknown scope"}, status_code=400)

    expected = os.environ.get("WEBHUB_DASHBOARD_PASSWORD", "")
    if not expected:
        return JSONResponse({"error": "Password not configured"}, status_code=500)
    if not hmac.compare_digest(password, expected):
        return JSONResponse({"error": "Incorrect password"}, status_code=401)

    hashed = hashlib.sha256(password.encode()).hexdigest()
    response = JSONResponse({"success": True})
    response.set_cookie(
        key="webhub-dashboard",
        value=hashed,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=2592000,
    )
    return response


@app.post("/api/chat")
async def post_chat(request: Request):
    """Proxy a request to the Anthropic Messages API."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return JSONResponse(
            {"error": {"message": "API key not configured"}}, status_code=500
        )
    body = await request.body()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            content=body,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            timeout=120.0,
        )
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type="application/json",
    )


def _markdown_to_adf(text: str) -> dict:
    """Convert simple markdown to Atlassian Document Format."""
    lines = text.split("\n")
    content = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Skip empty lines
        if not stripped:
            i += 1
            continue

        # Headings: ## or ###
        if stripped.startswith("## "):
            content.append({
                "type": "heading", "attrs": {"level": 3},
                "content": [{"type": "text", "text": stripped[3:].strip()}],
            })
            i += 1
            continue
        if stripped.startswith("### "):
            content.append({
                "type": "heading", "attrs": {"level": 4},
                "content": [{"type": "text", "text": stripped[4:].strip()}],
            })
            i += 1
            continue
        if stripped.startswith("# "):
            content.append({
                "type": "heading", "attrs": {"level": 2},
                "content": [{"type": "text", "text": stripped[2:].strip()}],
            })
            i += 1
            continue

        # Checkbox list items: - [ ] or - [x] — render as taskList
        if stripped.startswith("- [ ] ") or stripped.startswith("- [x] ") or stripped.startswith("- [X] "):
            items = []
            while i < len(lines):
                s = lines[i].strip()
                if s.startswith("- [ ] "):
                    items.append({"type": "taskItem", "attrs": {"state": "TODO", "localId": str(i)},
                        "content": [{"type": "text", "text": s[6:]}]})
                elif s.startswith("- [x] ") or s.startswith("- [X] "):
                    items.append({"type": "taskItem", "attrs": {"state": "DONE", "localId": str(i)},
                        "content": [{"type": "text", "text": s[6:]}]})
                else:
                    break
                i += 1
            content.append({"type": "taskList", "attrs": {"localId": "tasks"}, "content": items})
            continue

        # Bullet list: - item or * item
        if stripped.startswith("- ") or stripped.startswith("* "):
            items = []
            while i < len(lines):
                s = lines[i].strip()
                if s.startswith("- ") and not s.startswith("- ["):
                    items.append({"type": "listItem", "content": [
                        {"type": "paragraph", "content": [
                            {"type": "text", "text": s[2:]}
                        ]}
                    ]})
                elif s.startswith("* "):
                    items.append({"type": "listItem", "content": [
                        {"type": "paragraph", "content": [
                            {"type": "text", "text": s[2:]}
                        ]}
                    ]})
                else:
                    break
                i += 1
            content.append({"type": "bulletList", "content": items})
            continue

        # Numbered list: 1. item
        if len(stripped) > 2 and stripped[0].isdigit() and ". " in stripped[:5]:
            items = []
            while i < len(lines):
                s = lines[i].strip()
                if len(s) > 2 and s[0].isdigit() and ". " in s[:5]:
                    text_start = s.index(". ") + 2
                    items.append({"type": "listItem", "content": [
                        {"type": "paragraph", "content": [
                            {"type": "text", "text": s[text_start:]}
                        ]}
                    ]})
                else:
                    break
                i += 1
            content.append({"type": "orderedList", "content": items})
            continue

        # Regular paragraph — collect consecutive non-special lines
        para_lines = []
        while i < len(lines):
            s = lines[i].strip()
            if not s or s.startswith("#") or s.startswith("- ") or s.startswith("* ") or (len(s) > 2 and s[0].isdigit() and ". " in s[:5]):
                break
            para_lines.append(s)
            i += 1

        if para_lines:
            # Handle bold **text** within paragraphs
            para_text = " ".join(para_lines)
            content.append({
                "type": "paragraph",
                "content": _parse_inline_marks(para_text),
            })
        continue

    if not content:
        content = [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]

    return {"type": "doc", "version": 1, "content": content}


def _parse_inline_marks(text: str) -> list:
    """Parse bold (**text**) and links in text into ADF inline nodes."""
    import re
    nodes = []
    pattern = re.compile(r'\*\*(.+?)\*\*')
    last_end = 0
    for m in pattern.finditer(text):
        if m.start() > last_end:
            nodes.append({"type": "text", "text": text[last_end:m.start()]})
        nodes.append({"type": "text", "text": m.group(1), "marks": [{"type": "strong"}]})
        last_end = m.end()
    if last_end < len(text):
        nodes.append({"type": "text", "text": text[last_end:]})
    if not nodes:
        nodes = [{"type": "text", "text": text}]
    return nodes


@app.post("/api/jira")
async def post_jira(request: Request):
    """Create Jira issues or attach files."""
    jira_email = os.environ.get("JIRA_EMAIL", "")
    jira_token = os.environ.get("JIRA_API_TOKEN", "")
    if not jira_email or not jira_token:
        return JSONResponse({"error": "Jira credentials not configured"}, status_code=500)
    auth_str = base64.b64encode(f"{jira_email}:{jira_token}".encode()).decode()
    auth_header = f"Basic {auth_str}"
    jira_base = "https://joinhomebase.atlassian.net/rest/api/3"

    body = await request.json()
    action = body.get("action", "")

    if action == "create":
        summary = body.get("summary", "")
        description = body.get("description", "")
        issue_type = body.get("issueType", "Story")
        priority = body.get("priority")

        payload = {
            "fields": {
                "project": {"key": "MW"},
                "summary": summary,
                "description": _markdown_to_adf(description),
                "issuetype": {"name": issue_type},
            }
        }

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{jira_base}/issue",
                json=payload,
                headers={
                    "Authorization": auth_header,
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
            if resp.status_code >= 400:
                error_text = resp.text[:500]
                return JSONResponse(
                    {"error": f"Failed to create ticket: {error_text}"},
                    status_code=resp.status_code,
                )
            result = resp.json()
            key = result.get("key", "")
            issue_id = result.get("id", "")

            # Try to set priority if provided
            if priority and key:
                try:
                    await client.put(
                        f"{jira_base}/issue/{key}",
                        json={"fields": {"priority": {"name": priority}}},
                        headers={
                            "Authorization": auth_header,
                            "Content-Type": "application/json",
                        },
                        timeout=15.0,
                    )
                except Exception:
                    pass

        return JSONResponse({
            "key": key,
            "id": issue_id,
            "url": f"https://joinhomebase.atlassian.net/browse/{key}",
        })

    elif action == "attach":
        issue_key = body.get("issueKey", "")
        if not JIRA_KEY_PATTERN.match(issue_key):
            return JSONResponse({"error": "Invalid issue key"}, status_code=400)

        file_data = body.get("fileData", "")
        file_name = body.get("fileName", "attachment")
        content_type = body.get("contentType", "application/octet-stream")

        try:
            file_bytes = base64.b64decode(file_data)
        except Exception:
            return JSONResponse({"error": "Invalid base64 file data"}, status_code=400)

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{jira_base}/issue/{issue_key}/attachments",
                files={"file": (file_name, file_bytes, content_type)},
                headers={
                    "Authorization": auth_header,
                    "X-Atlassian-Token": "no-check",
                },
                timeout=30.0,
            )
            if resp.status_code >= 400:
                error_text = resp.text[:300]
                return JSONResponse(
                    {"error": f"Failed to upload attachment: {error_text}"},
                    status_code=resp.status_code,
                )
            try:
                result = resp.json()
            except Exception:
                result = {"raw": resp.text[:500]}

        return JSONResponse({"success": True, "result": result})

    return JSONResponse({"error": "Unknown action"}, status_code=400)


# ---------------------------------------------------------------------------
# Consent Metrics API
# ---------------------------------------------------------------------------

def _no_cache(response: JSONResponse) -> JSONResponse:
    response.headers["Cache-Control"] = "no-cache"
    return response


def _request_uploader(request: Request) -> str | None:
    for header in (
        "x-databricks-user-email",
        "x-databricks-user",
        "x-forwarded-email",
        "x-forwarded-user",
    ):
        value = request.headers.get(header)
        if value:
            return value
    return None


def _consent_fallback_response(status_code: int = 200) -> JSONResponse:
    fallback = consent_metrics.load_static_fallback()
    if fallback is None:
        return JSONResponse(
            {
                "error": "Consent database unavailable and no bundled fallback data found",
                "runtime": {"storage": "unavailable", "canCommit": False},
            },
            status_code=500,
        )
    fallback = {
        **fallback,
        "runtime": {
            "storage": "fallback",
            "canCommit": False,
            "fallback": True,
        },
    }
    return _no_cache(JSONResponse(content=fallback, status_code=status_code))


async def _uploaded_text_files(request: Request) -> list[tuple[str, str]]:
    form = await request.form()
    files: list[tuple[str, str]] = []
    for value in form.multi_items():
        item = value[1]
        if not hasattr(item, "filename") or not item.filename:
            continue
        raw = await item.read()
        files.append((item.filename, raw.decode("utf-8-sig", errors="replace")))
    if not files:
        raise consent_metrics.ConsentImportError("Choose at least one DataGrail export file.")
    return files


@app.get("/api/consent/report")
async def get_consent_report(request: Request):
    start = request.query_params.get("start") or None
    end = request.query_params.get("end") or None
    try:
        conn = get_connection()
        try:
            data = None if start or end else consent_metrics.snapshot_from_db(conn)
            if data is None:
                data = consent_metrics.aggregate_from_db(conn, start, end)
        finally:
            conn.close()
    except Exception:
        return _consent_fallback_response()
    data = {
        **data,
        "runtime": {
            "storage": "lakebase",
            "canCommit": True,
            "fallback": False,
        },
    }
    return _no_cache(JSONResponse(content=data))


@app.get("/api/consent/imports")
async def get_consent_imports():
    try:
        conn = get_connection()
        try:
            imports = consent_metrics.recent_imports(conn)
        finally:
            conn.close()
    except Exception:
        return _no_cache(JSONResponse(content={"imports": [], "runtime": {"storage": "fallback"}}))
    return _no_cache(JSONResponse(content={"imports": imports, "runtime": {"storage": "lakebase"}}))


@app.post("/api/consent/upload/preview")
async def preview_consent_upload(request: Request):
    try:
        files = await _uploaded_text_files(request)
    except consent_metrics.ConsentImportError as exc:
        return JSONResponse({"error": exc.to_dict()}, status_code=400)

    try:
        conn = get_connection()
        try:
            preview = consent_metrics.stage_upload(conn, files, _request_uploader(request))
        finally:
            conn.close()
        preview["runtime"] = {"storage": "lakebase", "canCommit": True}
        return _no_cache(JSONResponse(content=preview))
    except consent_metrics.ConsentImportError as exc:
        return JSONResponse({"error": exc.to_dict()}, status_code=400)
    except Exception:
        try:
            parsed, _events, totals = consent_metrics.parse_files(files)
        except consent_metrics.ConsentImportError as exc:
            return JSONResponse({"error": exc.to_dict()}, status_code=400)
        return _no_cache(JSONResponse(content={
            "token": None,
            "expires_in_minutes": None,
            "files": [
                {
                    "name": item.name,
                    "raw_rows": item.raw_rows,
                    "unique_rows": item.unique_rows,
                    "duplicate_rows": item.duplicate_rows,
                }
                for item in parsed
            ],
            "raw_rows": totals["raw_rows"],
            "new_rows": totals["deduped_rows"],
            "duplicate_rows": totals["duplicate_rows"],
            "can_commit": False,
            "runtime": {"storage": "fallback", "canCommit": False},
        }))


@app.post("/api/consent/upload/commit")
async def commit_consent_upload(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    token = body.get("token")
    if not token:
        return JSONResponse({"error": {"message": "Upload preview token is required."}}, status_code=400)
    try:
        conn = get_connection()
        try:
            result = consent_metrics.commit_upload(conn, token)
        finally:
            conn.close()
    except consent_metrics.ConsentImportError as exc:
        return JSONResponse({"error": exc.to_dict()}, status_code=400)
    except Exception as exc:
        return JSONResponse({"error": {"message": f"Could not commit upload: {exc}"}}, status_code=503)
    result["data"]["runtime"] = {"storage": "lakebase", "canCommit": True}
    return _no_cache(JSONResponse(content=result))


# ---------------------------------------------------------------------------
# Static files — catch-all MUST be last
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory="static", html=True), name="static")
