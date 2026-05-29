#!/usr/bin/env python3
"""Collect PageSpeed Insights samples and publish the Speed Index summary to Lakebase."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from lakebase import get_connection  # noqa: E402
from speed_index_lakebase import (  # noqa: E402
    aggregate_samples,
    build_summary_from_db,
    create_tables,
    extract_pagespeed_metrics,
    fetch_pagespeed,
    finish_run,
    insert_sample,
    iso_now,
    load_watchlist,
    normalize_devices,
    selected_watchlist_urls,
    start_run,
    timestamp_for_run,
    upsert_url_result,
)


async def collect(args: argparse.Namespace) -> None:
    configure_lakebase_env(args)
    watchlist = load_watchlist()
    devices = normalize_devices(args.devices or os.environ.get("PERF_DEVICES"), watchlist["defaultDevices"])
    pages = selected_watchlist_urls(watchlist)
    runs_requested = max(1, args.runs or int(os.environ.get("PAGESPEED_RUNS") or os.environ.get("PSI_RUNS") or "3"))
    api_key = args.api_key or os.environ.get("PAGESPEED_API_KEY") or os.environ.get("PSI_API_KEY") or os.environ.get("CRUX_API_KEY") or ""
    run_id = args.run_id or os.environ.get("PERF_RUN_ID") or timestamp_for_run()
    store_raw = args.store_raw or os.environ.get("SPEED_INDEX_STORE_RAW", "").lower() in {"1", "true", "yes"}

    if not api_key:
        raise SystemExit("Set PAGESPEED_API_KEY, PSI_API_KEY, or CRUX_API_KEY before running the PageSpeed collector.")

    conn = get_connection()
    success_count = 0
    failure_count = 0
    try:
        create_tables(conn)
        start_run(conn, run_id=run_id, watchlist=watchlist, devices=devices, pages=pages, runs_requested=runs_requested)

        for page in pages:
            for device in devices:
                samples = []
                for sample_index in range(1, runs_requested + 1):
                    print(f"PageSpeed {device:<7} run {sample_index}/{runs_requested} {page['url']}")
                    try:
                        raw = await fetch_pagespeed(page["url"], device, api_key, timeout=args.timeout)
                        metrics = extract_pagespeed_metrics(raw)
                        sample = {
                            "ok": True,
                            "sampleIndex": sample_index,
                            "metrics": metrics,
                            "raw": raw if store_raw else None,
                            "collectedAt": iso_now(),
                        }
                        insert_sample(
                            conn,
                            run_id=run_id,
                            page=page,
                            device=device,
                            sample_index=sample_index,
                            ok=True,
                            metrics=metrics,
                            raw_response=raw if store_raw else None,
                        )
                        success_count += 1
                    except Exception as exc:
                        sample = {
                            "ok": False,
                            "sampleIndex": sample_index,
                            "metrics": None,
                            "raw": None,
                            "error": {"name": exc.__class__.__name__, "message": str(exc)},
                            "collectedAt": iso_now(),
                        }
                        insert_sample(
                            conn,
                            run_id=run_id,
                            page=page,
                            device=device,
                            sample_index=sample_index,
                            ok=False,
                            error=sample["error"],
                        )
                        failure_count += 1
                        print(f"PageSpeed failed for {page['url']} ({device}, run {sample_index}): {exc}", file=sys.stderr)
                    samples.append(sample)

                aggregate = aggregate_samples(samples)
                upsert_url_result(
                    conn,
                    run_id=run_id,
                    page=page,
                    device=device,
                    runs_requested=runs_requested,
                    aggregate=aggregate,
                    store_raw=store_raw,
                )

        finish_run(conn, run_id=run_id, success_count=success_count, failure_count=failure_count)
        summary = build_summary_from_db(conn, watchlist)
        finish_run(conn, run_id=run_id, success_count=success_count, failure_count=failure_count, summary=summary)
        print(f"Wrote Lakebase Speed Index summary for run {run_id}")
        print(f"Pages: {len(pages)}, devices: {','.join(devices)}, successes: {success_count}, failures: {failure_count}")
    except Exception as exc:
        finish_run(conn, run_id=run_id, success_count=success_count, failure_count=failure_count, error=str(exc))
        raise
    finally:
        conn.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", help="Override the run id. Defaults to the current UTC timestamp.")
    parser.add_argument("--runs", type=int, help="PageSpeed samples per URL/device. Defaults to PAGESPEED_RUNS or 3.")
    parser.add_argument("--devices", help="Comma-separated devices. Defaults to PERF_DEVICES or watchlist default devices.")
    parser.add_argument("--api-key", help="PageSpeed Insights API key. Defaults to PAGESPEED_API_KEY/PSI_API_KEY/CRUX_API_KEY.")
    parser.add_argument("--pg-host", help="Lakebase PGHOST override for scheduled jobs.")
    parser.add_argument("--pg-database", help="Lakebase PGDATABASE override for scheduled jobs.")
    parser.add_argument("--pg-user", help="Lakebase PGUSER override for scheduled jobs.")
    parser.add_argument("--pg-port", help="Lakebase PGPORT override for scheduled jobs.")
    parser.add_argument("--pg-sslmode", help="Lakebase PGSSLMODE override for scheduled jobs.")
    parser.add_argument("--endpoint-name", help="Lakebase ENDPOINT_NAME override for scheduled jobs.")
    parser.add_argument("--timeout", type=float, default=180.0, help="Per-request timeout in seconds.")
    parser.add_argument("--store-raw", action="store_true", help="Store full PageSpeed responses in Lakebase JSONB columns.")
    return parser.parse_args()


def configure_lakebase_env(args: argparse.Namespace) -> None:
    mapping = {
        "PGHOST": args.pg_host,
        "PGDATABASE": args.pg_database,
        "PGUSER": args.pg_user,
        "PGPORT": args.pg_port,
        "PGSSLMODE": args.pg_sslmode,
        "ENDPOINT_NAME": args.endpoint_name,
    }
    for key, value in mapping.items():
        if value:
            os.environ[key] = value


if __name__ == "__main__":
    asyncio.run(collect(parse_args()))
