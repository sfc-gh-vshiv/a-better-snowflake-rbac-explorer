"""Checks that hold without Snowflake: SiS Streamlit API surface, bridge helpers, payload builder."""
import ast
import pathlib
import types

import pandas as pd
import streamlit as st

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_pyproject_pins_match_installed():
    # The container runtime syncs pyproject.toml onto its pre-installed venv; pins that differ
    # from the base image swap packages under the running server. Test against those versions.
    import importlib.metadata as md
    import re
    pins = dict(re.findall(r'"([a-z0-9-]+)(?:\[[a-z]+\])?==([0-9.]+)"', (ROOT / "pyproject.toml").read_text()))
    assert pins, "no pins found"
    assert {k: md.version(k) for k in pins} == pins


def test_every_st_attribute_exists_in_1_52():
    used = set()
    for f in [ROOT / "streamlit_app.py", ROOT / "react_bridge.py", *ROOT.glob("modules/*.py")]:
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "st":
                used.add(node.attr)
    missing = [a for a in used if not hasattr(st, a)]
    assert not missing, missing


def test_build_model_shapes():
    from modules import model
    frames = {
        "edges": pd.DataFrame([["SYSADMIN", "ROLE", "ACCOUNTADMIN", "ROLE", None, "X"],
                               ["DBR", "DATABASE_ROLE", "SYSADMIN", "ROLE", None, "X"]],
                              columns=["CHILD", "CHILD_KIND", "PARENT", "PARENT_KIND", "CREATED_ON", "GRANTED_BY"]),
        "ugrants": pd.DataFrame([["SYSADMIN", "ALICE", None, "X"]], columns=["ROLE", "USER_NAME", "CREATED_ON", "GRANTED_BY"]),
        "grants": pd.DataFrame([["SYSADMIN", "DATABASE", "DB1", "USAGE", "false"], ["DBR", "ACCOUNT", None, "MONITOR", "true"],
                                ["GONE_ROLE", "TABLE", "DB1.S.T", "SELECT", "false"]],
                               columns=["GRANTEE", "OTYPE", "OBJ", "PRIVILEGE", "GRANT_OPTION"]),
    }
    roles = [{"name": "ACCOUNTADMIN"}, {"name": "SYSADMIN"}]
    users = [{"name": "ALICE", "type": "PERSON"}, {"name": "ADMIN_USER", "type": None}]
    m = model.build_model(frames, roles, users, "ACCT", [["ADMIN_USER", "ACCOUNTADMIN", None, None]])
    ids = [n[0] for n in m["nodes"]]
    assert ids == ["ACCOUNTADMIN", "SYSADMIN", "DBR"] and m["nodes"][0][1] == "sys"
    assert len(m["edges"]) == 2 and len(m["ugrants"]) == 2           # live ACCOUNTADMIN grant merged in
    assert len(m["grants"]) == 8                                        # GONE_ROLE grant dropped, 2 x 4 ints
    assert [o[1] for o in m["objs"]] == ["DB1", "(account)"]            # null object name gets a label
    assert m["grants"][7] == 1                                          # grant option flag


def test_quote_ident_escapes():
    from modules.model import quote_ident
    assert quote_ident('A"B') == '"A""B"'


def test_alert_rule_validation():
    from modules import alerts
    sess = types.SimpleNamespace(sql=lambda *a, **k: types.SimpleNamespace(collect=lambda: []))
    roles, users = (lambda: {"SVC_ROLE"}), (lambda: {"SVC"})
    for bad, msg in [({"role": "NOPE"}, "unknown role"),
                     ({"role": "SVC_ROLE"}, "at least one condition"),
                     ({"role": "SVC_ROLE", "allowed_users": ["X"]}, "unknown user"),
                     ({"role": "SVC_ROLE", "allowed_type": "ROBOT"}, "user type"),
                     ({"role": "SVC_ROLE", "allowed_type": "SERVICE", "email": "a@b"}, "invalid email")]:
        try:
            alerts.save(sess, bad, roles, users)
            raise AssertionError("accepted " + str(bad))
        except ValueError as e:
            assert msg in str(e), (bad, e)
    assert alerts.save(sess, {"role": "SVC_ROLE", "allowed_users": ["svc"], "allowed_type": "service"}, roles, users) == {"saved": "SVC_ROLE"}


def test_watch_spec_validation():
    from modules import watch_kinds as wk
    roles, users = {"ACCOUNTADMIN", "SYSADMIN"}, {"BOB"}
    assert wk.clean_spec("admin_holders", {"roles": ["accountadmin"]}, roles, users) == \
        {"roles": ["ACCOUNTADMIN"], "inherited": True, "allowed_users": []}
    assert wk.clean_spec("sensitive_privilege", {"privileges": ["manage  grants"], "scope": {"databases": ["db1"]}}, roles, users)["scope"] == \
        {"databases": ["DB1"]}
    assert wk.clean_spec("new_principal", {"object": "user", "name_pattern": "*_SVC", "user_type": "person"}, roles, users)["user_type"] == "PERSON"
    for kind, spec, msg in [("admin_holders", {"roles": []}, "at least one role"), ("admin_holders", {"roles": ["NOPE"]}, "unknown role"),
                            ("sensitive_privilege", {"privileges": ["DROP EVERYTHING"]}, "unsupported privilege"),
                            ("sensitive_privilege", {"privileges": ["USAGE"], "scope": {"databases": ["x;drop"]}}, "invalid database"),
                            ("new_principal", {"object": "ROLE", "user_type": "PERSON"}, "users only"),
                            ("new_principal", {"name_pattern": "a'); drop"}, "name pattern"), ("bogus", {}, "unknown alert kind")]:
        try:
            wk.clean_spec(kind, spec, roles, users)
            raise AssertionError(f"accepted {kind} {spec}")
        except ValueError as e:
            assert msg in str(e), (kind, e)


def test_glob_is_literal_except_wildcards():
    from modules.watch_kinds import glob_re, diff
    rx = glob_re("A.B*_SVC")
    assert rx.match("a.bX_svc") and not rx.match("AXB_SVC")
    assert diff({"a": 1, "b": 2}, ["b", "c"]) == (["a"], ["c"])


def test_ask_prompt_and_followups():
    from modules import ask
    big = {"rows": list(range(50000))}
    p = ask.build_prompt({"tab": "graph"}, big, [{"role": "user", "text": "hi"}], "who?")
    assert len(p) < ask.MAX_CTX + 5000 and "more omitted" in p and "User: hi" in p
    text, fus = ask.split_followups('**A** holds it.\n\nFOLLOWUPS: Why? | none | What next?')
    assert text == "**A** holds it." and fus == ["Why?", "What next?"]
    assert ask.answer_text('"x\\ny"') == "x\ny"


def test_parse_draft():
    from modules import alerts
    roles, users = {"ACCOUNTADMIN", "SVC_ROLE"}, {"SVC"}
    ok = alerts.parse_draft('"{\\"ok\\":true,\\"kind\\":\\"admin_holders\\",\\"name\\":\\"x\\",\\"spec\\":{\\"roles\\":[\\"accountadmin\\"]}}"', roles, users)
    assert ok["ok"] and ok["spec"]["roles"] == ["ACCOUNTADMIN"]
    pr = alerts.parse_draft('{"ok":true,"kind":"protected_role","spec":{"role":"svc_role","allowed_users":["svc"],"allowed_type":"service"}}', roles, users)
    assert pr["spec"] == {"role": "SVC_ROLE", "allowed_users": ["SVC"], "allowed_type": "SERVICE", "allowed_parents": None}
    assert not alerts.parse_draft('{"ok":false,"reason":"nope"}', roles, users)["ok"]
    assert "didn't validate" in alerts.parse_draft('{"ok":true,"kind":"admin_holders","spec":{"roles":["GHOST"]}}', roles, users)["reason"]
