// Question-pool engine tests — validates the ADC 5-tries rule against the REAL
// engine code (extracted from public/ADC_POC_3D.html at runtime, so the test
// can never drift from what ships) and BOTH real question banks.
//
// ADC rule under test:
//   - the pool changes the questions on each of tries 1..5 (different draw per try)
//   - a trainee who fails all 5 keeps trying: the same five draws repeat from
//     try 6, but the question SEQUENCE is different on every try
//
// Run: node tests/engine.test.js
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "ADC_POC_3D.html"), "utf8");
const grab = (re, what) => {
  const m = html.match(re);
  if (!m) { console.error("FATAL: could not extract " + what); process.exit(2); }
  return m[0];
};

// pull the exact engine source out of the page
const src = [
  grab(/function rng\(seed\)\{[^\n]*\n?/, "rng"),
  grab(/function hash\(str\)\{[^\n]*\n?/, "hash"),
  grab(/function shuffled\(arr,r\)\{[^\n]*\n?/, "shuffled"),
  grab(/const COMBOS=\[\];[^\n]*\n?/, "COMBOS"),
  grab(/function qbank\(sk\)\{[\s\S]*?\n\}/, "qbank"),
  grab(/function draw\(attempt\)\{[\s\S]*?\n\}/, "draw"),
].join("\n");

const CONTENT = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "strategic_thinker_L1_content.json"), "utf8"));
const L2C = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "strategic_thinker_L2_content.json"), "utf8"));

// evaluate the engine with the globals it expects (S is set per scenario)
let S = null;
eval(src);

let passN = 0, failN = 0;
const ok = (cond, msg) => { if (cond) { passN++; } else { failN++; console.error("  FAIL: " + msg); } };
const setOf = st => st.map(b => b.q.id).slice().sort().join("|"); // order-independent per-station set
const seqOf = per => per.flat().map(b => b.q.id).join(">");        // full 24-question sequence

function scenario(name, level) {
  const suffix = level > 1 ? "-L" + level : "";
  S = { trainee: name, level, seed: hash(name + "|adc-poc" + suffix) };
  console.log(`\n== ${name} · Level ${level} ==`);

  const draws = [];
  for (let a = 1; a <= 12; a++) draws[a] = draw(a);

  // shape: 6 stations × 4 questions, all from the right bank, no duplicates in a try
  const bank = level === 2 ? L2C : CONTENT;
  const bankIds = new Set(bank.skills.flatMap(s => s.questions.map(q => q.id)));
  for (let a = 1; a <= 12; a++) {
    const flat = draws[a].flat();
    ok(draws[a].length === 6 && flat.length === 24, `try ${a}: 6 stations x 4 beats`);
    ok(flat.every(b => bankIds.has(b.q.id)), `try ${a}: every question comes from the Level-${level} bank`);
    ok(new Set(flat.map(b => b.q.id)).size === 24, `try ${a}: no duplicate question inside the try`);
  }

  // rule 1 — tries 1..5 give a DIFFERENT draw on every try (per skill and overall)
  for (let skill = 0; skill < 6; skill++) {
    const sets = [1, 2, 3, 4, 5].map(a => setOf(draws[a][skill]));
    ok(new Set(sets).size === 5, `skill ${skill + 1}: tries 1-5 use 5 different question sets`);
  }

  // rule 2 — try 6+ replays the same pool: 6↔1, 7↔2, … 10↔5, 11↔1
  for (const [a, b] of [[6, 1], [7, 2], [8, 3], [9, 4], [10, 5], [11, 1], [12, 2]]) {
    for (let skill = 0; skill < 6; skill++)
      ok(setOf(draws[a][skill]) === setOf(draws[b][skill]), `skill ${skill + 1}: try ${a} replays try ${b}'s questions`);
  }

  // rule 3 — but never in the same sequence
  for (const [a, b] of [[6, 1], [7, 2], [10, 5], [11, 1], [11, 6]]) {
    ok(seqOf(draws[a]) !== seqOf(draws[b]), `try ${a} sequence differs from try ${b}`);
  }

  // determinism — resume/relogin rebuilds the identical plan
  ok(seqOf(draw(3)) === seqOf(draws[3]), "draw(3) is deterministic (resume-safe)");

  // different trainees get different pools (seeded per name)
  return seqOf(draws[1]);
}

const a1 = scenario("Ramy", 1);
scenario("Ramy", 2);
const b1 = scenario("Maitha", 1);
console.log("\n== cross-checks ==");
ok(a1 !== b1, "different trainees draw different try-1 sequences");

// level isolation: same trainee, L1 vs L2 draws come from different banks
S = { trainee: "Ramy", level: 1, seed: hash("Ramy|adc-poc") };
const l1ids = new Set(draw(1).flat().map(b => b.q.id));
S = { trainee: "Ramy", level: 2, seed: hash("Ramy|adc-poc-L2") };
const l2ids = new Set(draw(1).flat().map(b => b.q.id));
ok([...l1ids].every(id => !id.startsWith("L2")), "Level 1 draws only L1 questions");
ok([...l2ids].every(id => id.startsWith("L2")), "Level 2 draws only L2 questions");

console.log(`\n${passN} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
