#!/usr/bin/env python3
"""Map each question to the guide section that best explains it.

Done at build time, not at runtime, so the mapping can be inspected and
scored before it ships. A wrong answer offers a "learn this" link, and a link
that lands on the wrong section is worse than no link at all.
"""
import json, os, re, collections

HERE = os.path.dirname(os.path.abspath(__file__))

STOP = set("""a an the of and or to in on for with is are was were be been being it its as at by from
this that these those which what when where how why can could may might will would should must not no
if then than there their them they he she his her you your i we our us do does did done have has had
each other more most some any all both few many much such own same so only very just also into over
under about between during before after above below up down out off again further once here why how""".split())

def toks(s):
    return [w for w in re.findall(r"[a-z]+", s.lower()) if len(w) > 2 and w not in STOP]

def main():
    guide = json.load(open(os.path.join(HERE, "guide.json")))
    by_comp = {g["comp"]: g["sections"] for g in guide}

    # Per-section token weights: heading terms count far more than body terms,
    # because a heading names the concept while a body mentions many.
    profiles = {}
    for comp, secs in by_comp.items():
        profiles[comp] = []
        for s in secs:
            w = collections.Counter()
            for t in toks(s["h"]):
                w[t] += 6
            for t in toks(s["body"])[:600]:
                w[t] += 1
            profiles[comp].append(w)

    qfiles = sorted(f for f in os.listdir(HERE) if f.startswith("q_") and f.endswith(".json"))
    total = weak = 0
    report = []
    for fn in qfiles:
        path = os.path.join(HERE, fn)
        qs = json.load(open(path))
        for q in qs:
            comp = q["comp"]
            # Topic is the strongest signal, then the stem, then the explanation.
            query = collections.Counter()
            for t in toks(q["topic"]):
                query[t] += 5
            for t in toks(q["stem"]):
                query[t] += 2
            for t in toks(q["explanation"])[:120]:
                query[t] += 1

            # Search EVERY section, not just this competency's. The blueprint
            # puts waves, electricity and magnetism under competency 2, but the
            # guide explains them under competency 3, and a "learn this" link
            # must go where the explanation actually lives. Same-competency
            # sections get a modest bonus so the usual case still wins.
            best, best_score = (comp, 0), -1
            for c2, profs in profiles.items():
                for i, prof in enumerate(profs):
                    score = sum(prof[t] * n for t, n in query.items())
                    score /= (sum(prof.values()) ** 0.5) or 1
                    if c2 == comp:
                        score *= 1.25
                    if score > best_score:
                        best, best_score = (c2, i), score
            q["guide"] = list(best)
            total += 1
            if best_score < 1.2:
                weak += 1
                report.append((q["id"], q["topic"], f"c{best[0]}: " + by_comp[best[0]][best[1]]["h"], round(best_score, 2)))
        json.dump(qs, open(path, "w"), ensure_ascii=False)

    print(f"mapped {total} questions")
    print(f"weak matches (score < 1.0): {weak}")
    for r in report[:15]:
        print("   ", r)

if __name__ == "__main__":
    main()
