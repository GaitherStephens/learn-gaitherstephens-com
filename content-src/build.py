#!/usr/bin/env python3
"""Assemble public/content.json from the per-competency source banks.

Run from this directory:  python3 build.py
Fails loudly if any explanation references an answer by position, because the
app shuffles choices on every presentation.
"""
import json, glob, re, os, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "content.json")

COMPS = {
    1: ("Structure and behavior of matter", 14),
    2: ("Forces and motion", 13),
    3: ("Energy and its effects", 12),
    4: ("Earth and the processes that affect it", 13),
    5: ("Space science", 6),
    6: ("Processes of life", 14),
    7: ("Physical and biological factors on the environment", 10),
    8: ("The science learning environment", 5),
    9: ("Process skills and scientific inquiry", 13),
}

POSITIONAL = [
    r"\b(?:[Cc]hoices?|[Oo]ptions?|[Aa]nswers?|[Dd]istractors?)\s+\(?[A-D]\b",
    r"(?i)\b(?:first|second|third|fourth|last)\s+(?:choice|option|answer)\b",
    r"(?i)\bchoices?\s+(?:one|two|three|four)\b",
    r"\bletter\s+[A-D]\b",
]

def main():
    Q, F = [], []
    for f in sorted(glob.glob(os.path.join(HERE, "q_*.json"))):
        Q += json.load(open(f))
    for f in sorted(glob.glob(os.path.join(HERE, "f_*.json"))):
        F += json.load(open(f))
    G = json.load(open(os.path.join(HERE, "guide.json")))

    errs = []
    seen = set()
    for q in Q:
        if set(q) != {"id","comp","skill","topic","difficulty","stem","choices","answer","explanation"}:
            errs.append(f"{q.get('id')}: wrong keys")
        if q["id"] in seen:
            errs.append(f"{q['id']}: duplicate id")
        seen.add(q["id"])
        if len(q["choices"]) != 4 or len(set(q["choices"])) != 4:
            errs.append(f"{q['id']}: needs 4 distinct choices")
        if not isinstance(q["answer"], int) or not 0 <= q["answer"] < 4:
            errs.append(f"{q['id']}: answer index out of range")
        for p in POSITIONAL:
            if re.search(p, q["explanation"]):
                errs.append(f"{q['id']}: explanation references an answer by position")
    fseen = set()
    for c in F:
        if set(c) != {"id","comp","topic","front","back"}:
            errs.append(f"{c.get('id')}: wrong flashcard keys")
        if c["id"] in fseen:
            errs.append(f"{c['id']}: duplicate flashcard id")
        fseen.add(c["id"])

    if errs:
        print("BUILD FAILED:", file=sys.stderr)
        for e in errs:
            print("  " + e, file=sys.stderr)
        sys.exit(1)

    out = {
        "meta": {"test": "FTCE Middle Grades General Science 5-9 (004)",
                 "questions": 80, "minutes": 150, "passing": "scaled 200"},
        "comps": [{"comp": k, "title": v[0], "pct": v[1]} for k, v in sorted(COMPS.items())],
        "questions": Q, "cards": F, "guide": G,
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"OK: {len(Q)} questions, {len(F)} cards, {len(G)} guides")
    print("  by competency:", dict(sorted(collections.Counter(q["comp"] for q in Q).items())))

if __name__ == "__main__":
    main()
