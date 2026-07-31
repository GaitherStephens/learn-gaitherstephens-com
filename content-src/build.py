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

# Questions are drawn individually and shuffled, so a stem that leans on a
# scenario set up in a DIFFERENT question is unanswerable when it appears
# alone. Meg hit exactly this: three questions said "that tomato fertilizer
# investigation" while only a fourth described it. A stem must stand by itself.
CROSS_REF = [
    # a demonstrative pointing at a scenario, e.g. "that same X investigation"
    r"(?i)\b(that|this|the)\s+(?:same\s+)?(?:\w+\s+){0,3}"
    r"(investigation|experiment|study|trial|setup|scenario|activity|procedure|lab)\b",
    # explicit pointers to neighbouring items
    r"(?i)\b(previous|preceding|prior|earlier|above|next|following)\s+(question|item|problem)\b",
    r"(?i)\bquestion\s+\d+\b",
]

# Signs that a stem describes its OWN scenario rather than borrowing one.
SETUP_PRESENT = [
    r"(?i)\b(a|an|one|two|three|four|several)\s+(student|teacher|scientist|researcher|class|group|technician)\b",
    r"(?i)\b(grows?|measures?|designs?|sets? up|tests?|places?|heats?|cools?|records?|conducts?|performs?|mixes?|drops?|observes?|compares?|builds?|adds?)\b",
    r"\d+\s*(mL|L|g|kg|cm|m|km|s|min|N|J|W|V|A|°C|K|%)",
]

def stem_is_self_contained(stem: str) -> bool:
    """A stem may say "this investigation" only if it also describes the
    investigation. Counting words before the reference was the wrong test: it
    passed "...for every group in the tomato fertilizer investigation?" because
    the reference came late, and failed legitimate stems that opened with a
    demonstrative and explained themselves afterwards."""
    has_backref = any(re.search(p, stem) for p in CROSS_REF)
    if not has_backref:
        return True
    # Pointers at neighbouring items are never rescuable by context.
    for p in CROSS_REF[1:]:
        if re.search(p, stem):
            return False
    return any(re.search(p, stem) for p in SETUP_PRESENT)

def main():
    Q, F = [], []
    for f in sorted(glob.glob(os.path.join(HERE, "q_*.json"))):
        Q += json.load(open(f))
    for f in sorted(glob.glob(os.path.join(HERE, "f_*.json"))):
        F += json.load(open(f))
    G = json.load(open(os.path.join(HERE, "guide.json")))
    SK = json.load(open(os.path.join(HERE, "skills.json")))

    errs = []
    seen = set()
    for q in Q:
        required = {"id","comp","skill","topic","difficulty","stem","choices","answer","explanation"}
        extra = set(q) - required
        if not set(q) >= required or extra - {"guide"}:
            errs.append(f"{q.get('id')}: wrong keys ({sorted(set(q))})")
        # `guide` is [competency, sectionIndex] and must point at a real section
        gref = q.get("guide")
        if gref is not None:
            if (not isinstance(gref, list) or len(gref) != 2
                    or str(gref[0]) not in {str(c["comp"]) for c in G}
                    or not (0 <= gref[1] < len(next(c["sections"] for c in G if c["comp"] == gref[0])))):
                errs.append(f"{q['id']}: guide link {gref} does not resolve to a section")
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
        if not stem_is_self_contained(q["stem"]):
            errs.append(f"{q['id']}: stem leans on a scenario from another question, "
                        f"so it cannot be answered on its own: {q['stem'][:70]}...")
    fseen = set()
    for c in F:
        allowed = {"id","comp","topic","front","back"}
        extra = set(c) - allowed
        if not set(c) >= allowed or extra - {"drill","answers"}:
            errs.append(f"{c.get('id')}: wrong flashcard keys ({sorted(set(c))})")
        if c["id"] in fseen:
            errs.append(f"{c['id']}: duplicate flashcard id")
        fseen.add(c["id"])
        if c.get("drill") == "type":
            ans = c.get("answers")
            if not isinstance(ans, list) or not ans or not all(isinstance(a, str) and a.strip() for a in ans):
                errs.append(f"{c['id']}: drill=type needs a non-empty answers list")

    # Skill framework: every question must point at a real skill, and every
    # skill needs at least one question or the coverage map lies to her.
    counts = {int(k): len(v) for k, v in SK.items()}
    if sum(counts.values()) != 101:
        errs.append(f"expected 101 skills, found {sum(counts.values())}")
    have = collections.defaultdict(set)
    for q in Q:
        if not (1 <= q["skill"] <= counts.get(q["comp"], 0)):
            errs.append(f"{q['id']}: skill {q['skill']} does not exist in competency {q['comp']}")
        else:
            have[q["comp"]].add(q["skill"])
    for c in sorted(counts):
        for s in range(1, counts[c] + 1):
            if s not in have[c]:
                errs.append(f"competency {c} skill {s} has no question")

    if errs:
        print("BUILD FAILED:", file=sys.stderr)
        for e in errs:
            print("  " + e, file=sys.stderr)
        sys.exit(1)

    out = {
        "meta": {"test": "FTCE Middle Grades General Science 5-9 (004)",
                 "questions": 80, "minutes": 150, "passing": "scaled 200"},
        "comps": [{"comp": k, "title": v[0], "pct": v[1]} for k, v in sorted(COMPS.items())],
        "questions": Q, "cards": F, "guide": G, "skills": SK,
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    typed = sum(1 for c in F if c.get("drill") == "type")
    print(f"OK: {len(Q)} questions, {len(F)} cards ({typed} typed-recall), "
          f"{len(G)} guides, {sum(len(v) for v in SK.values())} skills")
    print("  by competency:", dict(sorted(collections.Counter(q["comp"] for q in Q).items())))

if __name__ == "__main__":
    main()
