/**
 * Markdown notes with YAML frontmatter, edited in place without disturbing
 * anything the user wrote.
 *
 * A company note has three zones with different owners:
 *
 * - **Frontmatter** is machine-owned and rewritten on every run.
 * - **The event log** is append-only; entries already present are never
 *   duplicated and never rewritten.
 * - **Every other section is the user's** and is passed through untouched.
 *
 * That separation is the whole point of writing into a vault rather than
 * dumping a report: the screen accumulates state alongside your own analysis
 * without ever overwriting it. The functions here are deliberately
 * conservative — an unrecognised section is preserved verbatim rather than
 * normalised.
 */

export interface ParsedNote {
  /** Frontmatter keys in file order. Values are raw, unquoted where simple. */
  frontmatter: Map<string, string>;
  /** Everything after the frontmatter block, verbatim. */
  body: string;
  /** True when the source had a frontmatter block at all. */
  hadFrontmatter: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Values needing quotes: leading zeros, or anything YAML would reinterpret. */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (/^0\d/.test(value)) return true;
  if (/[:#\[\]{}",]/.test(value)) return true;
  if (/^\s|\s$/.test(value)) return true;
  return false;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseNote(text: string): ParsedNote {
  const match = FRONTMATTER.exec(text);

  if (!match) {
    return { frontmatter: new Map(), body: text, hadFrontmatter: false };
  }

  const frontmatter = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    frontmatter.set(line.slice(0, idx).trim(), unquote(line.slice(idx + 1)));
  }

  return {
    frontmatter,
    body: text.slice(match[0].length),
    hadFrontmatter: true,
  };
}

export function serializeNote(
  frontmatter: Map<string, string>,
  body: string,
): string {
  const lines: string[] = ["---"];
  for (const [key, value] of frontmatter) {
    lines.push(`${key}: ${needsQuoting(value) ? JSON.stringify(value) : value}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${body.replace(/^\n+/, "")}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Section {
  heading: string;
  start: number;
  end: number;
}

/** Locates `## Heading` blocks, ignoring headings inside fenced code. */
function findSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let fenced = false;
  let current: { heading: string; start: number } | undefined;

  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;

    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;

    if (current) sections.push({ ...current, end: i });
    current = { heading: m[1] ?? "", start: i };
  }

  if (current) sections.push({ ...current, end: lines.length });
  return sections;
}

export function getSectionLines(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const section = findSections(body).find(
    (s) => s.heading.toLowerCase() === heading.toLowerCase(),
  );
  if (!section) return [];
  return lines.slice(section.start + 1, section.end);
}

/**
 * Appends entries to a section, creating it if absent and skipping any line
 * already present.
 *
 * Deduplication is exact-match on the trimmed line. Screen runs are expected
 * to re-report unchanged facts, and an event log that grows a duplicate every
 * week is worse than no log.
 */
export function appendToSection(
  body: string,
  heading: string,
  entries: string[],
): string {
  if (entries.length === 0) return body;

  const lines = body.split(/\r?\n/);
  const section = findSections(body).find(
    (s) => s.heading.toLowerCase() === heading.toLowerCase(),
  );

  if (!section) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}## ${heading}\n\n${entries.join("\n")}\n`;
  }

  const existing = new Set(
    lines.slice(section.start + 1, section.end).map((l) => l.trim()),
  );
  const fresh = entries.filter((e) => !existing.has(e.trim()));
  if (fresh.length === 0) return body;

  // Insert directly under the heading so newest entries read first.
  const before = lines.slice(0, section.start + 1);
  const after = lines.slice(section.start + 1);
  while (after.length > 0 && after[0]?.trim() === "") after.shift();

  return [...before, "", ...fresh, ...(after.length ? [""] : []), ...after].join("\n");
}

/** Adds a section with the given content only when it does not already exist. */
export function ensureSection(
  body: string,
  heading: string,
  placeholder: string,
): string {
  const exists = findSections(body).some(
    (s) => s.heading.toLowerCase() === heading.toLowerCase(),
  );
  if (exists) return body;

  const trimmed = body.replace(/\s+$/, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}## ${heading}\n\n${placeholder}\n`;
}
