#!/usr/bin/env node
/**
 * Banned-words lint for base-case surfaces (onboarding redesign, "Words that
 * are banned from the base case"): the words below are power-user vocabulary
 * and must never RENDER on the surfaces a novice sees. They stay fine in
 * code, comments, identifiers, and on the advanced console pages.
 *
 * AST-based (TypeScript parser, no regex-over-source false positives): flags
 * banned words in (a) JSX text nodes and (b) string/template literals that
 * read like sentences (contain a space) — the two places rendered copy lives.
 * Exits 1 with file:line locations on any hit.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every surface a base-case user sees before opening the advanced door. */
const SURFACES = [
  'packages/console/src/pages/Home.tsx',
  'packages/console/src/pages/Agent.tsx',
  'packages/console/src/pages/AddAgent.tsx',
  'packages/console/src/pages/Login.tsx',
  'packages/console/src/pages/Start.tsx',
  'packages/console/src/pages/SignWallet.tsx',
  'packages/console/src/pages/Board.tsx',
  'packages/console/src/pages/Tasks.tsx',
  'packages/console/src/pages/TaskNew.tsx',
  'packages/console/src/pages/TaskReview.tsx',
  // Pills + error copy shared by the three task pages render to the same human.
  'packages/console/src/components/TaskBits.tsx',
  'packages/console/src/components/Layout.tsx',
  // The marketing homepage speaks to the same base-case human — same rule.
  // (The "Are you an agent?" section is agent-facing but must still pass:
  // machine copy that needs the technical words belongs on /docs/agents.)
  'packages/web/src/pages/Home.tsx',
];

const BANNED = /\b(grant|lease|delegation|identity|credential|owner)(s|ed|ing)?\b/i;

/** A string literal is "copy" (not a key/route/class) when it has a space. */
function looksLikeCopy(text) {
  return text.includes(' ');
}

function check(rel, text, sourceFile, pos, failuresOut) {
  const hit = BANNED.exec(text);
  if (!hit) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
  failuresOut.push(
    `${rel}:${line + 1} banned word "${hit[0]}" in rendered text: ${JSON.stringify(text.trim().slice(0, 80))}`,
  );
}

function lintFile(rel, failuresOut) {
  const source = readFileSync(resolve(ROOT, rel), 'utf8');
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  function visit(node) {
    if (ts.isJsxText(node)) {
      check(rel, node.text, sf, node.getStart(sf), failuresOut);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (looksLikeCopy(node.text)) check(rel, node.text, sf, node.getStart(sf), failuresOut);
    } else if (ts.isTemplateExpression(node)) {
      const chunks = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      for (const chunk of chunks) {
        if (looksLikeCopy(chunk)) check(rel, chunk, sf, node.getStart(sf), failuresOut);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

const failures = [];
for (const rel of SURFACES) {
  try {
    lintFile(rel, failures);
  } catch (err) {
    failures.push(`lint-ui-words: cannot lint ${rel}: ${err.message} (update SURFACES if it moved)`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  console.error(`\nlint-ui-words: ${failures.length} problem(s). These words must not render on base-case surfaces.`);
  process.exit(1);
}
console.log(`lint-ui-words: ${SURFACES.length} surfaces clean.`);
