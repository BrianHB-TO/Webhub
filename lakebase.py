"""Lakebase (serverless Postgres) connection layer with OAuth token rotation."""

import os
import psycopg
from databricks.sdk import WorkspaceClient


# Auto-detect environment: DATABRICKS_APP_NAME is injected when deployed
IS_DEPLOYED = bool(os.environ.get("DATABRICKS_APP_NAME"))

# Defaults for local development (dev branch — isolated from production)
LOCAL_DEFAULTS = {
    "PGHOST": "ep-winter-term-d1btxtp7.database.us-west-2.cloud.databricks.com",
    "PGDATABASE": "databricks_postgres",
    "PGUSER": "bnguyen@joinhomebase.com",
    "PGPORT": "5432",
    "PGSSLMODE": "require",
    "ENDPOINT_NAME": "projects/web-hub-db/branches/dev/endpoints/primary",
}


def _env(key: str) -> str:
    """Read env var, falling back to local defaults when not deployed."""
    return os.environ.get(key) or LOCAL_DEFAULTS.get(key, "")


def _make_conninfo() -> str:
    return (
        f"host={_env('PGHOST')} "
        f"port={_env('PGPORT')} "
        f"dbname={_env('PGDATABASE')} "
        f"user={_env('PGUSER')} "
        f"sslmode={_env('PGSSLMODE')}"
    )


def _generate_token() -> str:
    """Generate a fresh OAuth token via the Databricks SDK."""
    client = WorkspaceClient()
    cred = client.postgres.generate_database_credential(
        endpoint=_env("ENDPOINT_NAME")
    )
    return cred.token


def get_connection() -> psycopg.Connection:
    """Create a new connection with a fresh OAuth token."""
    token = _generate_token()
    conninfo = _make_conninfo()
    return psycopg.connect(f"{conninfo} password={token}", autocommit=True)
