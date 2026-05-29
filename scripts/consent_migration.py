#!/usr/bin/env python3
"""Create/seed Consent Metrics Lakebase tables."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lakebase import get_connection  # noqa: E402
import consent_metrics as cm  # noqa: E402


SOURCE_DIR = ROOT / "local" / "data-grail-dashboard" / "consent-logs"


def load_source_files(source_dir: Path) -> list[tuple[str, str]]:
    if not source_dir.exists():
        raise SystemExit(
            f"Consent source directory not found: {source_dir}\n"
            "Move the local data-grail-dashboard folder under web-hub/local first."
        )
    files = []
    for path in sorted(source_dir.iterdir()):
        if path.is_file() and path.suffix.lower() in {".csv", ".tsv", ".json"}:
            files.append((path.name, path.read_text(encoding="utf-8-sig", errors="replace")))
    if not files:
        raise SystemExit(f"No DataGrail export files found in {source_dir}")
    return files


def seed_events(conn, files: list[tuple[str, str]], refresh_static: bool) -> dict:
    parsed, events, totals = cm.parse_files(files)
    token = "seed-" + cm.sha256_text("|".join(name for name, _ in files))[:24]
    file_summaries = [
        {
            "name": parsed_file.name,
            "raw_rows": parsed_file.raw_rows,
            "unique_rows": parsed_file.unique_rows,
            "duplicate_rows": parsed_file.duplicate_rows,
        }
        for parsed_file in parsed
    ]

    row = conn.execute(
        "SELECT id FROM consent_import_batches WHERE batch_token = %s",
        (token,),
    ).fetchone()
    if row:
        batch_id = row[0]
    else:
        batch_id = conn.execute(
            """
            INSERT INTO consent_import_batches
              (batch_token, status, uploader, files, raw_rows, new_rows, duplicate_rows,
               committed_at)
            VALUES (%s, 'committed', 'seed-script', %s, %s, 0, %s, NOW())
            RETURNING id
            """,
            (
                token,
                cm.Jsonb(file_summaries),
                totals["raw_rows"],
                totals["duplicate_rows"],
            ),
        ).fetchone()[0]

    inserted = cm._insert_events(conn, batch_id, events)
    batch_events = cm._count_batch_events(conn, batch_id)
    duplicate_rows = totals["raw_rows"] - batch_events
    conn.execute(
        """
        UPDATE consent_import_batches
        SET new_rows = %s, duplicate_rows = %s, files = %s, committed_at = NOW()
        WHERE id = %s
        """,
        (batch_events, duplicate_rows, cm.Jsonb(file_summaries), batch_id),
    )

    data = cm.aggregate_from_db(conn)
    cm.upsert_snapshot(conn, data)
    if refresh_static:
        cm.save_static_fallback(data)
    return {
        "raw_rows": totals["raw_rows"],
        "inserted": inserted,
        "batch_events": batch_events,
        "duplicates": duplicate_rows,
        "total_events": data["total_events"],
        "unique_visitors": data["unique_visitors"],
        "date_range": data["date_range"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=SOURCE_DIR)
    parser.add_argument("--seed", action="store_true", help="Import source files after creating tables.")
    parser.add_argument("--refresh-static", action="store_true", help="Refresh static/consent-data.json.")
    parser.add_argument("--skip-grants", action="store_true", help="Do not run app service principal grants.")
    args = parser.parse_args()

    conn = get_connection()
    try:
        cm.create_tables(conn)
        if not args.skip_grants:
            cm.grant_app_access(conn)
        if args.seed:
            result = seed_events(conn, load_source_files(args.source_dir), args.refresh_static)
            print(result)
        else:
            print("Consent tables are ready.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
