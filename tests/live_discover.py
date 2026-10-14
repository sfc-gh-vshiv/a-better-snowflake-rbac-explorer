"""Manual check: discover the demo bundles against a live account as RBAC_EXPLORER_ROLE.
Run: RBAC_CONNECTION=<conn> python tests/live_discover.py"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from snowflake.snowpark import Session  # noqa: E402

from modules import asset_kinds as ak  # noqa: E402

s = Session.builder.config("connection_name", os.environ.get("RBAC_CONNECTION", "default")).create()
s.sql("USE ROLE RBAC_EXPLORER_ROLE").collect()
s.sql(f"USE WAREHOUSE {os.environ.get('RBAC_WAREHOUSE', 'COMPUTE_WH')}").collect()

b = ak.build(s, "agent", "DEMO_SALES_DB.CORE.DEMO_SALES_AGENT")
for i in b["items"]:
    print(f"{i['otype']:<22} {i['fqn']:<45} {i['priv']:<7} live={i.get('live')} {i.get('error', '')}")
print("warnings:", [w for n in ak._walk(b["tree"]) for w in n["warnings"]])
print("rights:", [(n["kind"], n.get("rights")) for n in ak._walk(b["tree"])])
print(json.dumps(ak.fix_sql(b, "DEMO_SALES_TEAM_ROLE", False), indent=1))
print(all(ak.allowed(x) for x in ak.fix_sql(b, "DEMO_SALES_TEAM_ROLE", True)))
skill = open(os.path.join(os.path.dirname(__file__), "../demo/skills/demo-sales-skill/SKILL.md")).read()
k = ak.build(s, "skill", text=skill, learned=ak.learn(s, "DEMO_SALES_AUTHOR", 14, False))
print("skill:", [(i["otype"], i["fqn"], i["source"], i.get("suggested")) for i in k["items"]])
print("skill warnings:", [w for n in ak._walk(k["tree"]) for w in n["warnings"]])
