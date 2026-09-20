// Run:  node --experimental-strip-types src/lib/sync/llm-core.test.mjs
// No node_modules required, by design — see llm-core.ts.

import assert from "node:assert/strict";
import {
  sessionNeedsWork,
  noteNeedsWork,
  buildTranslationPrompt,
  buildSynthesisPrompt,
  extractJsonObject,
  keepKnownIds,
  keepKnownSoNumbers,
} from "./llm-core.ts";

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// ---- needs flags ---------------------------------------------------------

t("session with no needs is skipped", () => {
  assert.equal(sessionNeedsWork({ id: 1, needs: {} }), false);
  assert.equal(sessionNeedsWork({ id: 1 }), false);
  assert.equal(sessionNeedsWork({ id: 1, needs: null }), false);
});

t("session needing either field is kept", () => {
  assert.equal(sessionNeedsWork({ id: 1, needs: { summary: true } }), true);
  assert.equal(sessionNeedsWork({ id: 1, needs: { other_business: true } }), true);
});

t("note needs flags behave the same", () => {
  assert.equal(noteNeedsWork({ id: 1, needs: { note: true } }), true);
  assert.equal(noteNeedsWork({ id: 1, needs: { action_items: true } }), true);
  assert.equal(noteNeedsWork({ id: 1, needs: {} }), false);
});

// ---- prompt building -----------------------------------------------------

t("prompt sends ONLY the fields whose needs flag is set", () => {
  const p = buildTranslationPrompt(
    [{ id: 7, summary_md: "NEEDED", other_business: "ALREADY_DONE",
       needs: { summary: true, other_business: false } }],
    [],
  );
  assert.ok(p.includes("NEEDED"));
  // Translating an already-translated field overwrites good Spanish for no
  // reason; that is the whole point of the filter.
  assert.ok(!p.includes("ALREADY_DONE"));
});

t("rows needing nothing never reach the prompt", () => {
  const p = buildTranslationPrompt(
    [{ id: 1, summary_md: "SHOULD_NOT_APPEAR", needs: {} }],
    [{ id: 2, note_md: "ALSO_NOT", needs: {} }],
  );
  assert.ok(!p.includes("SHOULD_NOT_APPEAR"));
  assert.ok(!p.includes("ALSO_NOT"));
});

t("both prompts carry the identifier rule", () => {
  for (const p of [
    buildTranslationPrompt([], []),
    buildSynthesisPrompt([{ so_number: "1" }]),
  ]) {
    assert.ok(p.includes("Purechews"), "identifier example must survive");
  }
});

t("synthesis prompt demands both languages", () => {
  const p = buildSynthesisPrompt([{ so_number: "14693" }]);
  assert.ok(p.includes("points_es"));
  assert.ok(p.includes("headline_es"));
});

// ---- JSON extraction -----------------------------------------------------

t("parses a bare object", () => {
  assert.deepEqual(extractJsonObject('{"ok":true}'), { ok: true });
});

t("parses through surrounding prose", () => {
  assert.deepEqual(
    extractJsonObject('Here you go:\n{"a":1}\nHope that helps!'),
    { a: 1 },
  );
});

t("parses through a markdown fence", () => {
  assert.deepEqual(
    extractJsonObject('```json\n{"a":[1,2]}\n```'),
    { a: [1, 2] },
  );
});

t("a brace inside a string does not end the object", () => {
  // Real translated content contains braces. A naive lastIndexOf('}') or a
  // depth counter that ignores strings truncates here.
  const out = extractJsonObject('{"text":"usar {llave} aqui","n":2}');
  assert.deepEqual(out, { text: "usar {llave} aqui", n: 2 });
});

t("an escaped quote does not end the string", () => {
  const out = extractJsonObject('{"text":"dijo \\"hola\\" ayer"}');
  assert.equal(out.text, 'dijo "hola" ayer');
});

t("nested objects survive", () => {
  const out = extractJsonObject('{"a":{"b":{"c":1}},"d":2}');
  assert.deepEqual(out, { a: { b: { c: 1 } }, d: 2 });
});

t("no object at all throws", () => {
  assert.throws(() => extractJsonObject("I could not do that"), /no JSON object/);
});

t("unbalanced object throws rather than half-parsing", () => {
  assert.throws(() => extractJsonObject('{"a":1'), /unbalanced/);
});

// ---- id guarding ---------------------------------------------------------

t("invented ids are dropped", () => {
  // Writing onto an id we never asked about would corrupt an unrelated row.
  const kept = keepKnownIds([{ id: 1 }, { id: 999 }], [1, 2]);
  assert.deepEqual(kept, [{ id: 1 }]);
});

t("ids match across string/number", () => {
  assert.equal(keepKnownIds([{ id: "5" }], [5]).length, 1);
  assert.equal(keepKnownIds([{ id: 5 }], ["5"]).length, 1);
});

t("non-array and malformed rows are tolerated", () => {
  assert.deepEqual(keepKnownIds(undefined, [1]), []);
  assert.deepEqual(keepKnownIds("nope", [1]), []);
  assert.deepEqual(keepKnownIds([null, 3, { nope: 1 }], [1]), []);
});

t("so_number guarding behaves the same", () => {
  const kept = keepKnownSoNumbers(
    [{ so_number: "14693" }, { so_number: "00000" }],
    ["14693"],
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].so_number, "14693");
});

console.log(`${passed} passed`);

// ---- freshness -----------------------------------------------------------

import { isFresh, selectStale, newestInputTime } from "./llm-core.ts";

t("no existing synthesis is never fresh", () => {
  assert.equal(isFresh({ so_number: "1" }), false);
  assert.equal(isFresh({ so_number: "1", existing_synthesis: null }), false);
});

t("synthesis newer than every input is fresh", () => {
  assert.equal(isFresh({
    so_number: "1",
    fishbowl: { synced_at: "2026-09-19T10:00:00Z" },
    existing_synthesis: { generated_at: "2026-09-20T10:00:00Z" },
  }), true);
});

t("synthesis older than an input is stale", () => {
  assert.equal(isFresh({
    so_number: "1",
    fishbowl: { synced_at: "2026-09-21T10:00:00Z" },
    existing_synthesis: { generated_at: "2026-09-20T10:00:00Z" },
  }), false);
});

t("a newer Monday update alone makes it stale", () => {
  assert.equal(isFresh({
    so_number: "1",
    fishbowl: { synced_at: "2026-09-01T00:00:00Z" },
    monday: { updates: [{ created_at: "2026-09-25T00:00:00Z" }] },
    existing_synthesis: { generated_at: "2026-09-20T00:00:00Z" },
  }), false);
});

t("a newer meeting alone makes it stale", () => {
  assert.equal(isFresh({
    so_number: "1",
    meetings: [{ session_date: "2026-09-25" }],
    existing_synthesis: { generated_at: "2026-09-20T00:00:00Z" },
  }), false);
});

t("synthesis with no dated inputs is fresh, not reprocessed forever", () => {
  // The loop bug: anything never treated as fresh gets redone every pass.
  assert.equal(isFresh({
    so_number: "1",
    existing_synthesis: { generated_at: "2026-09-20T00:00:00Z" },
  }), true);
});

t("unparseable timestamps do not crash or wrongly skip", () => {
  assert.equal(isFresh({
    so_number: "1",
    fishbowl: { synced_at: "not a date" },
    existing_synthesis: { generated_at: "also not a date" },
  }), false);
  assert.equal(newestInputTime({ so_number: "1", fishbowl: { synced_at: "nope" } }), null);
});

t("selectStale keeps only what needs work", () => {
  const stale = selectStale([
    { so_number: "A" },
    { so_number: "B", existing_synthesis: { generated_at: "2026-09-20T00:00:00Z" } },
    { so_number: "C", fishbowl: { synced_at: "2026-09-21T00:00:00Z" },
      existing_synthesis: { generated_at: "2026-09-20T00:00:00Z" } },
  ]);
  assert.deepEqual(stale.map((s) => s.so_number), ["A", "C"]);
});

console.log(`${passed} passed (incl. freshness)`);
