"""Role Explorer: Snowflake RBAC as an interactive graph (React-in-SiS)."""
from __future__ import annotations

import hashlib
import os
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import streamlit as st

from react_bridge import bridge_request, bridge_respond, bridge_responses, load_bundle, render_island

st.set_page_config(page_title="Role Explorer", layout="wide", initial_sidebar_state="collapsed")
load_bundle()
req = bridge_request()


@st.cache_resource(show_spinner=False)
def _module_sig() -> dict:
    return {}


def _sync_modules() -> None:
    """A warm container keeps old modules.* imported across deploys (Streamlit only re-runs
    this file). Drop them when any module file changed, so the imports below load fresh code."""
    import pathlib
    import sys
    root = pathlib.Path(__file__).resolve().parent / "modules"
    sig = hashlib.sha1(b"".join(p.read_bytes() for p in sorted(root.glob("*.py")))).hexdigest()
    box = _module_sig()
    if box.get("sig") != sig:
        for name in [n for n in sys.modules if n == "modules" or n.startswith("modules.")]:
            del sys.modules[name]
        box["sig"] = sig


_sync_modules()
from modules import access, alerts, ask, model  # noqa: E402
from modules.connection import get_session  # noqa: E402

session = get_session()

st.html("<style>[data-testid=stMainBlockContainer]{padding-top:3.4rem;max-width:100%}"
        "header[data-testid=stHeader]{background:transparent}</style>")


# ------------------------------------------------------------------ async jobs
@st.cache_resource(show_spinner=False)
def _job_results() -> dict:
    return {}  # token -> (expires_at, result), shared across sessions


def _frame(qid: str) -> pd.DataFrame:
    """Finished query -> DataFrame via plain Python rows.

    Avoids the connector's Arrow->pandas path (AsyncJob.result("pandas")), which breaks
    on some connector/pandas combinations in the container runtime (string_to_tzinfo
    'prefer_zoneinfo' error).
    """
    cur = session.connection.cursor()
    try:
        cur.get_results_from_sfqid(qid)
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
    finally:
        cur.close()
    return pd.DataFrame.from_records(rows, columns=cols)


def _start(q) -> str:
    sql, params = (q, None) if isinstance(q, str) else q
    return session.sql(sql, params=params).collect_nowait().query_id


def run_jobs(token: str, sqls: dict | None, post) -> dict:
    """Several queries in parallel; finished result or {"pending": True, "token": ...}.

    Each value is SQL text or (sql, params).
    """
    cache = _job_results()
    hit = cache.get(token)
    if hit and hit[0] > time.time():
        return hit[1]
    fut = _py_jobs().get(token)
    if fut is not None:
        return _py_result(token, fut)
    jobs = st.session_state.setdefault("_sl_jobs", {})
    if token not in jobs:
        if sqls is None:
            raise ValueError("This request expired, please refresh.")
        jobs[token] = (post, {k: _start(v) for k, v in sqls.items()}, time.time())
    post, qids, t0 = jobs[token]
    handles = {k: session.create_async_job(q) for k, q in qids.items()}
    if not all(h.is_done() for h in handles.values()):
        return {"pending": True, "token": token, "elapsed": round(time.time() - t0)}
    try:
        result = post({k: _frame(q) for k, q in qids.items()})
    finally:
        jobs.pop(token, None)
    cache[token] = (time.time() + 1800, result)
    return result


def _token(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:16]


@st.cache_resource(show_spinner=False)
def _py_jobs() -> dict:
    return {}  # token -> (Future, started)


@st.cache_resource(show_spinner=False)
def _pool() -> ThreadPoolExecutor:
    return ThreadPoolExecutor(max_workers=4, thread_name_prefix="rx-job")


def _py_result(token: str, fut) -> dict:
    f, t0 = fut
    if not f.done():
        return {"pending": True, "token": token, "elapsed": round(time.time() - t0)}
    _py_jobs().pop(token, None)
    result = f.result()  # re-raises the job's exception into the bridge handler
    _job_results()[token] = (time.time() + 1800, result)
    return result


def run_py(token: str, fn) -> dict:
    """Python work that may take longer than a bridge round-trip (live SHOW walks).

    Runs on a worker thread so a client retry (which reruns the script) can't interrupt it.
    """
    hit = _job_results().get(token)
    if hit and hit[0] > time.time():
        return hit[1]
    jobs = _py_jobs()
    if token not in jobs:
        jobs[token] = (_pool().submit(fn), time.time())
    return _py_result(token, jobs[token])


@st.cache_data(ttl=300, show_spinner=False)
def _account() -> str:
    return session.sql("SELECT CURRENT_ACCOUNT_NAME() || ' (' || CURRENT_ACCOUNT() || ')'").collect()[0][0]


def known_roles() -> set[str]:
    return {r["name"] for r in model.live_roles(session)}


def known_users() -> set[str]:
    return {u["name"] for u in model.live_users(session)}


def start_model(nonce: int) -> dict:
    def post(frames):
        return model.build_model(frames, model.live_roles(session), model.live_users(session), _account(),
                                 model.live_system_grants(session))
    return run_jobs(_token("model", nonce), model.QUERIES, post)


_NAME = re.compile(r"^[A-Za-z0-9_$.\- \"]{1,255}$")


def _name(v) -> str:
    v = str(v or "")
    if not _NAME.match(v):
        raise ValueError("invalid name")
    return v


# ------------------------------------------------------------------ bridge actions
if req:
    resp = st.session_state.setdefault("_sl_responses", {})
    for rid in (req.get("ack") or [])[:100]:          # client has the result: stop re-sending it
        resp.pop(str(rid), None)
    try:
        a, pl = req["action"], req.get("payload") or {}
        if os.environ.get("RX_DEBUG"):
            print("bridge", req.get("id"), a, str(pl)[:80], flush=True)
        if a == "model":
            bridge_respond(req["id"], start_model(int(pl.get("nonce") or 0)))
        elif a == "poll":
            bridge_respond(req["id"], run_jobs(str(pl["token"])[:32], None, None))
        elif a == "live_role":
            role = _name(pl.get("role"))
            if role not in known_roles():
                raise ValueError(f"unknown role {role}")
            bridge_respond(req["id"], model.live_role_detail(session, role))
        elif a == "ask":
            prompt = ask.build_prompt(pl.get("page"), pl.get("ctx"), pl.get("history"), pl.get("question"))
            bridge_respond(req["id"], run_jobs(_token("ask", req["id"]), {"a": (ask.SQL, [ask.MODEL, prompt])}, ask.post))
        elif a.startswith("alert_") or a.startswith("watch_"):
            bridge_respond(req["id"], alerts.handle(session, a, pl, known_roles, known_users, run_jobs,
                                                    run_py=lambda fn: run_py(_token(a, req["id"]), fn)))
        elif a.startswith("access_"):
            bridge_respond(req["id"], access.handle(session, a, pl, known_roles, known_users,
                                                    run_py=lambda fn: run_py(_token(a, req["id"]), fn)))
        elif a == "ack":
            bridge_respond(req["id"], True)
        else:
            bridge_respond(req["id"], error=f"unknown action {a}")
    except Exception as e:  # surface the real error in the UI
        tb = traceback.extract_tb(e.__traceback__)
        where = " < ".join(f"{f.filename.rsplit('/', 1)[-1]}:{f.lineno} {f.name}" for f in tb[::-1][:6])
        print(traceback.format_exc(), flush=True)  # full trace in the container log
        bridge_respond(req["id"], error=f"{str(e)[:400]} [at {where}]"[:900])

render_island("App", {"responses": bridge_responses(), "account": _account()}, key="app")
