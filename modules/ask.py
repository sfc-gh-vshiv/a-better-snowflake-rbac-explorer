"""Ask bot: one AI_COMPLETE per turn over the RBAC facts the browser already holds.

The frontend sends the page context (account summary, current tab, facts for every role
or user named in the question) plus the last turns. Nothing here runs new data SQL.
"""
from __future__ import annotations

import json
import re

MODEL = "claude-sonnet-4-5"
SQL = "SELECT AI_COMPLETE(?, ?, {'temperature': 0.2, 'max_tokens': 1200}) AS A"
MAX_CTX = 80_000

_RULES = """You are the assistant inside Role Explorer, an app that maps Snowflake roles, users and grants.
Answer the user's question using ONLY the data in <rbac_data>. Rules:
- Name roles, users and privileges exactly as they appear in the data.
- If the data doesn't contain the answer, say what is missing and which tab of the app shows it
  (Hierarchy, Role 360, Who can access?, Users, Hygiene, Revoke what-if, Alerts). Never invent grants.
- Role edges, user grants and object privileges come from ACCOUNT_USAGE, which can be up to 2 hours behind;
  mention that when the user asks about something very recent.
- "Effective" access means directly granted or inherited through parent roles.
- Be concise: a short answer first, then at most 6 bullets. No tables. Markdown bold and bullets are fine.
- If the user wants to be notified about something, tell them they can click "Alert me about this".
- End with one line: FOLLOWUPS: <question> | <question> (two short follow-up questions, or none)."""


def _shrink(ctx, limit: int = MAX_CTX):
    """Halve the longest lists until the JSON fits, rather than cutting the text mid-structure."""
    for _ in range(40):
        s = json.dumps(ctx, default=str, separators=(",", ":"))
        if len(s) <= limit:
            return ctx
        best, path = None, None

        def walk(o, p):
            nonlocal best, path
            if isinstance(o, list) and len(o) > 2 and (best is None or len(o) > len(best)):
                best, path = o, p
            items = o.items() if isinstance(o, dict) else enumerate(o) if isinstance(o, list) else []
            for k, v in items:
                walk(v, p + [k])
        walk(ctx, [])
        if best is None:
            break
        keep = max(2, len(best) // 2)
        del best[keep:]
        best.append(f"...{keep} shown, more omitted")
    return ctx


def build_prompt(page, ctx, history, question) -> str:
    ctx = _shrink(json.loads(json.dumps(ctx or {}, default=str)))
    turns = []
    for t in (history or [])[-8:]:
        role = "User" if t.get("role") == "user" else "Assistant"
        turns.append(f"{role}: {str(t.get('text') or '')[:2000]}")
    return (f"{_RULES}\n\n<page>{json.dumps(page or {}, default=str)[:2000]}</page>\n"
            f"<rbac_data>{json.dumps(ctx, default=str, separators=(',', ':'))}</rbac_data>\n"
            f"<conversation>\n{chr(10).join(turns)}\n</conversation>\n"
            f"User question: {str(question or '')[:1000]}\nAnswer:")


def answer_text(raw) -> str:
    """AI_COMPLETE returns a JSON string literal; unwrap it."""
    if raw is None:
        return ""
    s = str(raw)
    try:
        v = json.loads(s)
        if isinstance(v, str):
            return v.strip()
    except ValueError:
        pass
    return s.strip()


_FU = re.compile(r"\n?\s*FOLLOWUPS:\s*(.*)\s*$", re.I | re.S)


def split_followups(text: str) -> tuple[str, list[str]]:
    m = _FU.search(text)
    if not m:
        return text.strip(), []
    fus = [q.strip(" -*\n") for q in m.group(1).split("|")]
    fus = [q for q in fus if q and q.lower() != "none"][:3]
    return text[:m.start()].strip(), fus


def post(frames) -> dict:
    text, fus = split_followups(answer_text(frames["a"].iloc[0, 0]))
    return {"text": text, "followups": fus}
