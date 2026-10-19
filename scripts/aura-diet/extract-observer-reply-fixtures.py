#!/usr/bin/env python3
"""Extract observer-reply replay fixtures (P3/B1, EC-6) from raw recordings.

Usage: extract-observer-reply-fixtures.py <recordings_dir> <out_dir>

Reads ~/.companion/recordings READ-ONLY. For one Claude and one Codex observer
turn it writes the browser-out `assistant`/`result` frames between the wake and
the turn's `result`:
  <provider>-legacy-turn.jsonl  verbatim (pre-B1 observer: writes the file itself,
                                replies with prose)
  <provider>-reply-turn.jsonl   same frames, the review-file write (tool_use +
                                tool_result) removed and the final text frame's
                                text replaced by a bare findings array (the B1
                                contract). Claude: the findings the observer
                                really wrote in that turn. Codex: the recorded
                                Edit carries no content, so the findings are the
                                ones the same turn reported, reconstructed from
                                $WORK/labeling (marked in the README).
Redaction: absolute workspace root -> /workspace; thinking signatures blanked.
"""
import glob, json, os, re, sys

REC, OUT = sys.argv[1], sys.argv[2]
TURNS = [
    # (provider, recording glob, checkpoint phase, occurrence index)
    ("claude", "4eace61b-9f98-41f4-92f9-1531df8f0454_claude_2026-09-20T00-09*", "council-plan", 0),
    ("codex", "f10ced58-bdb9-4805-a19e-a3622dc866de_codex_2026-09-28T01-29*", "diet-A2", 0),
]
CODEX_FINDINGS = [{
    "severity": "STOP",
    "claim": "The /prime pointer runs `bun run --cwd web kb:record`, which fails; use `bun --cwd web run kb:record`.",
    "evidence_path": ".council/diet-review/A2.diff",
    "confidence": "high",
}]

def redact(obj):
    s = json.dumps(obj, ensure_ascii=False)
    s = s.replace("/root/aura-companion", "/workspace")
    o = json.loads(s)
    for b in o.get("message", {}).get("content", []) if o.get("type") == "assistant" else []:
        if b.get("type") == "thinking":
            b["signature"] = ""
    return o

def turn_frames(fn, phase, occ):
    seen, started, frames = -1, False, []
    for line in open(fn):
        r = json.loads(line)
        if r.get("_header"):
            continue
        raw = r.get("raw", "")
        if r.get("ch") == "cli" and r.get("dir") == "out" and f"Council Checkpoint — {phase}\\n" in raw:
            seen += 1
            if seen == occ:
                started, frames = True, []
            continue
        if not started or r.get("ch") != "browser" or r.get("dir") != "out":
            continue
        try:
            m = json.loads(raw)
        except ValueError:
            continue
        if m.get("type") in ("assistant", "result"):
            frames.append(m)
            if m["type"] == "result":
                return frames
    raise SystemExit(f"turn not found: {fn} {phase} #{occ}")

def is_review_write(b):
    return b.get("type") == "tool_use" and "observer.md" in json.dumps(b.get("input", {}))

for provider, pat, phase, occ in TURNS:
    fn = glob.glob(os.path.join(REC, pat))[0]
    frames = [redact(f) for f in turn_frames(fn, phase, occ)]
    with open(os.path.join(OUT, f"{provider}-legacy-turn.jsonl"), "w") as fh:
        for f in frames:
            fh.write(json.dumps(f, ensure_ascii=False) + "\n")

    write_ids, findings = set(), None
    for f in frames:
        for b in f.get("message", {}).get("content", []) if f["type"] == "assistant" else []:
            if is_review_write(b):
                write_ids.add(b.get("id"))
                content = b.get("input", {}).get("content")
                if content:
                    findings = json.loads(content)["findings"]
    if findings is None:
        findings = CODEX_FINDINGS
    reply = []
    for f in frames:
        if f["type"] == "assistant":
            blocks = f["message"]["content"]
            if any(is_review_write(b) or (b.get("type") == "tool_result" and b.get("tool_use_id") in write_ids) for b in blocks):
                continue
        reply.append(f)
    last_text = max(i for i, f in enumerate(reply)
                    if f["type"] == "assistant" and any(b.get("type") == "text" for b in f["message"]["content"]))
    reply[last_text]["message"]["content"] = [{"type": "text", "text": json.dumps(findings, ensure_ascii=False, indent=2)}]
    with open(os.path.join(OUT, f"{provider}-reply-turn.jsonl"), "w") as fh:
        for f in reply:
            fh.write(json.dumps(f, ensure_ascii=False) + "\n")
    print(provider, phase, "frames", len(frames), "->", len(reply), "findings", len(findings))
