from __future__ import annotations

import pytest

import consent_metrics as cm


HEADER = (
    "consent_container_version_id\tconsent_preferences\tconsent_state\tcreated_at\t"
    "customer_supplied\tdg_customer_id\tdg_id\tlanguages\tmethod\tcountry\tregion\t"
    "url\turl_domain\tpolicyName\tdefaultPolicy\tlocale_code"
)


PREFS = '{"cookieOptions":[{"gtm_key":"dg-category-essential","isEnabled":true},{"gtm_key":"dg-category-marketing","isEnabled":false}]}'


def row(
    state="accept_all",
    created_at="2026-04-17T12:00:00Z",
    dg_id="visitor-1",
    country="US",
    region="CA",
    method="banner",
    url="https://joinhomebase.com/",
    policy="Homebase",
    prefs=PREFS,
):
    return "\t".join(
        [
            "container-1",
            prefs,
            state,
            created_at,
            "",
            "",
            dg_id,
            "en",
            method,
            country,
            region,
            url,
            "joinhomebase.com",
            policy,
            "true",
            "en-US",
        ]
    )


def test_parse_tsv_with_json_extension_and_aggregate():
    parsed, events, totals = cm.parse_files(
        [("consent_audit.json", HEADER + "\n" + row() + "\n" + row(state="exit", dg_id="visitor-2"))]
    )

    assert parsed[0].raw_rows == 2
    assert totals["deduped_rows"] == 2

    data = cm.aggregate_events(events)
    assert data["total_events"] == 2
    assert data["unique_visitors"] == 2
    assert data["date_range"] == ["2026-04-17", "2026-04-17"]
    assert data["rates"]["opt_in_all"] == 50.0
    assert data["rates"]["dismissed_all"] == 50.0


def test_duplicate_compound_key_is_deduped():
    text = HEADER + "\n" + row() + "\n" + row()
    _parsed, events, totals = cm.parse_files([("dupes.tsv", text)])

    assert len(events) == 1
    assert totals["raw_rows"] == 2
    assert totals["duplicate_rows"] == 1


def test_unknown_state_imports_as_other():
    _parsed, events, _totals = cm.parse_files([("unknown.tsv", HEADER + "\n" + row(state="new_state"))])

    assert events[0]["bucket"] == "other"
    data = cm.aggregate_events(events)
    assert data["buckets"]["other"] == 1
    assert data["states"] == [["new_state", 1]]


def test_missing_metric_field_rejects_file():
    bad_header = HEADER.replace("\tpolicyName", "")

    with pytest.raises(cm.ConsentImportError) as exc:
        cm.parse_files([("bad.tsv", bad_header + "\n" + row())])

    assert "Missing required fields" in str(exc.value)
    assert exc.value.file_name == "bad.tsv"
    assert exc.value.row_number == 1


def test_invalid_preferences_rejects_file():
    with pytest.raises(cm.ConsentImportError) as exc:
        cm.parse_files([("bad-prefs.tsv", HEADER + "\n" + row(prefs="{not-json}"))])

    assert "Invalid consent_preferences JSON" in str(exc.value)
