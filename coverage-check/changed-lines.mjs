#!/usr/bin/env node
// New-code coverage gate for coverage-check/action.yml.
//
// The gate used to hold every file a PR touched to the threshold on its WHOLE
// statement coverage. A PR that only reformatted files (PR #230 in
// ts-lib-ui-kit: Prettier over ~370 files) therefore failed on legacy files it
// never meaningfully changed — one file whose only change was a deleted blank
// line at EOF was reported at 0%. This script instead measures the statements
// that sit on lines the PR ADDED, using the `patch` of each entry from
// GET /repos/{owner}/{repo}/pulls/{n}/files.
//
// Rules, per candidate file (the action has already applied the caller's
// include/exclude patterns with grep, so their regex dialect is unchanged):
//   - no added lines (deletion-only, pure rename, mode change)  -> skipped
//   - a change block whose removed and added text differ only in formatting
//     (see normalizeForFormatting: a Prettier reflow)            -> not counted
//   - added lines that hold no statement (imports, types, braces,
//     comments)                                                   -> skipped
//   - otherwise: covered / changed statements, floored, must reach threshold
//   - `patch` missing although lines were added (GitHub omits it for large
//     diffs), or the patch cannot be lined up with the checked-out file
//                                                   -> whole-file coverage, with a warning
//
// Dependency-free on purpose: it runs on the caller's runner with whatever
// Node is on PATH, before or without any install.
//
// Usage: node changed-lines.mjs
//   env COVERAGE_FINAL   path to istanbul coverage-final.json
//       PR_FILES_JSON    path to the concatenated pulls/files response (array)
//       CANDIDATES_FILE  path to newline-separated filenames to check
//       THRESHOLD        integer percent
//       NEW_CODE_MODE    "changed-lines" (default) | "whole-file"
//       GITHUB_WORKSPACE repo root the coverage keys and filenames resolve from
// Exit: 0 pass, 1 below threshold, 2 bad input / ambiguous data.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Patch parsing

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff (as GitHub returns it, no file headers) into hunks. */
export function parsePatch(patch) {
  const hunks = [];
  let current = null;
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = { newStart: Number(header[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const op = raw[0];
    // "\ No newline at end of file" and any trailing empty string from the
    // final split are not diff lines.
    if (op === "+" || op === "-" || op === " ") {
      current.lines.push({ op, text: raw.slice(1) });
    }
  }
  return hunks;
}

// What a formatter (Prettier) changes without changing behaviour: whitespace
// and line breaks, trailing commas, semicolons, quote style, `{" "}` JSX
// spacers, and the grouping parentheses it adds or drops for readability
// (around multi-line JSX, arrow bodies, ternary branches, mixed `??`/`||`,
// single arrow parameters). Anything else is a real change.
//
// Grouping parens are dropped wholesale rather than matched one by one: a
// formatter adds them asymmetrically (`return (\n(a + 1) * b\n)` becomes
// `return (a + 1) * b`), so any pairing rule mispairs. Empty `()` is kept,
// because `handler` vs `handler()` is a real change. The cost is that a pure
// precedence edit inside an otherwise-reformatted block — `(a + b) * c` to
// `a + b * c` — reads as formatting. That trade is deliberate: a false match
// waives one statement's coverage requirement and never changes behaviour,
// while a miss fails a format-only PR.
export function normalizeForFormatting(lines) {
  return lines
    .join("\n")
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/;/g, "")
    .replace(/\{""\}/g, "")
    .replace(/,(?=[)\]}>]|$)/g, "")
    .replace(/\(\)/g, "\u0000")
    .replace(/[()]/g, "");
}

/**
 * Line numbers (in the new file) of added lines that carry a real change.
 * Returns { lines: Set<number>, formattingOnly: number, anchored: boolean }.
 * `fileLines`, when given, is the checked-out file the coverage was measured
 * on; each hunk is re-anchored against it (see anchorHunk).
 */
export function addedLines(patch, fileLines = null) {
  const lines = new Set();
  let formattingOnly = 0;
  for (const hunk of parsePatch(patch)) {
    const offset = fileLines ? anchorHunk(hunk, fileLines) : 0;
    if (offset === null) return { lines: new Set(), formattingOnly: 0, anchored: false };

    const oldSide = hunk.lines.filter((l) => l.op !== "+").map((l) => l.text);
    const newSide = hunk.lines.filter((l) => l.op !== "-").map((l) => l.text);
    const hunkIsFormatting = normalizeForFormatting(oldSide) === normalizeForFormatting(newSide);

    let newLine = hunk.newStart + offset;
    let block = { removed: [], added: [] };
    const flush = () => {
      if (block.added.length > 0) {
        const formatting =
          hunkIsFormatting ||
          normalizeForFormatting(block.removed) === normalizeForFormatting(block.added.map((a) => a.text));
        for (const a of block.added) {
          if (formatting) formattingOnly += 1;
          else lines.add(a.line);
        }
      }
      block = { removed: [], added: [] };
    };
    for (const l of hunk.lines) {
      if (l.op === " ") {
        flush();
        newLine += 1;
      } else if (l.op === "-") {
        block.removed.push(l.text);
      } else {
        block.added.push({ line: newLine, text: l.text });
        newLine += 1;
      }
    }
    flush();
  }
  return { lines, formattingOnly, anchored: true };
}

const stripCR = (s) => (s.endsWith("\r") ? s.slice(0, -1) : s);

/**
 * The patch's line numbers are relative to the PR head, but CI usually
 * instruments the merge commit (refs/pull/N/merge). If main changed the same
 * file after the branch point, the head-side numbers drift. Find where the
 * hunk's new-side text actually sits in the checked-out file, preferring the
 * smallest shift. Returns the offset, or null when the text is not there.
 */
export function anchorHunk(hunk, fileLines) {
  const newSide = hunk.lines.filter((l) => l.op !== "-").map((l) => stripCR(l.text));
  if (newSide.length === 0) return 0;
  const start = hunk.newStart - 1; // 0-based
  const matchesAt = (s) => {
    if (s < 0 || s + newSide.length > fileLines.length) return false;
    for (let i = 0; i < newSide.length; i += 1) {
      if (stripCR(fileLines[s + i]) !== newSide[i]) return false;
    }
    return true;
  };
  for (let d = 0; d <= fileLines.length; d += 1) {
    if (matchesAt(start + d)) return d;
    if (d > 0 && matchesAt(start - d)) return -d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coverage lookup

const toPosix = (p) => p.split(path.sep).join("/");

/**
 * Finds the coverage-final.json entry for a repo-relative filename. Exact
 * match on the workspace-relative key first; a unique suffix match as a
 * fallback (coverage generated from a subdirectory). The old jq lookup used a
 * bare `endswith`, which could select a different file sharing the suffix.
 * Returns { entry } | { ambiguous: string[] } | null.
 */
export function findCoverageEntry(coverage, filename, workspace) {
  const keys = Object.keys(coverage);
  const relative = (key) =>
    toPosix(path.isAbsolute(key) ? path.relative(workspace, key) : key).replace(/^\.\//, "");
  const exact = keys.filter((k) => relative(k) === filename);
  if (exact.length === 1) return { entry: coverage[exact[0]] };
  if (exact.length > 1) return { ambiguous: exact };
  const suffix = keys.filter((k) => toPosix(k).endsWith(`/${filename}`));
  if (suffix.length === 1) return { entry: coverage[suffix[0]] };
  if (suffix.length > 1) return { ambiguous: suffix };
  return null;
}

/**
 * Statement coverage of an istanbul file entry. With `lineSet`, only
 * statements whose [start.line, end.line] range includes at least one of those
 * lines count. Returns { total, covered, uncoveredLines }.
 */
export function statementCoverage(entry, lineSet = null) {
  let total = 0;
  let covered = 0;
  const uncovered = new Set();
  for (const [id, loc] of Object.entries(entry.statementMap ?? {})) {
    const startLine = loc.start.line;
    const endLine = loc.end?.line ?? startLine;
    let hit = [];
    if (lineSet) {
      for (const line of lineSet) if (line >= startLine && line <= endLine) hit.push(line);
      if (hit.length === 0) continue;
    } else {
      hit = [startLine];
    }
    total += 1;
    if ((entry.s?.[id] ?? 0) > 0) covered += 1;
    else for (const line of hit) uncovered.add(line);
  }
  return { total, covered, uncoveredLines: [...uncovered].sort((a, b) => a - b) };
}

/** [3,4,5,9] -> "3-5, 9" */
export function formatRanges(lines) {
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j += 1;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

// ---------------------------------------------------------------------------
// Evaluation

const CHECKABLE = new Set(["added", "modified", "renamed", "copied", "changed"]);

/**
 * Pure core: decides every candidate file. `readFile(filename)` returns the
 * checked-out file's lines or null. Returns { results, errors, warnings }.
 * Each result: { file, status: "pass"|"fail"|"skip", reason, total, covered,
 * pct, uncoveredLines, measured: "changed-lines"|"whole-file" }.
 */
export function evaluate({ coverage, prFiles, candidates, threshold, mode = "changed-lines", workspace, readFile }) {
  const byName = new Map(prFiles.map((f) => [f.filename, f]));
  const results = [];
  const errors = [];
  const warnings = [];

  for (const file of candidates) {
    const pr = byName.get(file);
    if (!pr || !CHECKABLE.has(pr.status)) continue;

    const found = findCoverageEntry(coverage, file, workspace);
    if (found === null) {
      // Excluded from instrumentation (e.g. CLI entry points tested via
      // subprocess spawn) — same "skip" the whole-file check always did.
      results.push({ file, status: "skip", reason: "not in coverage scope" });
      continue;
    }
    if (found.ambiguous) {
      errors.push(`${file} matches several coverage entries (${found.ambiguous.join(", ")}); cannot tell which one was changed.`);
      results.push({ file, status: "fail", reason: "ambiguous coverage entry" });
      continue;
    }

    let measured = mode;
    let lineSet = null;
    let note = "";
    if (mode === "changed-lines") {
      if ((pr.additions ?? 0) === 0) {
        results.push({ file, status: "skip", reason: "no added lines" });
        continue;
      }
      if (typeof pr.patch !== "string" || pr.patch === "") {
        if ((pr.changes ?? 0) === 0) {
          results.push({ file, status: "skip", reason: "no content change" });
          continue;
        }
        warnings.push(`GitHub returned no patch for ${file} (diff too large); enforcing whole-file coverage for it.`);
        measured = "whole-file";
      } else {
        const changed = addedLines(pr.patch, readFile(file));
        if (!changed.anchored) {
          warnings.push(`The patch for ${file} does not line up with the checked-out file; enforcing whole-file coverage for it.`);
          measured = "whole-file";
        } else {
          lineSet = changed.lines;
          if (changed.formattingOnly > 0) note = `${changed.formattingOnly} reformatted line(s) ignored`;
          if (lineSet.size === 0) {
            results.push({ file, status: "skip", reason: "formatting-only change", note });
            continue;
          }
        }
      }
    }

    const cov = statementCoverage(found.entry, measured === "whole-file" ? null : lineSet);
    if (cov.total === 0) {
      results.push({
        file,
        status: "skip",
        reason: measured === "whole-file" ? "no statements" : "no executable changed lines",
        note,
      });
      continue;
    }
    const pct = Math.floor((cov.covered / cov.total) * 100);
    results.push({
      file,
      status: pct < threshold ? "fail" : "pass",
      measured,
      total: cov.total,
      covered: cov.covered,
      pct,
      uncoveredLines: cov.uncoveredLines,
      note,
    });
  }
  return { results, errors, warnings };
}

// ---------------------------------------------------------------------------
// CLI

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`::error::Could not read ${label} (${file}): ${err.message}`);
    process.exit(2);
  }
}

function main() {
  const env = process.env;
  const workspace = path.resolve(env.GITHUB_WORKSPACE || process.cwd());
  const threshold = Number.parseInt(env.THRESHOLD ?? "", 10);
  const mode = env.NEW_CODE_MODE || "changed-lines";
  if (!Number.isInteger(threshold)) {
    console.log(`::error::THRESHOLD must be an integer, got "${env.THRESHOLD}"`);
    process.exit(2);
  }
  if (mode !== "changed-lines" && mode !== "whole-file") {
    console.log(`::error::new-code-mode must be "changed-lines" or "whole-file", got "${mode}"`);
    process.exit(2);
  }
  const coverage = readJson(env.COVERAGE_FINAL, "coverage-final.json");
  const prFiles = readJson(env.PR_FILES_JSON, "PR file list");
  if (!Array.isArray(prFiles)) {
    console.log("::error::PR file list is not a JSON array.");
    process.exit(2);
  }
  const candidates = readFileSync(env.CANDIDATES_FILE, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const readFile = (file) => {
    const full = path.join(workspace, file);
    return existsSync(full) ? readFileSync(full, "utf8").split("\n") : null;
  };

  const { results, errors, warnings } = evaluate({ coverage, prFiles, candidates, threshold, mode, workspace, readFile });

  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.log(`::error::${e}`);

  const unit = (r) => (r.measured === "whole-file" ? "statements in file" : "changed statements");
  console.log(`New-code coverage (${mode}, required: ${threshold}%):`);
  for (const r of results) {
    if (r.status === "skip") {
      console.log(`  skip  ${r.file} — ${r.reason}${r.note ? ` (${r.note})` : ""}`);
    } else if (r.total !== undefined) {
      console.log(`  ${r.status}  ${r.file}: ${r.covered}/${r.total} ${unit(r)} covered (${r.pct}%)${r.note ? ` — ${r.note}` : ""}`);
    }
  }

  const failed = results.filter((r) => r.status === "fail" && r.total !== undefined);
  if (failed.length > 0) {
    console.log("");
    console.log(`New/changed code coverage below threshold (required: ${threshold}%). Add tests for these lines:`);
    for (const r of failed) {
      const where = r.uncoveredLines.length > 0 ? `; uncovered lines ${formatRanges(r.uncoveredLines)}` : "";
      console.log(`  -> ${r.file}: ${r.covered}/${r.total} ${unit(r)} covered (${r.pct}%)${where}`);
      const first = r.uncoveredLines[0];
      console.log(
        `::error file=${r.file}${first ? `,line=${first}` : ""}::${r.covered}/${r.total} ${unit(r)} covered (${r.pct}%, required ${threshold}%)`,
      );
    }
  }

  if (env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .filter((r) => r.total !== undefined)
      .map(
        (r) =>
          `| ${r.status} | \`${r.file}\` | ${r.covered}/${r.total} | ${r.pct}% | ${r.measured} | ${formatRanges(r.uncoveredLines ?? [])} |`,
      );
    if (rows.length > 0) {
      try {
        appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          [
            `### New-code coverage (required: ${threshold}%)`,
            "",
            "| | File | Covered/changed statements | % | Measured | Uncovered lines |",
            "|---|---|---|---|---|---|",
            ...rows,
            "",
          ].join("\n"),
        );
      } catch {
        // The summary is a convenience; never let it decide the gate.
      }
    }
  }

  if (errors.length > 0) process.exit(2);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
