# Critique brief: a single-learner FTCE study app

Paste this whole document into ChatGPT (or any other model) and ask it to critique the design. The closing section has the specific questions worth arguing about.

---

## Prompt to use

> You are reviewing the design of a study app built for one specific learner. Be genuinely critical rather than encouraging. I want to know what is wrong, what is missing, and what is actively counterproductive. Where you disagree with a decision, say so and give the reasoning and the alternative. Where you think a well-known product pattern (Duolingo, Khan Academy, Udemy, Anki, Quizlet, UWorld) would be better, name it and explain the mechanism, not just the feature. Prioritise your critique by expected effect on the one outcome that matters: whether she passes. Ignore anything that is only polish.

---

## 1. The situation

**Learner:** one person. A first-year middle school science teacher in Charlotte County, Florida. Not a student, not a cohort. She teaches the subject daily.

**Stakes:** she must pass the Florida Teacher Certification Exam, **Middle Grades General Science 5–9 (test code 004)**, by the end of the school year to keep teaching the subject next year. This is a job-retention exam, not a credential upgrade.

**Prior attempt:** she failed by roughly **7 scaled points**, described as being about two questions short.

**Exam facts** (from the official Pearson/FLDOE test page):

- 80 multiple-choice questions
- 2 hours 30 minutes
- Passing score is a **scaled 200**
- **No reference materials provided.** Every formula must be memorised.
- Fee $150 per attempt
- Nine competencies with published weights:

| # | Competency | % of test |
|---|---|---|
| 1 | Structure and behavior of matter | 14 |
| 2 | Forces and motion | 13 |
| 3 | Energy and its effects | 12 |
| 4 | Earth and the processes that affect it | 13 |
| 5 | Space science | 6 |
| 6 | Processes of life | 14 |
| 7 | Physical and biological factors on the environment | 10 |
| 8 | The science learning environment | 5 |
| 9 | Process skills and scientific inquiry | 13 |

The state also publishes 92 individual skills beneath those nine competencies. Her stated problem before this build was **not knowing what she was responsible for**. The published skill list is the direct answer to that.

**Critical unknown:** Pearson does **not** publish the raw-to-scaled score conversion. So "7 scaled points" cannot be reliably translated into "N more questions right."

## 2. What was built

`learn.gaitherstephens.com`. Private, single user, PIN plus optional passkey.

### Content

All original, written against the 92 published skills. Nothing copied from commercial prep books.

- **252 practice questions.** Per-competency counts match the published blueprint exactly (35/33/30/33/15/35/25/13/33). Each carries competency, skill number, topic label, difficulty 1–3, four choices, and an explanation.
- **300 flashcards.** Prompts are phrased to force retrieval ("Why does...", "What happens when...") rather than as bare terms.
- **68 concept-guide sections.** Formulas with units and worked examples, markdown tables for anything ordered (EM spectrum, atmospheric layers, taxonomy, rock types), and an explicit `**Trap:**` callout naming the common misconception in every section.
- Florida-specific content is deliberate because the framework calls for it: karst topography, the Floridan aquifer, the carbonate platform, phosphate deposits; Everglades restoration, red tide, Burmese pythons, mangroves, saltwater intrusion.

Difficulty mix is roughly 30% recall, 50% application, 20% multi-step. Correct-answer position is evenly distributed. **Answer choices are shuffled on every presentation**, so explanations name distractors by content, never by letter or position. A build script hard-fails if any explanation references an answer positionally.

### Seven study modes

| Mode | Mechanism | Why |
|---|---|---|
| Flashcards | Leitner boxes, intervals 0/1/3/7/16/35/90 days, self-graded 4 ways | Spaced retrieval |
| Topic quiz | One competency, explanation after every item | Retrieval + immediate elaborative feedback |
| Adaptive drill | 20 items, weighted by (blueprint share × mastery gap), shuffled across competencies | Interleaving, effort targeted at weakness |
| Mock exam | 80 items on the real blueprint, 2:30 clock, no feedback until submit | Test-condition simulation |
| Brain dump | Free recall into a textarea, then self-score against a key-point checklist | Generation effect |
| Concept guide | Reference reading, accordion by section | Encoding, deliberately framed as the weakest mode |
| Missed queue | Only items answered wrong; they leave when answered right | Error-driven practice |

### Scoring and feedback

- **Mastery per competency** = accuracy × min(1, coverage / 0.6). Accuracy is scaled down until she has seen 60% of that competency's questions, so a short hot streak cannot read as mastery.
- **Readiness** = blueprint-weighted mastery × min(1, coverage / 0.5), shown as one percentage with a target mark at 80%. Suppressed entirely below 15 questions answered.
- **No fake scaled score.** Results show raw percent inside a band (Not there yet / Borderline / On track) with an on-screen note that Pearson does not publish the conversion and that prep programs generally treat 72–75% raw as the danger line.

### Motivation layer

Borrowed deliberately, with the manipulative parts removed:

- **Daily goal ring** (default 20 items; cards and questions both count; adjustable to 10/20/30/50).
- **Streak**, which counts consecutive days meeting the goal ending **today or yesterday**, so an unfinished today does not display as broken.
- **Seven-day strip**, read-only, no guilt styling for missed days.
- **Resume card**: one large button computing the single highest-value next action (due cards → missed queue → first quiz → adaptive drill).
- **Session celebration** that praises the act of practising, and reframes a low score as "the missed items are now queued, which is where the easy points are."
- No points, no leaderboard, no lives, no loss aversion, no notifications.

### Technical

Plain Cloudflare Worker plus D1, no framework, no build step. Progress syncs across her phone and laptop; per-record last-write-wins on a timestamp, except daily counters which merge by max so one device cannot erase the other's day. Three themes (system default, light, dark). Verified at 390px with zero horizontal overflow and no tap target under 44px.

## 3. Decisions made deliberately, which are the ones worth attacking

1. **No spaced repetition on questions, only on flashcards.** Questions are scheduled by the adaptive drill's weighting and the missed queue instead of an SM-2 style interval.
2. **Self-graded flashcards** (she judges whether she knew it) rather than typed or multiple-choice recall.
3. **Mastery is deliberately pessimistic.** It is easy to feel like it under-rewards.
4. **No time-per-question tracking** at all, despite the real exam being 2:30 for 80 items (112 seconds each).
5. **No content on test-taking strategy** as such: no elimination technique, no guessing policy, no time-budgeting drill.
6. **The concept guide is static prose.** No worked-example walkthroughs, no diagrams, no video, no interactive simulations.
7. **252 questions total**, so a full 80-item mock exam consumes roughly a third of the bank, and repeated mocks will reuse items she has seen.
8. **Streak and goal are the only motivation mechanics.** No sense of a finish line, no syllabus, no "you are 40% through the material" completion metric distinct from mastery.
9. **She studies alone.** No tutor, no cohort, no accountability partner in the product.
10. **No calibration check**: she is never asked how confident she is before answering, so overconfidence is invisible.

## 4. Known gaps, already suspected

- No study **plan over time**. There is a next-action nudge but no "here is your week given a test date."
- **No test date** is captured anywhere, so nothing can be paced backwards from it.
- Reused mock exam items will inflate later mock scores.
- Self-grading on flashcards is vulnerable to the exact overconfidence that produces a 7-point miss.
- The brain dump is the most effortful mode and therefore the most likely to be avoided.
- Nothing exploits the fact that **she teaches this material daily**, which is an unusually strong retrieval opportunity most test-takers do not have.

## 5. Questions to argue about

1. Given a 7-scaled-point miss, is broad coverage across all nine competencies the right strategy, or should effort concentrate on the four heaviest (matter, life, forces, earth = 54% combined)? What does the marginal-return maths actually favour?
2. Is a 252-item bank enough for an 80-item exam? What is the right ratio, and what breaks first when items get reused?
3. Should questions be on a spaced-repetition schedule like the flashcards, or does the missed queue plus adaptive weighting accomplish the same thing more simply?
4. Self-graded flashcards versus forced typed recall: does the extra friction pay for itself for a learner who has already failed once by a small margin?
5. Is the streak mechanic net positive here, or is it a liability for an adult with a demanding job who will miss days and may then disengage? What did Duolingo actually learn about this?
6. Time pressure is 112 seconds per question. Should the app track and train pace explicitly, and how, without making practice miserable?
7. Is showing a "readiness percentage" honest, or does it invent precision that the underlying data does not support? Is a band or a confidence interval better?
8. What does Khan Academy's mastery model do that this does not, and does the difference matter at n=1?
9. How should the product exploit her teaching her own classes daily? Is there a real mechanism, or is that a nice idea with no implementation?
10. What is the single highest-leverage thing missing, judged only by probability of passing?
11. Where is this over-built? What should be deleted?
12. Is the absence of explicit test-taking strategy content a real gap or a distraction from content mastery?

## 6. Ground rules for the critique

- Judge against **one outcome**: does she pass. Not engagement, not retention, not elegance.
- Assume a solo builder who can ship changes the same day. Effort estimates should be in hours, not sprints.
- Do not recommend buying a commercial prep course as the main answer. Assume the app is the vehicle. Recommending it as a supplement is fine if justified.
- Be specific. "Add gamification" is useless. "Replace self-graded flashcards with typed recall for the 40 formula cards, because production is what fails under exam pressure" is useful.
- If a decision above is defensible, say so plainly and move on. Do not manufacture criticism to fill space.
