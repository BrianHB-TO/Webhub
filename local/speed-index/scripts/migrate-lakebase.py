#!/usr/bin/env python3
"""Create Speed Index Lakebase tables."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from lakebase import get_connection  # noqa: E402
from speed_index_lakebase import create_tables, grant_app_access  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-grants", action="store_true", help="Do not run Web Hub app service principal grants.")
    args = parser.parse_args()

    conn = get_connection()
    try:
        create_tables(conn)
        if not args.skip_grants:
            grant_app_access(conn)
        print("Speed Index Lakebase tables are ready.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
