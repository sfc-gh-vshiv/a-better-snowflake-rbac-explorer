"""Snowpark session: st.connection inside Streamlit in Snowflake, else a named local connection."""
from __future__ import annotations

import os

import streamlit as st

LOCAL_CONNECTION = os.environ.get("RBAC_CONNECTION", "default")
LOCAL_ROLE = os.environ.get("RBAC_ROLE", "RBAC_EXPLORER_ROLE")
LOCAL_WAREHOUSE = os.environ.get("RBAC_WAREHOUSE", "COMPUTE_WH")


@st.cache_resource(show_spinner="Connecting to Snowflake...")
def get_session():
    if os.environ.get("SNOWFLAKE_HOST") or os.path.exists("/snowflake/session/token"):
        # Container runtime: one shared server for all viewers, and get_active_session()
        # isn't thread-safe there, so use the Streamlit-managed connection.
        return st.connection("snowflake").session()
    try:
        from snowflake.snowpark.context import get_active_session
        return get_active_session()  # warehouse runtime
    except Exception:
        pass
    from snowflake.snowpark import Session
    s = Session.builder.config("connection_name", LOCAL_CONNECTION).create()
    # Run locally with the same rights the deployed app has.
    s.sql(f"USE ROLE {LOCAL_ROLE}").collect()
    s.sql(f"USE WAREHOUSE {LOCAL_WAREHOUSE}").collect()
    return s
