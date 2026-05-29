"""DataGrail consent metrics parsing, aggregation, and Lakebase persistence."""

from __future__ import annotations

import csv
import hashlib
import json
import secrets
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Iterable

from psycopg.types.json import Jsonb


ROOT = Path(__file__).parent
STATIC_FALLBACK = ROOT / "static" / "consent-data.json"
ISO2_TO_NUM_PATH = ROOT / "static" / "vendor" / "consent" / "iso2-to-num.json"

AGGREGATION_VERSION = "consent-v1"
STAGING_TTL_MINUTES = 10
MIN_EVENTS_COUNTRY = 20
MIN_EVENTS_REGION = 20

REQUIRED_FIELDS = {
    "created_at",
    "consent_state",
    "dg_id",
    "country",
    "region",
    "method",
    "policyName",
    "url",
    "consent_preferences",
    "consent_container_version_id",
}

OPT_IN = {"accept_all"}
OPT_OUT = {"essential_only", "DNT", "GPC"}
PARTIAL = {"custom"}
DISMISSED = {"exit"}

US_STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06",
    "CO": "08", "CT": "09", "DE": "10", "DC": "11", "FL": "12",
    "GA": "13", "HI": "15", "ID": "16", "IL": "17", "IN": "18",
    "IA": "19", "KS": "20", "KY": "21", "LA": "22", "ME": "23",
    "MD": "24", "MA": "25", "MI": "26", "MN": "27", "MS": "28",
    "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33",
    "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38",
    "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44",
    "SC": "45", "SD": "46", "TN": "47", "TX": "48", "UT": "49",
    "VT": "50", "VA": "51", "WA": "53", "WV": "54", "WI": "55",
    "WY": "56",
}

CA_PROVINCE_NAME = {
    "AB": "Alberta",
    "BC": "British Columbia",
    "MB": "Manitoba",
    "NB": "New Brunswick",
    "NL": "Newfoundland and Labrador",
    "NS": "Nova Scotia",
    "NT": "Northwest Territories",
    "NU": "Nunavut",
    "ON": "Ontario",
    "PE": "Prince Edward Island",
    "QC": "Quebec",
    "SK": "Saskatchewan",
    "YT": "Yukon",
}


class ConsentImportError(ValueError):
    """User-facing import error with file and row context."""

    def __init__(self, message: str, file_name: str | None = None, row_number: int | None = None):
        super().__init__(message)
        self.file_name = file_name
        self.row_number = row_number

    def to_dict(self) -> dict:
        return {
            "message": str(self),
            "fileName": self.file_name,
            "rowNumber": self.row_number,
        }


@dataclass
class ParsedFile:
    name: str
    raw_rows: int
    unique_rows: int
    duplicate_rows: int
    events: list[dict]


def classify(state: str) -> str:
    if state in OPT_IN:
        return "opt_in"
    if state in OPT_OUT:
        return "opt_out"
    if state in PARTIAL:
        return "partial"
    if state in DISMISSED:
        return "dismissed"
    return "other"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def consent_row_key(row: dict[str, str]) -> str:
    fields = (
        "consent_container_version_id",
        "dg_id",
        "created_at",
        "consent_state",
        "method",
        "url",
        "policyName",
    )
    return "\x1f".join(row.get(field, "") for field in fields)


def sniff_delimiter(text: str) -> str:
    first_line = text.splitlines()[0] if text.splitlines() else ""
    return "\t" if first_line.count("\t") >= first_line.count(",") else ","


def _rows_from_json(file_name: str, text: str) -> list[dict[str, str]]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConsentImportError(f"Invalid JSON: {exc.msg}", file_name, exc.lineno) from exc

    if isinstance(parsed, list):
        rows = parsed
    elif isinstance(parsed, dict):
        rows = None
        for key in ("data", "records", "results"):
            if isinstance(parsed.get(key), list):
                rows = parsed[key]
                break
        if rows is None:
            raise ConsentImportError("JSON export must be an array or contain data/records/results.", file_name)
    else:
        raise ConsentImportError("JSON export must be an array or object.", file_name)

    normalized = []
    for index, row in enumerate(rows, start=2):
        if not isinstance(row, dict):
            raise ConsentImportError("JSON row is not an object.", file_name, index)
        normalized.append({str(k): "" if v is None else str(v) for k, v in row.items()})
    return normalized


def _rows_from_delimited(file_name: str, text: str) -> list[dict[str, str]]:
    delimiter = sniff_delimiter(text)
    reader = csv.DictReader(StringIO(text), delimiter=delimiter)
    headers = set(reader.fieldnames or [])
    missing = sorted(REQUIRED_FIELDS - headers)
    if missing:
        raise ConsentImportError(f"Missing required fields: {', '.join(missing)}", file_name, 1)

    rows = []
    for row_number, row in enumerate(reader, start=2):
        if not row or not any((value or "").strip() for value in row.values()):
            continue
        rows.append({key: "" if value is None else value for key, value in row.items()})
    return rows


def parse_audit_file(file_name: str, text: str) -> list[dict[str, str]]:
    clean_text = text.lstrip("\ufeff")
    if not clean_text.strip():
        raise ConsentImportError("File is empty.", file_name)

    stripped = clean_text.lstrip()
    if file_name.lower().endswith(".json") and stripped[:1] in ("[", "{"):
        rows = _rows_from_json(file_name, clean_text)
    else:
        rows = _rows_from_delimited(file_name, clean_text)

    missing_rows = []
    for row_number, row in enumerate(rows, start=2):
        for field in REQUIRED_FIELDS:
            if row.get(field) is None:
                missing_rows.append((row_number, field))
        created_at = row.get("created_at", "")
        if len(created_at) < 10 or created_at[4:5] != "-" or created_at[7:8] != "-":
            raise ConsentImportError("created_at must start with YYYY-MM-DD.", file_name, row_number)
        prefs = row.get("consent_preferences", "")
        if prefs.strip():
            try:
                json.loads(prefs)
            except json.JSONDecodeError as exc:
                raise ConsentImportError(f"Invalid consent_preferences JSON: {exc.msg}", file_name, row_number) from exc

    if missing_rows:
        row_number, field = missing_rows[0]
        raise ConsentImportError(f"Missing required value for {field}.", file_name, row_number)
    return rows


def _extract_categories(row: dict[str, str]) -> tuple[list[str], list[str]]:
    prefs_raw = row.get("consent_preferences", "")
    if not prefs_raw.strip():
        return [], []
    prefs = json.loads(prefs_raw)
    options = prefs.get("cookieOptions") if isinstance(prefs, dict) else None
    if not isinstance(options, list):
        return [], []

    seen: list[str] = []
    enabled: list[str] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        key = str(opt.get("gtm_key") or "unknown").replace("dg-category-", "")
        seen.append(key)
        if opt.get("isEnabled"):
            enabled.append(key)
    return seen, enabled


def normalize_row(row: dict[str, str]) -> dict:
    event_hash = sha256_text(consent_row_key(row))
    visitor_hash = sha256_text(row.get("dg_id", ""))
    state = row.get("consent_state", "")
    seen, enabled = _extract_categories(row)
    return {
        "event_hash": event_hash,
        "visitor_hash": visitor_hash,
        "event_date": row.get("created_at", "")[:10],
        "created_at": row.get("created_at", ""),
        "consent_state": state,
        "bucket": classify(state),
        "method": row.get("method") or "Unknown",
        "country": row.get("country") or "Unknown",
        "region": row.get("region") or "Unknown",
        "policy_name": row.get("policyName") or "Unknown",
        "url_domain": row.get("url_domain") or "",
        "categories_seen": seen,
        "categories_enabled": enabled,
    }


def parse_files(files: Iterable[tuple[str, str]]) -> tuple[list[ParsedFile], list[dict], dict]:
    seen: set[str] = set()
    parsed_files: list[ParsedFile] = []
    all_events: list[dict] = []
    raw_rows = 0
    duplicate_rows = 0

    for file_name, text in files:
        rows = parse_audit_file(file_name, text)
        file_events = []
        file_raw = 0
        file_duplicates = 0
        for row in rows:
            file_raw += 1
            raw_rows += 1
            event = normalize_row(row)
            if event["event_hash"] in seen:
                file_duplicates += 1
                duplicate_rows += 1
                continue
            seen.add(event["event_hash"])
            file_events.append(event)
            all_events.append(event)
        parsed_files.append(
            ParsedFile(
                name=file_name,
                raw_rows=file_raw,
                unique_rows=len(file_events),
                duplicate_rows=file_duplicates,
                events=file_events,
            )
        )

    return parsed_files, all_events, {
        "raw_rows": raw_rows,
        "deduped_rows": len(all_events),
        "duplicate_rows": duplicate_rows,
    }


def _empty_geo_cell() -> dict:
    return {"total": 0, "opt_in": 0, "opt_out": 0, "partial": 0, "dismissed": 0, "other": 0}


def _pct(numerator: int, denominator: int) -> float:
    return round(100 * numerator / denominator, 1) if denominator else 0.0


def _sorted_counter(counter: Counter, limit: int | None = None) -> list[list]:
    rows = [[key, count] for key, count in counter.most_common(limit)]
    return rows


def _rates_for(cell: dict) -> dict:
    total = cell["total"]
    deciders = cell["opt_in"] + cell["opt_out"] + cell["partial"]
    return {
        **cell,
        "deciders": deciders,
        "opt_in_all": _pct(cell["opt_in"], total),
        "opt_out_all": _pct(cell["opt_out"], total),
        "partial_all": _pct(cell["partial"], total),
        "dismissed_all": _pct(cell["dismissed"], total),
        "opt_out_deciders": _pct(cell["opt_out"], deciders),
    }


def _load_iso2_to_num() -> dict[str, str]:
    if ISO2_TO_NUM_PATH.exists():
        return json.loads(ISO2_TO_NUM_PATH.read_text(encoding="utf-8"))
    return {"US": "840", "CA": "124"}


def aggregate_events(events: Iterable[dict], source: dict | None = None) -> dict:
    total = 0
    by_state: Counter[str] = Counter()
    by_bucket: Counter[str] = Counter()
    by_method: Counter[str] = Counter()
    by_policy: Counter[str] = Counter()
    by_country: Counter[str] = Counter()
    by_day: dict[str, Counter[str]] = defaultdict(Counter)
    by_category_enabled: Counter[str] = Counter()
    by_category_seen: Counter[str] = Counter()
    custom_combos: Counter[tuple[str, ...]] = Counter()
    custom_total = 0
    unique_visitors: set[str] = set()
    geo_country: dict[str, dict] = defaultdict(_empty_geo_cell)
    geo_us_state: dict[str, dict] = defaultdict(_empty_geo_cell)
    geo_ca_prov: dict[str, dict] = defaultdict(_empty_geo_cell)

    for event in events:
        total += 1
        state = event.get("consent_state", "") or "Unknown"
        bucket = event.get("bucket") or classify(state)
        by_state[state] += 1
        by_bucket[bucket] += 1
        by_method[event.get("method") or "Unknown"] += 1
        by_policy[event.get("policy_name") or "Unknown"] += 1
        country_code = event.get("country") or "Unknown"
        region_code = event.get("region") or "Unknown"
        by_country[country_code] += 1
        if event.get("visitor_hash"):
            unique_visitors.add(event["visitor_hash"])

        day = str(event.get("event_date") or event.get("created_at", "")[:10])
        if day:
            by_day[day][bucket] += 1

        if country_code and country_code != "Unknown":
            cell = geo_country[country_code]
            cell["total"] += 1
            cell[bucket] += 1
        if country_code == "US" and region_code and region_code != "Unknown":
            cell = geo_us_state[region_code]
            cell["total"] += 1
            cell[bucket] += 1
        elif country_code == "CA" and region_code and region_code != "Unknown":
            cell = geo_ca_prov[region_code]
            cell["total"] += 1
            cell[bucket] += 1

        categories_seen = event.get("categories_seen") or []
        categories_enabled = event.get("categories_enabled") or []
        for category in categories_seen:
            by_category_seen[category] += 1
        for category in categories_enabled:
            by_category_enabled[category] += 1
        if state == "custom":
            custom_total += 1
            custom_combos[tuple(sorted(categories_enabled))] += 1

    days_sorted = sorted(by_day.keys())
    deciders = by_bucket["opt_in"] + by_bucket["opt_out"] + by_bucket["partial"]
    iso2_to_num = _load_iso2_to_num()

    countries_map = {}
    for iso2, cell in geo_country.items():
        num = iso2_to_num.get(iso2)
        if num:
            countries_map[num] = {"iso2": iso2, **_rates_for(cell)}

    us_states_map = {}
    for code, cell in geo_us_state.items():
        fips = US_STATE_FIPS.get(code)
        if fips:
            us_states_map[fips] = {"code": code, **_rates_for(cell)}

    ca_provinces_map = {}
    for code, cell in geo_ca_prov.items():
        name = CA_PROVINCE_NAME.get(code)
        if name:
            ca_provinces_map[name] = {"code": code, **_rates_for(cell)}

    category_rates = {
        category: {
            "enabled": by_category_enabled[category],
            "seen": by_category_seen[category],
            "rate": _pct(by_category_enabled[category], by_category_seen[category]),
        }
        for category, _ in by_category_seen.most_common()
    }

    custom_rows = [
        {
            "label": " + ".join(combo) if combo else "(none enabled)",
            "count": count,
            "rate": _pct(count, custom_total),
        }
        for combo, count in custom_combos.most_common(8)
    ]

    return {
        "schema_version": AGGREGATION_VERSION,
        "total_events": total,
        "unique_visitors": len(unique_visitors),
        "date_range": [days_sorted[0], days_sorted[-1]] if days_sorted else ["", ""],
        "rates": {
            "opt_in_all": _pct(by_bucket["opt_in"], total),
            "opt_out_all": _pct(by_bucket["opt_out"], total),
            "dismissed_all": _pct(by_bucket["dismissed"], total),
            "opt_in_deciders": _pct(by_bucket["opt_in"], deciders),
            "opt_out_deciders": _pct(by_bucket["opt_out"], deciders),
            "partial_deciders": _pct(by_bucket["partial"], deciders),
        },
        "buckets": dict(by_bucket),
        "states": _sorted_counter(by_state),
        "methods": _sorted_counter(by_method),
        "policies": _sorted_counter(by_policy),
        "countries": _sorted_counter(by_country, 15),
        "daily": {
            "labels": days_sorted,
            "opt_in": [by_day[day].get("opt_in", 0) for day in days_sorted],
            "opt_out": [by_day[day].get("opt_out", 0) for day in days_sorted],
            "partial": [by_day[day].get("partial", 0) for day in days_sorted],
            "dismissed": [by_day[day].get("dismissed", 0) for day in days_sorted],
        },
        "categories": category_rates,
        "custom_combos": {"total": custom_total, "rows": custom_rows},
        "deciders": deciders,
        "geo": {
            "countries": countries_map,
            "us_states": us_states_map,
            "ca_provinces": ca_provinces_map,
            "min_events_country": MIN_EVENTS_COUNTRY,
            "min_events_region": MIN_EVENTS_REGION,
        },
        "source": source or {
            "mode": "unknown",
            "files": [],
            "raw_events": total,
            "duplicate_events": 0,
            "deduped_events": total,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def create_tables(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS consent_import_batches (
            id SERIAL PRIMARY KEY,
            batch_token TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL,
            uploader TEXT,
            files JSONB NOT NULL DEFAULT '[]'::jsonb,
            raw_rows INTEGER NOT NULL DEFAULT 0,
            new_rows INTEGER NOT NULL DEFAULT 0,
            duplicate_rows INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            committed_at TIMESTAMPTZ,
            reverted_at TIMESTAMPTZ
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS consent_staged_events (
            id SERIAL PRIMARY KEY,
            batch_token TEXT NOT NULL,
            event_hash TEXT NOT NULL,
            visitor_hash TEXT NOT NULL,
            event_date DATE NOT NULL,
            created_at TEXT NOT NULL,
            consent_state TEXT NOT NULL,
            bucket TEXT NOT NULL,
            method TEXT,
            country TEXT,
            region TEXT,
            policy_name TEXT,
            url_domain TEXT,
            categories_seen JSONB NOT NULL DEFAULT '[]'::jsonb,
            categories_enabled JSONB NOT NULL DEFAULT '[]'::jsonb
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS consent_events (
            id SERIAL PRIMARY KEY,
            import_batch_id INTEGER REFERENCES consent_import_batches(id),
            event_hash TEXT NOT NULL UNIQUE,
            visitor_hash TEXT NOT NULL,
            event_date DATE NOT NULL,
            created_at TEXT NOT NULL,
            consent_state TEXT NOT NULL,
            bucket TEXT NOT NULL,
            method TEXT,
            country TEXT,
            region TEXT,
            policy_name TEXT,
            url_domain TEXT,
            categories_seen JSONB NOT NULL DEFAULT '[]'::jsonb,
            categories_enabled JSONB NOT NULL DEFAULT '[]'::jsonb,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS consent_snapshots (
            id SERIAL PRIMARY KEY,
            snapshot_key TEXT NOT NULL UNIQUE DEFAULT 'latest',
            data JSONB NOT NULL,
            aggregation_version TEXT NOT NULL,
            generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consent_events_date ON consent_events(event_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consent_events_active ON consent_events(active)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consent_staged_token ON consent_staged_events(batch_token)")


def grant_app_access(conn, principal: str = "49b4af05-7301-4d07-9fb5-5ae469dcd68e") -> None:
    for table in ("consent_import_batches", "consent_staged_events", "consent_events", "consent_snapshots"):
        conn.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {table} TO "{principal}"')
        conn.execute(f'GRANT USAGE, SELECT ON SEQUENCE {table}_id_seq TO "{principal}"')


def cleanup_expired_staging(conn) -> None:
    expired = conn.execute(
        """
        SELECT batch_token
        FROM consent_import_batches
        WHERE status = 'staged'
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
        """
    ).fetchall()
    for (token,) in expired:
        conn.execute("DELETE FROM consent_staged_events WHERE batch_token = %s", (token,))
        conn.execute(
            "UPDATE consent_import_batches SET status = 'expired' WHERE batch_token = %s",
            (token,),
        )


def _existing_hashes(conn, hashes: list[str]) -> set[str]:
    if not hashes:
        return set()
    rows = conn.execute(
        "SELECT event_hash FROM consent_events WHERE event_hash = ANY(%s) AND active = TRUE",
        (hashes,),
    ).fetchall()
    return {row[0] for row in rows}


def _file_summaries(parsed_files: list[ParsedFile]) -> list[dict]:
    return [
        {
            "name": parsed.name,
            "raw_rows": parsed.raw_rows,
            "unique_rows": parsed.unique_rows,
            "duplicate_rows": parsed.duplicate_rows,
        }
        for parsed in parsed_files
    ]


def stage_upload(conn, files: Iterable[tuple[str, str]], uploader: str | None = None) -> dict:
    cleanup_expired_staging(conn)
    parsed_files, events, totals = parse_files(files)
    event_hashes = [event["event_hash"] for event in events]
    existing = _existing_hashes(conn, event_hashes)
    token = secrets.token_urlsafe(24)
    new_rows = len([event for event in events if event["event_hash"] not in existing])
    duplicate_rows = totals["duplicate_rows"] + len(existing)
    file_summaries = _file_summaries(parsed_files)

    conn.execute(
        """
        INSERT INTO consent_import_batches
          (batch_token, status, uploader, files, raw_rows, new_rows, duplicate_rows,
           expires_at)
        VALUES (%s, 'staged', %s, %s, %s, %s, %s,
          NOW() + (%s || ' minutes')::interval)
        """,
        (
            token,
            uploader,
            Jsonb(file_summaries),
            totals["raw_rows"],
            new_rows,
            duplicate_rows,
            STAGING_TTL_MINUTES,
        ),
    )
    _insert_staged_events(conn, token, events)

    return {
        "token": token,
        "expires_in_minutes": STAGING_TTL_MINUTES,
        "files": file_summaries,
        "raw_rows": totals["raw_rows"],
        "new_rows": new_rows,
        "duplicate_rows": duplicate_rows,
        "can_commit": True,
    }


def _chunks(items: list[dict], size: int = 2000) -> Iterable[list[dict]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def _event_payloads(events: list[dict]) -> list[dict]:
    return [
        {
            "event_hash": event["event_hash"],
            "visitor_hash": event["visitor_hash"],
            "event_date": event["event_date"],
            "created_at": event["created_at"],
            "consent_state": event["consent_state"],
            "bucket": event["bucket"],
            "method": event["method"],
            "country": event["country"],
            "region": event["region"],
            "policy_name": event["policy_name"],
            "url_domain": event["url_domain"],
            "categories_seen": event["categories_seen"],
            "categories_enabled": event["categories_enabled"],
        }
        for event in events
    ]


def _insert_staged_events(conn, token: str, events: list[dict]) -> int:
    inserted = 0
    for chunk in _chunks(_event_payloads(events)):
        rows = conn.execute(
            """
            WITH payload AS (
                SELECT *
                FROM jsonb_to_recordset(%s::jsonb) AS item(
                    event_hash TEXT,
                    visitor_hash TEXT,
                    event_date DATE,
                    created_at TEXT,
                    consent_state TEXT,
                    bucket TEXT,
                    method TEXT,
                    country TEXT,
                    region TEXT,
                    policy_name TEXT,
                    url_domain TEXT,
                    categories_seen JSONB,
                    categories_enabled JSONB
                )
            )
            INSERT INTO consent_staged_events
              (batch_token, event_hash, visitor_hash, event_date, created_at, consent_state,
               bucket, method, country, region, policy_name, url_domain,
               categories_seen, categories_enabled)
            SELECT %s, event_hash, visitor_hash, event_date, created_at, consent_state,
                   bucket, method, country, region, policy_name, url_domain,
                   COALESCE(categories_seen, '[]'::jsonb),
                   COALESCE(categories_enabled, '[]'::jsonb)
            FROM payload
            RETURNING 1
            """,
            (Jsonb(chunk), token),
        ).fetchall()
        inserted += len(rows)
    return inserted


def _insert_staged_event(conn, token: str, event: dict) -> None:
    _insert_staged_events(conn, token, [event])


def _staged_events(conn, token: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT event_hash, visitor_hash, event_date::text, created_at, consent_state,
               bucket, method, country, region, policy_name, url_domain,
               categories_seen, categories_enabled
        FROM consent_staged_events
        WHERE batch_token = %s
        ORDER BY id
        """,
        (token,),
    ).fetchall()
    return [_event_from_row(row) for row in rows]


def _event_from_row(row) -> dict:
    return {
        "event_hash": row[0],
        "visitor_hash": row[1],
        "event_date": row[2],
        "created_at": row[3],
        "consent_state": row[4],
        "bucket": row[5],
        "method": row[6],
        "country": row[7],
        "region": row[8],
        "policy_name": row[9],
        "url_domain": row[10],
        "categories_seen": row[11] or [],
        "categories_enabled": row[12] or [],
    }


def commit_upload(conn, token: str) -> dict:
    cleanup_expired_staging(conn)
    batch = conn.execute(
        """
        SELECT id, files, raw_rows, status, expires_at
        FROM consent_import_batches
        WHERE batch_token = %s
        """,
        (token,),
    ).fetchone()
    if not batch:
        raise ConsentImportError("Upload preview token was not found.")
    batch_id, files, raw_rows, status, expires_at = batch
    if status != "staged":
        raise ConsentImportError(f"Upload preview cannot be committed because it is {status}.")
    if expires_at and expires_at < datetime.now(timezone.utc):
        raise ConsentImportError("Upload preview expired. Preview the files again.")

    events = _staged_events(conn, token)
    existing = _existing_hashes(conn, [event["event_hash"] for event in events])
    inserted = _insert_events(
        conn,
        batch_id,
        [event for event in events if event["event_hash"] not in existing],
    )
    batch_events = _count_batch_events(conn, batch_id)
    duplicate_rows = raw_rows - batch_events
    conn.execute(
        """
        UPDATE consent_import_batches
        SET status = 'committed',
            committed_at = NOW(),
            new_rows = %s,
            duplicate_rows = %s
        WHERE id = %s
        """,
        (batch_events, duplicate_rows, batch_id),
    )
    conn.execute("DELETE FROM consent_staged_events WHERE batch_token = %s", (token,))
    data = aggregate_from_db(conn)
    upsert_snapshot(conn, data)
    return {
        "import": {
            "id": batch_id,
            "files": files,
            "raw_rows": raw_rows,
            "new_rows": batch_events,
            "duplicate_rows": duplicate_rows,
            "status": "committed",
        },
        "data": data,
    }


def _insert_events(conn, batch_id: int, events: list[dict]) -> int:
    inserted = 0
    for chunk in _chunks(_event_payloads(events)):
        rows = conn.execute(
            """
            WITH payload AS (
                SELECT *
                FROM jsonb_to_recordset(%s::jsonb) AS item(
                    event_hash TEXT,
                    visitor_hash TEXT,
                    event_date DATE,
                    created_at TEXT,
                    consent_state TEXT,
                    bucket TEXT,
                    method TEXT,
                    country TEXT,
                    region TEXT,
                    policy_name TEXT,
                    url_domain TEXT,
                    categories_seen JSONB,
                    categories_enabled JSONB
                )
            )
            INSERT INTO consent_events
              (import_batch_id, event_hash, visitor_hash, event_date, created_at,
               consent_state, bucket, method, country, region, policy_name, url_domain,
               categories_seen, categories_enabled)
            SELECT %s, event_hash, visitor_hash, event_date, created_at,
                   consent_state, bucket, method, country, region, policy_name, url_domain,
                   COALESCE(categories_seen, '[]'::jsonb),
                   COALESCE(categories_enabled, '[]'::jsonb)
            FROM payload
            ON CONFLICT (event_hash) DO NOTHING
            RETURNING 1
            """,
            (Jsonb(chunk), batch_id),
        ).fetchall()
        inserted += len(rows)
    return inserted


def _insert_event(conn, batch_id: int, event: dict) -> bool:
    return _insert_events(conn, batch_id, [event]) == 1


def _count_batch_events(conn, batch_id: int) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*)
        FROM consent_events
        WHERE import_batch_id = %s AND active = TRUE
        """,
        (batch_id,),
    ).fetchone()
    return int(row[0] or 0)


def _date_clause(start: str | None = None, end: str | None = None) -> tuple[str, list[str]]:
    clauses = ["active = TRUE"]
    params: list[str] = []
    if start:
        clauses.append("event_date >= %s")
        params.append(start)
    if end:
        clauses.append("event_date <= %s")
        params.append(end)
    return " AND ".join(clauses), params


def events_from_db(conn, start: str | None = None, end: str | None = None) -> list[dict]:
    where, params = _date_clause(start, end)
    rows = conn.execute(
        f"""
        SELECT event_hash, visitor_hash, event_date::text, created_at, consent_state,
               bucket, method, country, region, policy_name, url_domain,
               categories_seen, categories_enabled
        FROM consent_events
        WHERE {where}
        ORDER BY event_date, id
        """,
        params,
    ).fetchall()
    return [_event_from_row(row) for row in rows]


def aggregate_from_db(conn, start: str | None = None, end: str | None = None) -> dict:
    events = events_from_db(conn, start, end)
    source = source_from_db(conn)
    if start or end:
        source = {**source, "filter": {"start": start, "end": end}}
    return aggregate_events(events, source=source)


def snapshot_from_db(conn) -> dict | None:
    row = conn.execute(
        """
        SELECT data
        FROM consent_snapshots
        WHERE snapshot_key = 'latest'
          AND aggregation_version = %s
        """,
        (AGGREGATION_VERSION,),
    ).fetchone()
    if not row:
        return None
    return row[0]


def source_from_db(conn) -> dict:
    row = conn.execute(
        """
        SELECT COUNT(*), COALESCE(SUM(raw_rows), 0), COALESCE(SUM(duplicate_rows), 0),
               COALESCE(SUM(new_rows), 0), MAX(committed_at)
        FROM consent_import_batches
        WHERE status = 'committed' AND reverted_at IS NULL
        """
    ).fetchone()
    file_rows = conn.execute(
        """
        SELECT files
        FROM consent_import_batches
        WHERE status = 'committed' AND reverted_at IS NULL
        ORDER BY committed_at DESC NULLS LAST, id DESC
        LIMIT 8
        """
    ).fetchall()
    available = conn.execute(
        """
        SELECT MIN(event_date)::text, MAX(event_date)::text
        FROM consent_events
        WHERE active = TRUE
        """
    ).fetchone()
    files = []
    for (batch_files,) in file_rows:
        files.extend(batch_files or [])
    return {
        "mode": "lakebase",
        "import_batches": row[0] if row else 0,
        "raw_events": int(row[1] or 0) if row else 0,
        "duplicate_events": int(row[2] or 0) if row else 0,
        "deduped_events": int(row[3] or 0) if row else 0,
        "latest_imported_at": row[4].isoformat() if row and row[4] else None,
        "available_date_range": [available[0], available[1]] if available and available[0] else ["", ""],
        "files": files[:12],
    }


def upsert_snapshot(conn, data: dict) -> None:
    conn.execute(
        """
        INSERT INTO consent_snapshots (snapshot_key, data, aggregation_version, generated_at)
        VALUES ('latest', %s, %s, NOW())
        ON CONFLICT (snapshot_key)
        DO UPDATE SET data = EXCLUDED.data,
                      aggregation_version = EXCLUDED.aggregation_version,
                      generated_at = EXCLUDED.generated_at
        """,
        (Jsonb(data), AGGREGATION_VERSION),
    )


def recent_imports(conn, limit: int = 8) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, status, uploader, files, raw_rows, new_rows, duplicate_rows,
               created_at, committed_at, expires_at
        FROM consent_import_batches
        WHERE status IN ('committed', 'expired')
        ORDER BY COALESCE(committed_at, created_at) DESC, id DESC
        LIMIT %s
        """,
        (limit,),
    ).fetchall()
    return [
        {
            "id": row[0],
            "status": row[1],
            "uploader": row[2],
            "files": row[3] or [],
            "raw_rows": row[4],
            "new_rows": row[5],
            "duplicate_rows": row[6],
            "created_at": row[7].isoformat() if row[7] else None,
            "committed_at": row[8].isoformat() if row[8] else None,
            "expires_at": row[9].isoformat() if row[9] else None,
        }
        for row in rows
    ]


def load_static_fallback() -> dict | None:
    if not STATIC_FALLBACK.exists():
        return None
    return json.loads(STATIC_FALLBACK.read_text(encoding="utf-8"))


def save_static_fallback(data: dict) -> None:
    STATIC_FALLBACK.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
