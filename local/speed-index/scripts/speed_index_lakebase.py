"""Lakebase-backed PageSpeed Insights collection helpers for Speed Index."""

from __future__ import annotations

import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median
from typing import Any
from urllib.parse import urlparse

import httpx
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


SPEED_INDEX_ROOT = Path(__file__).resolve().parents[1]
WEB_HUB_ROOT = Path(__file__).resolve().parents[3]
WATCHLIST_PATH = SPEED_INDEX_ROOT / "config" / "watchlist.json"

APP_PRINCIPAL = "49b4af05-7301-4d07-9fb5-5ae469dcd68e"
SOURCE = "pagespeed-insights"
SOURCE_LABEL = "PageSpeed Insights"
METRIC_KEYS = (
    "performanceScore",
    "fcp",
    "lcp",
    "speedIndex",
    "tbt",
    "cls",
    "ttfb",
    "totalBytes",
    "requestCount",
    "jsBytes",
    "imageBytes",
    "thirdPartyBytes",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat(timespec="milliseconds")


def timestamp_for_run() -> str:
    return utc_now().isoformat(timespec="milliseconds").replace(":", "-").replace(".", "-")


def load_watchlist(path: Path = WATCHLIST_PATH) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    origin = os.environ.get("PERF_ORIGIN") or config["origin"]
    urls = []
    for entry in config["urls"]:
        url = entry.get("url") or origin.rstrip("/") + entry["path"]
        urls.append({**entry, "url": url})
    return {**config, "origin": origin, "urls": urls}


def normalize_devices(value: str | None, defaults: list[str]) -> list[str]:
    raw = value or ",".join(defaults)
    allowed = {"mobile", "desktop"}
    devices = []
    for item in raw.split(","):
        device = item.strip().lower()
        if device in allowed and device not in devices:
            devices.append(device)
    return devices or defaults


def selected_watchlist_urls(watchlist: dict[str, Any]) -> list[dict[str, Any]]:
    limit_raw = os.environ.get("PERF_URL_LIMIT", "")
    if limit_raw.isdigit() and int(limit_raw) > 0:
        return watchlist["urls"][: int(limit_raw)]

    explicit_ids = {
        value.strip()
        for value in os.environ.get("PERF_URL_IDS", "").split(",")
        if value.strip()
    }
    if explicit_ids:
        return [
            entry
            for entry in watchlist["urls"]
            if entry["id"] in explicit_ids or entry["path"] in explicit_ids
        ]
    return watchlist["urls"]


def create_tables(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS speed_index_runs (
            id SERIAL PRIMARY KEY,
            run_id TEXT UNIQUE NOT NULL,
            source TEXT NOT NULL,
            source_label TEXT NOT NULL,
            status TEXT NOT NULL,
            origin TEXT NOT NULL,
            devices JSONB NOT NULL DEFAULT '[]'::jsonb,
            url_count INTEGER NOT NULL DEFAULT 0,
            runs_requested INTEGER NOT NULL DEFAULT 1,
            success_count INTEGER NOT NULL DEFAULT 0,
            failure_count INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            summary JSONB,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS speed_index_samples (
            id SERIAL PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES speed_index_runs(run_id) ON DELETE CASCADE,
            page_id TEXT NOT NULL,
            path TEXT NOT NULL,
            url TEXT NOT NULL,
            label TEXT NOT NULL,
            page_group TEXT NOT NULL,
            device TEXT NOT NULL,
            strategy TEXT NOT NULL,
            sample_index INTEGER NOT NULL,
            ok BOOLEAN NOT NULL DEFAULT FALSE,
            collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            performance_score NUMERIC,
            fcp_ms NUMERIC,
            lcp_ms NUMERIC,
            speed_index_ms NUMERIC,
            tbt_ms NUMERIC,
            cls NUMERIC,
            ttfb_ms NUMERIC,
            total_bytes BIGINT,
            request_count INTEGER,
            js_bytes BIGINT,
            image_bytes BIGINT,
            third_party_bytes BIGINT,
            metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
            raw_response JSONB,
            error JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (run_id, page_id, device, sample_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS speed_index_url_results (
            id SERIAL PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES speed_index_runs(run_id) ON DELETE CASCADE,
            page_id TEXT NOT NULL,
            path TEXT NOT NULL,
            url TEXT NOT NULL,
            label TEXT NOT NULL,
            page_group TEXT NOT NULL,
            device TEXT NOT NULL,
            strategy TEXT NOT NULL,
            source TEXT NOT NULL,
            source_label TEXT NOT NULL,
            runs_requested INTEGER NOT NULL DEFAULT 1,
            success_count INTEGER NOT NULL DEFAULT 0,
            failure_count INTEGER NOT NULL DEFAULT 0,
            collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            performance_score NUMERIC,
            fcp_ms NUMERIC,
            lcp_ms NUMERIC,
            speed_index_ms NUMERIC,
            tbt_ms NUMERIC,
            cls NUMERIC,
            ttfb_ms NUMERIC,
            total_bytes BIGINT,
            request_count INTEGER,
            js_bytes BIGINT,
            image_bytes BIGINT,
            third_party_bytes BIGINT,
            median JSONB NOT NULL DEFAULT '{}'::jsonb,
            average JSONB,
            stats JSONB,
            representative_sample_index INTEGER,
            representative_raw_response JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (run_id, page_id, device)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_speed_index_runs_status_time ON speed_index_runs(status, finished_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_speed_index_results_page_device ON speed_index_url_results(page_id, device)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_speed_index_samples_run ON speed_index_samples(run_id)")


def grant_app_access(conn, principal: str = APP_PRINCIPAL) -> None:
    tables = ("speed_index_runs", "speed_index_samples", "speed_index_url_results")
    for table in tables:
        conn.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {table} TO "{principal}"')
        conn.execute(f'GRANT USAGE, SELECT ON SEQUENCE {table}_id_seq TO "{principal}"')


async def fetch_pagespeed(url: str, device: str, api_key: str, timeout: float = 180.0) -> dict[str, Any]:
    params = {
        "url": url,
        "strategy": "desktop" if device == "desktop" else "mobile",
        "category": "performance",
    }
    if api_key:
        params["key"] = api_key
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", params=params)
    body = response.json()
    if response.status_code >= 400 or body.get("error"):
        message = body.get("error", {}).get("message") or f"PageSpeed API returned {response.status_code}"
        raise RuntimeError(message)
    return body


def extract_pagespeed_metrics(body: dict[str, Any]) -> dict[str, Any]:
    lhr = body.get("lighthouseResult") or {}
    audits = lhr.get("audits") or {}
    resource_items = details_items(audits, "resource-summary")
    network_items = details_items(audits, "network-requests")
    third_party_items = details_items(audits, "third-party-summary")
    lcp_element = (details_items(audits, "largest-contentful-paint-element") or [{}])[0].get("node")
    network_transfer = sum(coerce_number(item.get("transferSize")) or 0 for item in network_items)
    third_party_bytes = (
        sum(coerce_number(item.get("transferSize")) or 0 for item in third_party_items)
        or resource_bytes(resource_items, "third-party")
    )
    return {
        "performanceScore": coerce_number((lhr.get("categories") or {}).get("performance", {}).get("score")),
        "fcp": audit_number(audits, "first-contentful-paint"),
        "lcp": audit_number(audits, "largest-contentful-paint"),
        "speedIndex": audit_number(audits, "speed-index"),
        "tbt": audit_number(audits, "total-blocking-time"),
        "cls": audit_number(audits, "cumulative-layout-shift"),
        "ttfb": audit_number(audits, "server-response-time") or audit_number(audits, "time-to-first-byte"),
        "totalBytes": audit_number(audits, "total-byte-weight") or network_transfer,
        "requestCount": len(network_items) or None,
        "jsBytes": resource_bytes(resource_items, "script"),
        "imageBytes": resource_bytes(resource_items, "image"),
        "thirdPartyBytes": third_party_bytes,
        "lcpElement": normalize_lcp_element(lcp_element),
        "resourceSummary": [
            {
                "resourceType": item.get("resourceType"),
                "requestCount": coerce_number(item.get("requestCount")) or 0,
                "transferSize": coerce_number(item.get("transferSize")) or 0,
            }
            for item in resource_items
        ],
        "thirdPartySummary": [
            {
                "entity": item.get("entity") or item.get("name") or "Unknown",
                "transferSize": coerce_number(item.get("transferSize")) or 0,
                "blockingTime": coerce_number(item.get("blockingTime")) or 0,
                "mainThreadTime": coerce_number(item.get("mainThreadTime")) or 0,
            }
            for item in third_party_items[:12]
        ],
        "topRequests": top_network_requests(network_items),
        "domainSummary": domain_summary(network_items),
        "opportunities": opportunity_summary(audits),
        "mainThreadBreakdown": [
            {
                "group": item.get("group"),
                "label": item.get("groupLabel") or item.get("group") or "Other",
                "duration": coerce_number(item.get("duration")) or 0,
            }
            for item in details_items(audits, "mainthread-work-breakdown")
        ],
        "bootupScripts": sorted(
            [
                {
                    "url": item.get("url"),
                    "host": host_for_url(item.get("url")),
                    "total": coerce_number(item.get("total")) or 0,
                    "scripting": coerce_number(item.get("scripting")) or 0,
                    "scriptParseCompile": coerce_number(item.get("scriptParseCompile")) or 0,
                }
                for item in details_items(audits, "bootup-time")
            ],
            key=lambda item: item["total"],
            reverse=True,
        )[:12],
    }


def aggregate_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    successful = [sample for sample in samples if sample.get("ok") and sample.get("metrics")]
    median_metrics = {
        key: safe_median([sample["metrics"].get(key) for sample in successful])
        for key in METRIC_KEYS
    }
    average_metrics = {
        key: safe_average([sample["metrics"].get(key) for sample in successful])
        for key in METRIC_KEYS
    }
    stats = {
        key: metric_stats([sample["metrics"].get(key) for sample in successful])
        for key in METRIC_KEYS
    }
    representative = representative_sample(successful, median_metrics)
    representative_metrics = representative.get("metrics") if representative else {}
    return {
        "successCount": len(successful),
        "failureCount": len(samples) - len(successful),
        "median": {
            **median_metrics,
            "lcpElement": representative_metrics.get("lcpElement"),
            "resourceSummary": representative_metrics.get("resourceSummary") or [],
            "thirdPartySummary": representative_metrics.get("thirdPartySummary") or [],
            "topRequests": representative_metrics.get("topRequests") or [],
            "domainSummary": representative_metrics.get("domainSummary") or [],
            "opportunities": representative_metrics.get("opportunities") or [],
            "mainThreadBreakdown": representative_metrics.get("mainThreadBreakdown") or [],
            "bootupScripts": representative_metrics.get("bootupScripts") or [],
        },
        "average": average_metrics if len(successful) > 1 else None,
        "stats": stats if len(successful) > 1 else None,
        "representative": representative,
    }


def start_run(conn, *, run_id: str, watchlist: dict[str, Any], devices: list[str], pages: list[dict[str, Any]], runs_requested: int) -> None:
    conn.execute("DELETE FROM speed_index_samples WHERE run_id = %s", (run_id,))
    conn.execute("DELETE FROM speed_index_url_results WHERE run_id = %s", (run_id,))
    conn.execute(
        """
        INSERT INTO speed_index_runs
          (run_id, source, source_label, status, origin, devices, url_count, runs_requested,
           success_count, failure_count, started_at, updated_at)
        VALUES (%s, %s, %s, 'running', %s, %s, %s, %s, 0, 0, NOW(), NOW())
        ON CONFLICT (run_id) DO UPDATE SET
          source = EXCLUDED.source,
          source_label = EXCLUDED.source_label,
          status = 'running',
          origin = EXCLUDED.origin,
          devices = EXCLUDED.devices,
          url_count = EXCLUDED.url_count,
          runs_requested = EXCLUDED.runs_requested,
          success_count = 0,
          failure_count = 0,
          error = NULL,
          summary = NULL,
          started_at = NOW(),
          finished_at = NULL,
          updated_at = NOW()
        """,
        (run_id, SOURCE, SOURCE_LABEL, watchlist["origin"], Jsonb(devices), len(pages), runs_requested),
    )


def insert_sample(conn, *, run_id: str, page: dict[str, Any], device: str, sample_index: int, ok: bool, metrics: dict[str, Any] | None = None, raw_response: dict[str, Any] | None = None, error: dict[str, Any] | None = None) -> None:
    metrics = metrics or {}
    conn.execute(
        """
        INSERT INTO speed_index_samples
          (run_id, page_id, path, url, label, page_group, device, strategy, sample_index, ok,
           performance_score, fcp_ms, lcp_ms, speed_index_ms, tbt_ms, cls, ttfb_ms,
           total_bytes, request_count, js_bytes, image_bytes, third_party_bytes,
           metrics, raw_response, error, collected_at)
        VALUES
          (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
           %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (run_id, page_id, device, sample_index) DO UPDATE SET
          ok = EXCLUDED.ok,
          performance_score = EXCLUDED.performance_score,
          fcp_ms = EXCLUDED.fcp_ms,
          lcp_ms = EXCLUDED.lcp_ms,
          speed_index_ms = EXCLUDED.speed_index_ms,
          tbt_ms = EXCLUDED.tbt_ms,
          cls = EXCLUDED.cls,
          ttfb_ms = EXCLUDED.ttfb_ms,
          total_bytes = EXCLUDED.total_bytes,
          request_count = EXCLUDED.request_count,
          js_bytes = EXCLUDED.js_bytes,
          image_bytes = EXCLUDED.image_bytes,
          third_party_bytes = EXCLUDED.third_party_bytes,
          metrics = EXCLUDED.metrics,
          raw_response = EXCLUDED.raw_response,
          error = EXCLUDED.error,
          collected_at = NOW()
        """,
        (
            run_id,
            page["id"],
            page["path"],
            page["url"],
            page["label"],
            page["group"],
            device,
            "desktop" if device == "desktop" else "mobile",
            sample_index,
            ok,
            metrics.get("performanceScore"),
            metrics.get("fcp"),
            metrics.get("lcp"),
            metrics.get("speedIndex"),
            metrics.get("tbt"),
            metrics.get("cls"),
            metrics.get("ttfb"),
            int(metrics["totalBytes"]) if metrics.get("totalBytes") is not None else None,
            int(metrics["requestCount"]) if metrics.get("requestCount") is not None else None,
            int(metrics["jsBytes"]) if metrics.get("jsBytes") is not None else None,
            int(metrics["imageBytes"]) if metrics.get("imageBytes") is not None else None,
            int(metrics["thirdPartyBytes"]) if metrics.get("thirdPartyBytes") is not None else None,
            Jsonb(metrics),
            Jsonb(raw_response) if raw_response is not None else None,
            Jsonb(error) if error is not None else None,
        ),
    )


def upsert_url_result(conn, *, run_id: str, page: dict[str, Any], device: str, runs_requested: int, aggregate: dict[str, Any], store_raw: bool) -> None:
    metrics = aggregate["median"]
    representative = aggregate.get("representative") or {}
    raw = representative.get("raw") if store_raw else None
    conn.execute(
        """
        INSERT INTO speed_index_url_results
          (run_id, page_id, path, url, label, page_group, device, strategy, source, source_label,
           runs_requested, success_count, failure_count, performance_score, fcp_ms, lcp_ms,
           speed_index_ms, tbt_ms, cls, ttfb_ms, total_bytes, request_count, js_bytes,
           image_bytes, third_party_bytes, median, average, stats, representative_sample_index,
           representative_raw_response, collected_at, updated_at)
        VALUES
          (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
           %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
        ON CONFLICT (run_id, page_id, device) DO UPDATE SET
          success_count = EXCLUDED.success_count,
          failure_count = EXCLUDED.failure_count,
          performance_score = EXCLUDED.performance_score,
          fcp_ms = EXCLUDED.fcp_ms,
          lcp_ms = EXCLUDED.lcp_ms,
          speed_index_ms = EXCLUDED.speed_index_ms,
          tbt_ms = EXCLUDED.tbt_ms,
          cls = EXCLUDED.cls,
          ttfb_ms = EXCLUDED.ttfb_ms,
          total_bytes = EXCLUDED.total_bytes,
          request_count = EXCLUDED.request_count,
          js_bytes = EXCLUDED.js_bytes,
          image_bytes = EXCLUDED.image_bytes,
          third_party_bytes = EXCLUDED.third_party_bytes,
          median = EXCLUDED.median,
          average = EXCLUDED.average,
          stats = EXCLUDED.stats,
          representative_sample_index = EXCLUDED.representative_sample_index,
          representative_raw_response = EXCLUDED.representative_raw_response,
          updated_at = NOW()
        """,
        (
            run_id,
            page["id"],
            page["path"],
            page["url"],
            page["label"],
            page["group"],
            device,
            "desktop" if device == "desktop" else "mobile",
            SOURCE,
            SOURCE_LABEL,
            runs_requested,
            aggregate["successCount"],
            aggregate["failureCount"],
            metrics.get("performanceScore"),
            metrics.get("fcp"),
            metrics.get("lcp"),
            metrics.get("speedIndex"),
            metrics.get("tbt"),
            metrics.get("cls"),
            metrics.get("ttfb"),
            int(metrics["totalBytes"]) if metrics.get("totalBytes") is not None else None,
            int(metrics["requestCount"]) if metrics.get("requestCount") is not None else None,
            int(metrics["jsBytes"]) if metrics.get("jsBytes") is not None else None,
            int(metrics["imageBytes"]) if metrics.get("imageBytes") is not None else None,
            int(metrics["thirdPartyBytes"]) if metrics.get("thirdPartyBytes") is not None else None,
            Jsonb(metrics),
            Jsonb(aggregate.get("average")) if aggregate.get("average") is not None else None,
            Jsonb(aggregate.get("stats")) if aggregate.get("stats") is not None else None,
            representative.get("sampleIndex"),
            Jsonb(raw) if raw is not None else None,
        ),
    )


def finish_run(conn, *, run_id: str, success_count: int, failure_count: int, summary: dict[str, Any] | None = None, error: str | None = None) -> None:
    status = "failed" if error and not success_count else "completed_with_errors" if failure_count else "completed"
    conn.execute(
        """
        UPDATE speed_index_runs
        SET status = %s,
            success_count = %s,
            failure_count = %s,
            error = %s,
            summary = %s,
            finished_at = COALESCE(finished_at, NOW()),
            updated_at = NOW()
        WHERE run_id = %s
        """,
        (status, success_count, failure_count, error, Jsonb(summary) if summary is not None else None, run_id),
    )


def latest_summary_from_db(conn) -> dict[str, Any] | None:
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
    return row[0] if row and row[0] is not None else None


def build_summary_from_db(conn, watchlist: dict[str, Any]) -> dict[str, Any]:
    with conn.cursor(row_factory=dict_row) as cur:
        runs = cur.execute(
            """
            SELECT run_id, source, source_label, status, started_at, finished_at, devices,
                   url_count, runs_requested, success_count, failure_count
            FROM speed_index_runs
            WHERE status IN ('completed', 'completed_with_errors')
            ORDER BY finished_at ASC NULLS LAST, started_at ASC
            """
        ).fetchall()
        results = cur.execute(
            """
            SELECT run_id, page_id, path, url, label, page_group, device, strategy, source,
                   source_label, runs_requested, success_count, failure_count, collected_at,
                   performance_score, fcp_ms, lcp_ms, speed_index_ms, tbt_ms, cls, ttfb_ms,
                   total_bytes, request_count, js_bytes, image_bytes, third_party_bytes,
                   median, average, stats
            FROM speed_index_url_results
            ORDER BY collected_at ASC, run_id ASC
            """
        ).fetchall()

    run_log = [normalize_run_log(row) for row in runs]
    latest_run = run_log[-1] if run_log else None
    results_by_target: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in results:
        results_by_target.setdefault((row["page_id"], row["device"]), []).append(row)

    pages = []
    for page in watchlist["urls"]:
        lab = {}
        field = {}
        for device in watchlist["defaultDevices"]:
            history_rows = results_by_target.get((page["id"], device), [])
            history = [history_snapshot(row) for row in history_rows]
            latest = history[-1] if history else None
            previous = history[-2] if len(history) > 1 else None
            field[device] = {
                "state": "not-collected",
                "status": "unknown",
                "message": "field metrics hidden for now",
                "latest": {},
                "trend": [],
            }
            lab[device] = lab_entry(latest, previous, history)
        pages.append(
            {
                "id": page["id"],
                "path": page["path"],
                "url": page["url"],
                "label": page["label"],
                "group": page["group"],
                "priority": page["priority"],
                "tags": page.get("tags", []),
                "field": field,
                "lab": lab,
            }
        )

    insights = build_insights(pages, watchlist["defaultDevices"])
    generated_at = iso_now()
    return {
        "meta": {
            "generatedAt": generated_at,
            "origin": watchlist["origin"],
            "watchlistCount": len(watchlist["urls"]),
            "devices": watchlist["defaultDevices"],
            "sources": {
                "field": "Hidden in current dashboard",
                "lab": "PageSpeed Insights API stored in Lakebase",
            },
            "thresholds": {
                "field": field_thresholds(),
                "labRegression": lab_regression_rules(),
            },
            "latestLabRunId": latest_run["runId"] if latest_run else None,
            "lighthouseBaselineRunId": None,
            "latestCruxCollectionPeriod": None,
            "runtime": {"storage": "lakebase"},
        },
        "overview": {
            "originField": {},
            "fieldGapCount": 0,
            "labRegressionCount": 0,
            "labRunCount": sum(run["successCount"] for run in run_log),
            "cruxRecordCount": 0,
            "fieldGaps": [],
            "regressions": [],
        },
        "baselines": [],
        "insights": insights,
        "runs": {"lab": run_log},
        "pages": pages,
        "trends": {"origin": {}},
    }


def normalize_run_log(row: dict[str, Any]) -> dict[str, Any]:
    median_count = int(row["url_count"] or 0) * len(row["devices"] or [])
    success_count = int(row["success_count"] or 0)
    return {
        "runId": row["run_id"],
        "collectedAt": to_iso(row["finished_at"] or row["started_at"]),
        "source": row["source"],
        "sourceLabel": row["source_label"],
        "baseline": False,
        "pageCount": int(row["url_count"] or 0),
        "devices": row["devices"] or [],
        "medianCount": median_count,
        "multiSampleMedians": median_count if int(row["runs_requested"] or 0) > 1 else 0,
        "singleSampleMedians": 0 if int(row["runs_requested"] or 0) > 1 else median_count,
        "sampleQuality": "multi-sample" if int(row["runs_requested"] or 0) > 1 else "single-sample",
        "averageRunsPerMedian": success_count / median_count if median_count else None,
        "successCount": success_count,
        "failureCount": int(row["failure_count"] or 0),
        "runsRequested": int(row["runs_requested"] or 0),
    }


def history_snapshot(row: dict[str, Any]) -> dict[str, Any]:
    median_payload = row["median"] or {}
    return {
        "runId": row["run_id"],
        "collectedAt": to_iso(row["collected_at"]),
        "source": row["source"],
        "sourceLabel": row["source_label"],
        "successCount": int(row["success_count"] or 0),
        "failureCount": int(row["failure_count"] or 0),
        "runsRequested": int(row["runs_requested"] or 0),
        "sampleQuality": "multi-sample" if int(row["success_count"] or 0) > 1 else "single-sample",
        "fcp": num(row["fcp_ms"]),
        "lcp": num(row["lcp_ms"]),
        "speedIndex": num(row["speed_index_ms"]),
        "tbt": num(row["tbt_ms"]),
        "cls": num(row["cls"]),
        "ttfb": num(row["ttfb_ms"]),
        "performanceScore": num(row["performance_score"]),
        "totalBytes": num(row["total_bytes"]),
        "requestCount": num(row["request_count"]),
        "jsBytes": num(row["js_bytes"]),
        "imageBytes": num(row["image_bytes"]),
        "thirdPartyBytes": num(row["third_party_bytes"]),
        "resourceSummary": median_payload.get("resourceSummary") or [],
        "domainSummary": (median_payload.get("domainSummary") or [])[:12],
        "opportunities": (median_payload.get("opportunities") or [])[:8],
        "topRequests": (median_payload.get("topRequests") or [])[:24],
        "bootupScripts": (median_payload.get("bootupScripts") or [])[:12],
        "mainThreadBreakdown": median_payload.get("mainThreadBreakdown") or [],
        "lcpElement": median_payload.get("lcpElement"),
        "average": row["average"],
        "stats": row["stats"],
    }


def lab_entry(latest: dict[str, Any] | None, previous: dict[str, Any] | None, history: list[dict[str, Any]]) -> dict[str, Any]:
    if latest is None:
        return {
            "state": "not-collected",
            "status": "unknown",
            "message": "no PageSpeed Insights run",
            "latest": None,
            "baseline": None,
            "history": [],
            "regressions": [],
        }
    comparison = None
    if previous:
        comparison = {
            "previous": previous,
            "latest": latest,
            "delta": compare_lab_snapshots(latest, previous),
            "drivers": change_drivers(latest, previous),
        }
    return {
        "state": "ok" if latest["successCount"] else "failed",
        "status": lab_status(latest, []),
        "message": None if latest["successCount"] else "all PageSpeed Insights runs failed",
        "runId": latest["runId"],
        "collectedAt": latest["collectedAt"],
        "source": latest["source"],
        "sourceLabel": latest["sourceLabel"],
        "successCount": latest["successCount"],
        "failureCount": latest["failureCount"],
        "runsRequested": latest["runsRequested"],
        "sampleQuality": latest["sampleQuality"],
        "average": latest.get("average"),
        "stats": latest.get("stats"),
        "latest": latest,
        "baseline": None,
        "history": history,
        "comparison": comparison,
        "regressions": [],
    }


def build_insights(pages: list[dict[str, Any]], devices: list[str]) -> dict[str, Any]:
    rows = []
    for page in pages:
        for device in devices:
            lab = page["lab"].get(device) or {}
            latest = lab.get("latest") or {}
            if lab.get("state") == "ok":
                rows.append({"page": page, "device": device, "lab": lab, "latest": latest})
    return {
        "fixQueue": build_fix_queue(rows),
        "hostRollups": [],
        "resourceRollups": [],
        "opportunityRollups": [],
        "scriptRollups": [],
        "templateRollups": [],
    }


def build_fix_queue(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    definitions = [
        ("lcp-delivery", "LCP", "Fix above-the-fold LCP delivery", "Prioritize the visible LCP element and reduce competing above-fold work.", lambda r: metric(r, "lcp") > 4000, lambda r: business_weight(r["page"]) + clamp((metric(r, "lcp") - 4000) / 1000 * 14, 0, 90)),
        ("js-main-thread", "JS/TBT", "Reduce script and main-thread pressure", "Defer non-critical scripts and delay marketing/vendor work until after initial render.", lambda r: metric(r, "tbt") > 600, lambda r: business_weight(r["page"]) + clamp(metric(r, "tbt") / 100 * 5, 0, 90)),
        ("page-weight", "Weight", "Cut oversized page payloads", "Reduce large media, trim shared bundles, and remove unused resources.", lambda r: metric(r, "totalBytes") > 5 * 1024 * 1024, lambda r: business_weight(r["page"]) + clamp((metric(r, "totalBytes") - 5 * 1024 * 1024) / (1024 * 1024) * 14, 0, 90)),
        ("request-count", "Requests", "Consolidate high request-count pages", "Remove low-value third-party calls and reduce template-level asset fanout.", lambda r: metric(r, "requestCount") > 100, lambda r: business_weight(r["page"]) + clamp((metric(r, "requestCount") - 100) / 10 * 8, 0, 80)),
        ("image-delivery", "Images", "Optimize image and animated media delivery", "Resize responsive images, convert legacy formats, and lazy-load below-fold media.", lambda r: metric(r, "imageBytes") > 2 * 1024 * 1024, lambda r: business_weight(r["page"]) + clamp(metric(r, "imageBytes") / (1024 * 1024) * 16, 0, 80)),
        ("third-party", "Third-party", "Govern third-party and tag-manager load", "Audit GTM destinations, delay non-critical vendors, and remove duplicate tags.", lambda r: metric(r, "thirdPartyBytes") > 1.5 * 1024 * 1024, lambda r: business_weight(r["page"]) + clamp(metric(r, "thirdPartyBytes") / (1024 * 1024) * 18, 0, 90)),
    ]
    fixes = []
    for fix_id, category, title, action, predicate, score in definitions:
        affected_rows = [row for row in rows if predicate(row)]
        if not affected_rows:
            continue
        affected = sorted(
            [
                {
                    "pageId": row["page"]["id"],
                    "label": row["page"]["label"],
                    "path": row["page"]["path"],
                    "group": row["page"]["group"],
                    "device": row["device"],
                    "rowImpact": round(score(row)),
                    "lcp": metric(row, "lcp"),
                    "tbt": metric(row, "tbt"),
                    "totalBytes": metric(row, "totalBytes"),
                }
                for row in affected_rows
            ],
            key=lambda item: item["rowImpact"],
            reverse=True,
        )
        fixes.append(
            {
                "id": fix_id,
                "category": category,
                "title": title,
                "recommendedAction": action,
                "impact": round(sum(item["rowImpact"] for item in affected)),
                "confidence": "high" if all((row["lab"].get("successCount") or 0) >= 3 for row in affected_rows) else "medium",
                "affectedPages": len({row["page"]["id"] for row in affected_rows}),
                "affectedRows": len(affected),
                "affected": affected,
                "devices": sorted({row["device"] for row in affected_rows}),
                "groups": sorted({row["page"]["group"] for row in affected_rows}),
                "pageIds": sorted({row["page"]["id"] for row in affected_rows}),
                "metrics": {},
                "topEvidence": affected[:6],
                "topHosts": [],
                "topOpportunities": [],
            }
        )
    return sorted(fixes, key=lambda item: item["impact"], reverse=True)[:8]


def compare_lab_snapshots(latest: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    keys = ("performanceScore", "fcp", "lcp", "speedIndex", "tbt", "cls", "ttfb", "totalBytes", "requestCount", "jsBytes", "imageBytes", "thirdPartyBytes")
    output = {}
    for key in keys:
        latest_value = coerce_number(latest.get(key))
        previous_value = coerce_number(previous.get(key))
        if latest_value is None or previous_value is None:
            output[key] = {"latest": latest_value, "previous": previous_value, "delta": None, "ratio": None}
            continue
        delta = latest_value - previous_value
        output[key] = {
            "latest": latest_value,
            "previous": previous_value,
            "delta": delta,
            "ratio": delta / previous_value if previous_value else None,
        }
    return output


def change_drivers(latest: dict[str, Any], previous: dict[str, Any]) -> list[dict[str, Any]]:
    delta = compare_lab_snapshots(latest, previous)
    rules = (
        ("lcp", "LCP", "ms", 300, 1),
        ("fcp", "FCP", "ms", 300, 1),
        ("speedIndex", "Speed Index", "ms", 300, 1),
        ("tbt", "TBT", "ms", 100, 1),
        ("ttfb", "TTFB", "ms", 100, 1),
        ("totalBytes", "Total bytes", "bytes", 250 * 1024, 1),
        ("requestCount", "Requests", "count", 10, 1),
        ("jsBytes", "JS bytes", "bytes", 150 * 1024, 1),
        ("imageBytes", "Image bytes", "bytes", 250 * 1024, 1),
        ("thirdPartyBytes", "Third-party bytes", "bytes", 150 * 1024, 1),
        ("performanceScore", "Score", "score", 0.05, -1),
        ("cls", "CLS", "score", 0.02, 1),
    )
    drivers = []
    for key, label, unit, threshold, worse_direction in rules:
        item = delta.get(key) or {}
        item_delta = item.get("delta")
        if item_delta is None or abs(item_delta) < threshold:
            continue
        worse = item_delta < 0 if worse_direction == -1 else item_delta > 0
        drivers.append(
            {
                "type": "worse" if worse else "improved",
                "metric": key,
                "label": label,
                "unit": unit,
                "previous": item.get("previous"),
                "latest": item.get("latest"),
                "delta": item_delta,
                "ratio": item.get("ratio"),
            }
        )
    return sorted(drivers, key=lambda item: abs(item["delta"] or 0), reverse=True)[:12]


def lab_status(latest: dict[str, Any], regressions: list[dict[str, Any]]) -> str:
    if regressions:
        return "regression"
    return worst_status([
        classify_field_metric("lcp", latest.get("lcp")),
        classify_field_metric("cls", latest.get("cls")),
        "good" if (latest.get("tbt") or 0) <= 200 else "needs-improvement" if (latest.get("tbt") or 0) <= 600 else "poor",
    ])


def classify_field_metric(metric_key: str, value: Any) -> str:
    thresholds = field_thresholds().get(metric_key)
    value = coerce_number(value)
    if thresholds is None or value is None:
        return "unknown"
    if value <= thresholds["good"]:
        return "good"
    if value <= thresholds["needsImprovement"]:
        return "needs-improvement"
    return "poor"


def field_thresholds() -> dict[str, dict[str, Any]]:
    return {
        "lcp": {"good": 2500, "needsImprovement": 4000, "unit": "ms"},
        "inp": {"good": 200, "needsImprovement": 500, "unit": "ms"},
        "cls": {"good": 0.1, "needsImprovement": 0.25, "unit": "score"},
        "fcp": {"good": 1800, "needsImprovement": 3000, "unit": "ms"},
        "ttfb": {"good": 800, "needsImprovement": 1800, "unit": "ms"},
    }


def lab_regression_rules() -> dict[str, dict[str, Any]]:
    return {
        "fcp": {"label": "FCP", "minRatio": 0.2, "minDelta": 300, "unit": "ms"},
        "lcp": {"label": "LCP", "minRatio": 0.2, "minDelta": 300, "unit": "ms"},
        "speedIndex": {"label": "Speed Index", "minRatio": 0.2, "minDelta": 300, "unit": "ms"},
        "tbt": {"label": "TBT", "minRatio": 0.2, "minDelta": 100, "unit": "ms"},
        "totalBytes": {"label": "Total bytes", "minRatio": 0.15, "minDelta": 0, "unit": "bytes"},
    }


def audit_number(audits: dict[str, Any], audit_id: str) -> float | None:
    return coerce_number((audits.get(audit_id) or {}).get("numericValue"))


def details_items(audits: dict[str, Any], audit_id: str) -> list[dict[str, Any]]:
    return ((audits.get(audit_id) or {}).get("details") or {}).get("items") or []


def resource_bytes(items: list[dict[str, Any]], resource_type: str) -> int:
    for item in items:
        if item.get("resourceType") == resource_type:
            return int(coerce_number(item.get("transferSize")) or 0)
    return 0


def normalize_lcp_element(element: dict[str, Any] | None) -> dict[str, Any] | None:
    if not element:
        return None
    return {
        "snippet": element.get("snippet"),
        "selector": element.get("selector"),
        "path": element.get("path"),
        "nodeLabel": element.get("nodeLabel"),
    }


def top_network_requests(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for item in items:
        transfer_size = coerce_number(item.get("transferSize")) or 0
        if not item.get("url") or transfer_size <= 0:
            continue
        rows.append(
            {
                "url": item.get("url"),
                "host": host_for_url(item.get("url")),
                "transferSize": transfer_size,
                "resourceSize": coerce_number(item.get("resourceSize")) or 0,
                "resourceType": item.get("resourceType") or "Other",
                "mimeType": item.get("mimeType"),
                "statusCode": coerce_number(item.get("statusCode")),
                "priority": item.get("priority"),
                "protocol": item.get("protocol"),
            }
        )
    return sorted(rows, key=lambda row: row["transferSize"], reverse=True)[:24]


def domain_summary(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    domains: dict[str, dict[str, Any]] = {}
    for item in items:
        host = host_for_url(item.get("url"))
        if not host:
            continue
        current = domains.setdefault(host, {"host": host, "requestCount": 0, "transferSize": 0, "resourceSize": 0, "types": {}})
        current["requestCount"] += 1
        current["transferSize"] += coerce_number(item.get("transferSize")) or 0
        current["resourceSize"] += coerce_number(item.get("resourceSize")) or 0
        resource_type = item.get("resourceType") or "Other"
        current["types"][resource_type] = current["types"].get(resource_type, 0) + 1
    return sorted(domains.values(), key=lambda row: row["transferSize"], reverse=True)[:16]


def opportunity_summary(audits: dict[str, Any]) -> list[dict[str, Any]]:
    opportunity_audits = (
        ("total-byte-weight", "Network payload"),
        ("unused-javascript", "Unused JavaScript"),
        ("unused-css-rules", "Unused CSS"),
        ("render-blocking-resources", "Render blocking"),
        ("uses-responsive-images", "Responsive images"),
        ("modern-image-formats", "Image format"),
        ("efficient-animated-content", "Animated media"),
        ("unminified-javascript", "Unminified JS"),
        ("unminified-css", "Unminified CSS"),
    )
    rows = []
    for audit_id, label in opportunity_audits:
        audit = audits.get(audit_id) or {}
        items = details_items(audits, audit_id)
        if not items:
            continue
        rows.append(
            {
                "id": audit_id,
                "label": label,
                "title": audit.get("title") or label,
                "score": coerce_number(audit.get("score")),
                "numericValue": coerce_number(audit.get("numericValue")),
                "items": sorted(
                    [
                        {
                            "url": item.get("url"),
                            "host": host_for_url(item.get("url")),
                            "totalBytes": coerce_number(item.get("totalBytes")) or coerce_number(item.get("transferSize")) or 0,
                            "wastedBytes": coerce_number(item.get("wastedBytes")) or 0,
                            "wastedMs": coerce_number(item.get("wastedMs")) or 0,
                            "wastedPercent": coerce_number(item.get("wastedPercent")),
                        }
                        for item in items
                        if item.get("url")
                    ],
                    key=lambda row: row["wastedBytes"] or row["totalBytes"] or row["wastedMs"],
                    reverse=True,
                )[:10],
            }
        )
    return rows


def representative_sample(samples: list[dict[str, Any]], median_metrics: dict[str, Any]) -> dict[str, Any] | None:
    if not samples:
        return None
    median_lcp = median_metrics.get("lcp") or 0
    return sorted(samples, key=lambda sample: abs((sample["metrics"].get("lcp") or 0) - median_lcp))[0]


def metric_stats(values: list[Any]) -> dict[str, Any]:
    clean = clean_numbers(values)
    if not clean:
        return {"sampleCount": 0, "average": None, "median": None, "min": None, "max": None, "stddev": None}
    avg = mean(clean)
    variance = mean([(value - avg) ** 2 for value in clean])
    return {
        "sampleCount": len(clean),
        "average": avg,
        "median": median(clean),
        "min": min(clean),
        "max": max(clean),
        "stddev": math.sqrt(variance),
    }


def safe_median(values: list[Any]) -> float | None:
    clean = clean_numbers(values)
    return median(clean) if clean else None


def safe_average(values: list[Any]) -> float | None:
    clean = clean_numbers(values)
    return mean(clean) if clean else None


def clean_numbers(values: list[Any]) -> list[float]:
    return [float(value) for value in values if coerce_number(value) is not None]


def coerce_number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def num(value: Any) -> int | float | None:
    number = coerce_number(value)
    if number is None:
        return None
    return int(number) if number.is_integer() else number


def metric(row: dict[str, Any], key: str) -> float:
    return coerce_number(row["latest"].get(key)) or 0


def business_weight(page: dict[str, Any]) -> float:
    priority = coerce_number(page.get("priority")) or 3
    return max(0, 5 - priority) * 8


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def worst_status(statuses: list[str]) -> str:
    rank = {"poor": 4, "needs-improvement": 3, "unknown": 2, "good": 1}
    return sorted([status for status in statuses if status], key=lambda status: rank.get(status, 0), reverse=True)[0]


def host_for_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        return urlparse(url).hostname.removeprefix("www.")
    except Exception:
        return None


def to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    return str(value)


def hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
