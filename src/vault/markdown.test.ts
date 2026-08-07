import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  appendToSection,
  ensureSection,
  getSectionLines,
  parseNote,
  serializeNote,
} from "./markdown.js";

describe("frontmatter parsing", () => {
  test("reads keys and leaves the body untouched", () => {
    const note = parseNote(`---
ticker: SWKS
score: 81
---

## Thesis

Cheap on cash flow.
`);

    assert.equal(note.frontmatter.get("ticker"), "SWKS");
    assert.equal(note.frontmatter.get("score"), "81");
    assert.match(note.body, /Cheap on cash flow/);
    assert.equal(note.hadFrontmatter, true);
  });

  test("treats a note with no frontmatter as all body", () => {
    const note = parseNote("# Just notes\n\nSome text.\n");
    assert.equal(note.hadFrontmatter, false);
    assert.equal(note.frontmatter.size, 0);
    assert.match(note.body, /Just notes/);
  });

  test("unquotes quoted values, preserving leading zeros", () => {
    const note = parseNote(`---
cik: "0000004127"
---
body`);

    assert.equal(note.frontmatter.get("cik"), "0000004127");
  });

  test("ignores comments and blank lines", () => {
    const note = parseNote(`---
# a comment
ticker: AMD

score: 40
---
`);

    assert.equal(note.frontmatter.size, 2);
    assert.equal(note.frontmatter.get("ticker"), "AMD");
  });

  test("round-trips a CIK without losing leading zeros", () => {
    const fm = new Map([["cik", "0000004127"]]);
    const round = parseNote(serializeNote(fm, "body\n"));

    assert.equal(
      round.frontmatter.get("cik"),
      "0000004127",
      "an unquoted CIK would be read back as a number",
    );
  });

  test("quotes values containing a colon", () => {
    const out = serializeNote(new Map([["note", "beat: 16.2%"]]), "");
    assert.match(out, /note: "beat: 16\.2%"/);
  });
});

describe("section handling", () => {
  const NOTE = `## Thesis

My own analysis, which must survive.

## Event log

- 2026-08-01 — Something happened

## Open questions

- Why is capex rising?
`;

  test("appends a new entry above existing ones", () => {
    const out = appendToSection(NOTE, "Event log", ["- 2026-08-07 — Score 60 → 81"]);
    const lines = getSectionLines(out, "Event log").filter((l) => l.trim());

    assert.equal(lines[0], "- 2026-08-07 — Score 60 → 81");
    assert.equal(lines[1], "- 2026-08-01 — Something happened");
  });

  test("never duplicates an entry already present", () => {
    const out = appendToSection(NOTE, "Event log", ["- 2026-08-01 — Something happened"]);
    assert.equal(out, NOTE, "an unchanged run must not grow the log");
  });

  test("leaves the user's own sections exactly as they were", () => {
    const out = appendToSection(NOTE, "Event log", ["- 2026-08-07 — New"]);

    assert.match(out, /My own analysis, which must survive\./);
    assert.match(out, /Why is capex rising\?/);
    assert.deepEqual(getSectionLines(out, "Thesis").filter((l) => l.trim()), [
      "My own analysis, which must survive.",
    ]);
  });

  test("creates the section when missing", () => {
    const out = appendToSection("## Thesis\n\nText.\n", "Event log", ["- entry"]);

    assert.match(out, /## Event log/);
    assert.match(out, /- entry/);
    assert.match(out, /Text\./);
  });

  test("ignores headings inside fenced code blocks", () => {
    const withCode = `## Thesis

\`\`\`
## Event log
not a real heading
\`\`\`

## Event log

- real entry
`;
    const out = appendToSection(withCode, "Event log", ["- added"]);
    const lines = getSectionLines(out, "Event log").filter((l) => l.trim());

    assert.deepEqual(lines, ["- added", "- real entry"]);
    assert.match(out, /not a real heading/);
  });

  test("appending nothing is a no-op", () => {
    assert.equal(appendToSection(NOTE, "Event log", []), NOTE);
  });
});

describe("ensureSection", () => {
  test("adds a placeholder section when absent", () => {
    const out = ensureSection("## Event log\n\n- x\n", "Thesis", "_Not written yet._");
    assert.match(out, /## Thesis/);
    assert.match(out, /_Not written yet\._/);
  });

  test("does not overwrite an existing section", () => {
    const existing = "## Thesis\n\nMy words.\n";
    const out = ensureSection(existing, "Thesis", "_placeholder_");

    assert.equal(out, existing);
    assert.doesNotMatch(out, /placeholder/);
  });
});
