"""Re-entry skill run profiler: `python3 -I scripts/ladder-profile.py [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--runs]`.

Reads the machine-local session transcripts (~/.claude/projects/<repo-path slug>*/*.jsonl), finds every
fresh-session /eufin · /value · /semis · /spit · /sp500 run (a `<command-name>/<leg>` user turn), de-duplicates the assistant usage rows by
message id (the JSONL repeats one per content block — a naive sum over-counts ~4x) and prints per-leg means: turns, cache
read/create, output, WebSearch (extended), WebFetch, single-web-call turns, result tokens by tool, and the cost-equivalent
(read x0.1 + create x1.25 + output x5, relative to base input). `--runs` prints every run too. Runs with < 5 turns or no Bash
call (aborted) are skipped.
"""

import collections
import glob
import json
import os
import re
import statistics
import sys

args = dict(
    a[2:].split("=", 1) if "=" in a else (a[2:], "1")
    for a in sys.argv[1:]
    if a.startswith("--")
)
since, until = args.get("since", "0000"), args.get("until", "9999")
# Claude Code's transcript dir = the repo path with every non-alphanumeric char -> "-".
SLUG = re.sub(r"[^a-zA-Z0-9]", "-", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
rows = []
for p in glob.glob(os.path.expanduser(f"~/.claude/projects/{SLUG}*/*.jsonl")):
    cur, ids = None, {}
    for line in open(p, errors="ignore"):
        try:
            m = json.loads(line)
        except Exception:
            continue
        msg = m.get("message") or {}
        c = msg.get("content")
        if m.get("type") == "user":
            txt = (
                c
                if isinstance(c, str)
                else "".join(
                    x.get("text", "") for x in (c or []) if isinstance(x, dict)
                )
            )
            hit = re.search(r"<command-name>/(eufin|value|semis|spit|sp500)<", txt)
            if hit:
                cur = {
                    "leg": hit.group(1),
                    "date": (m.get("timestamp") or "")[:10],
                    "msgs": {},
                    "res": collections.Counter(),
                }
                rows.append(cur)
                continue
            if cur and isinstance(c, list):
                for x in c:
                    if isinstance(x, dict) and x.get("type") == "tool_result":
                        s = x.get("content")
                        s = s if isinstance(s, str) else json.dumps(s)
                        cur["res"][ids.get(x.get("tool_use_id"), "?")] += len(s) // 4
            if cur and isinstance(c, str) and c.strip() and not c.startswith("<"):
                cur = None
        elif (
            m.get("type") == "assistant" and cur and msg.get("usage") and msg.get("id")
        ):
            u = msg["usage"]
            t = cur["msgs"].setdefault(
                msg["id"],
                {
                    "read": u.get("cache_read_input_tokens", 0),
                    "create": u.get("cache_creation_input_tokens", 0),
                    "out": u.get("output_tokens", 0),
                    "tools": [],
                },
            )
            for x in c or []:
                if isinstance(x, dict) and x.get("type") == "tool_use":
                    ids[x["id"]] = x["name"]
                    t["tools"].append(
                        x["name"]
                        + (
                            "x"
                            if x["name"] == "WebSearch"
                            and '"extended"' in json.dumps(x.get("input"))
                            else ""
                        )
                    )

WEB = {"WebSearch", "WebSearchx", "WebFetch"}
per = collections.defaultdict(list)
for r in rows:
    ms = list(r["msgs"].values())
    if (
        len(ms) < 5
        or not any("Bash" in t["tools"] for t in ms)
        or not (since <= r["date"] <= until)
    ):
        continue
    tl = collections.Counter(x for t in ms for x in t["tools"])
    rd, cr, ou = (sum(t[k] for t in ms) for k in ("read", "create", "out"))
    single = sum(1 for t in ms if len(t["tools"]) == 1 and t["tools"][0] in WEB)
    rec = dict(
        turns=len(ms),
        read=rd,
        create=cr,
        out=ou,
        ws=tl["WebSearch"] + tl["WebSearchx"],
        ext=tl["WebSearchx"],
        wf=tl["WebFetch"],
        single=single,
        resWS=r["res"]["WebSearch"],
        resWF=r["res"]["WebFetch"],
        resBash=r["res"]["Bash"],
        equiv=rd * 0.1 + cr * 1.25 + ou * 5,
    )
    per[r["leg"]].append(rec)
    if "runs" in args:
        print(
            f"{r['leg']:5s} {r['date']} turns={rec['turns']:2d} read={rd / 1e6:4.2f}M create={cr / 1e3:3.0f}k out={ou / 1e3:2.0f}k WS={rec['ws']:2d} ext={rec['ext']} WF={rec['wf']:2d} single={single} equiv={rec['equiv'] / 1e3:4.0f}k"
        )

print(f"window {since}..{until}")
print(
    "leg    n   turns  read    create  out  WS(ext)   WF   single  resTok WS/WF/Bash      cost-equiv"
)
for leg in ("eufin", "value", "semis", "spit", "sp500"):
    rs = per.get(leg)
    if not rs:
        print(f"{leg:5s}  0")
        continue

    def mean(k):
        return statistics.fmean(x[k] for x in rs)

    print(
        f"{leg:5s} {len(rs):2d}  {mean('turns'):4.1f}   {mean('read') / 1e6:4.2f}M   {mean('create') / 1e3:3.0f}k    {mean('out') / 1e3:2.0f}k  {mean('ws'):3.1f}({mean('ext'):3.1f})  {mean('wf'):3.1f}  {mean('single'):4.1f}   {mean('resWS') / 1e3:3.1f}k/{mean('resWF') / 1e3:3.1f}k/{mean('resBash') / 1e3:3.1f}k    {mean('equiv') / 1e3:4.0f}k"
    )
