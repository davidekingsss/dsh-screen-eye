/**
 * Run chosen sections of this suite, skipping the rest.
 *
 * The suite is 160 cases, and one section of it — `live capture`, 24 cases —
 * takes minutes: every case there takes a real screenshot, records a real
 * burst, or builds the Swift engine. The other 136 cases are pure logic and
 * stubs and finish in about six seconds. A change to a tool's wording or to the
 * plugin's wiring therefore has a six-second answer and a minutes-long one, and
 * running the whole suite to reach the six-second one is how an answer becomes
 * a timeout — and how a killed run leaves its temporary captures behind.
 *
 * So this runs the preamble (imports and helpers) plus only the named sections,
 * in one process. Nothing is reimplemented: the cases are the suite's own text,
 * read at run time, so an edit is picked up the moment it is saved.
 *
 *   node test/fast.mjs --list
 *   node test/fast.mjs "announcing the capability"
 *   node test/fast.mjs "plugin wiring" "the settings card (browser half)"
 *
 * With no section named it lists them, with their case counts, rather than
 * running anything. Section names are the headings the suite prints.
 *
 * The full suite is still the thing that ships: this is for the loop you run
 * while editing, and `node test/selftest.mjs` is for deciding whether to commit.
 * Section names come from the suite's own output, so `--list` is the way to
 * find them rather than this comment.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suite = join(here, 'selftest.mjs');
const wanted = process.argv.slice(2);

const lines = readFileSync(suite, 'utf8').split('\n');

// A section heading is the suite announcing itself; everything up to the next
// heading belongs to that section.
const heading = /^process\.stdout\.write\('\\n(.+?)\\n'\);$/;
const headings = [];
for (let i = 0; i < lines.length; i += 1) {
  const match = heading.exec(lines[i]);
  if (match) headings.push({ name: match[1], start: i, end: lines.length });
}

// A structural check on the suite itself, so a suite that stops announcing its
// headings fails here with a sentence instead of by silently running nothing.
if (headings.length < 5) {
  process.stderr.write('test/fast.mjs: selftest.mjs no longer announces its sections\n');
  process.exit(2);
}
for (let i = 0; i < headings.length - 1; i += 1) headings[i].end = headings[i + 1].start;

// The suite's own trailing cleanup is not a section, so it lands in the last
// one. Detached here: it removes the directory `live capture` created, and
// running it without that section would delete a path nothing made.
const cleanup = 'await rm(liveDir, { recursive: true, force: true });';
const last = headings.at(-1);
const trailing = lines.slice(last.start, last.end).filter((line) => line.trim() !== cleanup);
lines.splice(last.start, last.end - last.start, ...trailing);
last.end = last.start + trailing.length;

const countOf = ({ start, end }) =>
  lines.slice(start, end).filter((line) => line.trimStart().startsWith('await test(')).length;

if (wanted.length === 0 || wanted[0] === '--list' || wanted[0] === '--orphans') {
  for (const section of headings) {
    process.stdout.write(`${String(countOf(section)).padStart(3)} cases  ${section.name}\n`);
  }
  if (wanted[0] !== '--orphans') process.exit(0);
}

// Some helpers are declared inside the section that first needs them rather
// than in the preamble, so a section run alone can be missing one. The graph is
// written out instead of parsed, because parsing it means deciding which
// declarations are helpers and which are locals, and a wrong answer there shows
// up as a ReferenceError in the middle of a run. `--orphans` checks this list
// against the suite.
const SECTION_HELPERS = {
  'PNG header': ['pngHeader'],
  'schema conformance': ['compiledOutput', 'screenshotShapes', 'permissionShapes'],
  'child process execution': ['nodeChild'],
  'live capture': ['liveDir', 'liveSettings', 'liveCaptureAvailable', 'inventoryOrSkip', 'live'],
  'plugin wiring': ['wiringCtx', 'onPlatform'],
  'the settings card (browser half)': ['fakeDom', 'loadClientHalf', 'tinyReact', 'findAll', 'byClass', 'stubScope'],
};
const helperOwner = new Map();
for (const [section, names] of Object.entries(SECTION_HELPERS)) {
  for (const helper of names) helperOwner.set(helper, section);
}

if (wanted[0] === '--orphans') {
  // Every helper the graph claims has to be declared somewhere the extraction
  // can reach, or the auto-inclusion is decoration.
  let bad = 0;
  for (const [helper, owner] of helperOwner) {
    const section = headings.find((h) => h.name === owner);
    const declared = lines.slice(section.start, section.end)
      .some((line) => new RegExp(`^(?:async )?function ${helper}\\b|^const ${helper} =`).test(line));
    if (!declared) {
      process.stdout.write(`MISSING  ${helper} is attributed to "${owner}" but not declared there\n`);
      bad += 1;
    }
  }
  process.stdout.write(bad === 0 ? 'every attributed helper is declared where the graph says\n' : `${bad} wrong attribution(s)\n`);
  process.exit(bad === 0 ? 0 : 1);
}

const unknown = wanted.filter((name) => !headings.some((section) => section.name === name));
if (unknown.length > 0) {
  process.stderr.write(`unknown section(s): ${unknown.join(', ')} — run with --list to see them\n`);
  process.exit(2);
}

/** Which sections each section's text needs helpers from. */
function helpersUsedBy(section) {
  // Prose is skipped, and it matters twice over: these sections discuss helpers
  // by name in comments, and a case's own label is prose too — one is called
  // "reports the live permission state", which would otherwise pull in the one
  // section this file exists to avoid. The label is dropped by matching the
  // suite's `await test('…'` opener, whose argument can hold no parentheses.
  const text = lines
    .slice(section.start, section.end)
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n')
    .replace(/await test\('[^()]*'/gu, 'await test(');
  const own = new Set(SECTION_HELPERS[section.name] ?? []);
  const needed = new Set();
  for (const [helper, owner] of helperOwner) {
    if (owner === section.name || own.has(helper)) continue;
    if (new RegExp(`\\b${helper}\\b`).test(text)) needed.add(owner);
  }
  return needed;
}

// Close the request over the graph: a chosen section brings the sections that
// declare the helpers it uses, transitively.
const selected = new Set(wanted);
const pulled = new Set();
for (let queue = [...selected]; queue.length > 0;) {
  const name = queue.pop();
  for (const owner of helpersUsedBy(headings.find((h) => h.name === name))) {
    if (selected.has(owner)) continue;
    selected.add(owner);
    pulled.add(owner);
    queue.push(owner);
  }
}

// The slow section owns helpers several fast ones use, so pulling it in would
// quietly turn a six-second run into a minutes-long one — the exact failure
// this file exists to prevent. Stopped here instead, where the answer is one
// word from the caller.
const slow = 'live capture';
if (pulled.has(slow)) {
  const asking = [...selected].filter((name) => name !== slow);
  process.stderr.write(
    `${asking.join(', ')} need${asking.length === 1 ? 's' : ''} helpers that only "${slow}" declares.\n`
    + `Naming "${slow}" means a real screenshot, a real burst and the Swift engine: minutes, not seconds.\n`
    + `Either name it, or run the sections that do not need it. "plugin wiring" declares `
    + 'onPlatform and wiringCtx, which is what most capability cases actually need.\n',
  );
  process.exit(2);
}
if (pulled.size > 0) {
  process.stdout.write(`also running ${[...pulled].join(', ')} — they declare helpers this run uses\n`);
}

const chosen = headings.filter((section) => selected.has(section.name));
const preamble = lines.slice(0, headings[0].start);
const body = [
  ...preamble,
  ...chosen.flatMap((section) => [
    `process.stdout.write('\\n${section.name}\\n');`,
    ...lines.slice(section.start + 1, section.end),
  ]),
];

// These three are defined by the live section, so a section that needs them
// cannot run without it. Caught here rather than as a ReferenceError halfway
// through a run that looked like it was working.
if (!wanted.includes('live capture')) {
  for (const name of ['liveDir', 'liveSettings', 'liveCaptureAvailable']) {
    const uses = body.filter((line) => line.includes(name) && !line.trimStart().startsWith('//'));
    if (uses.length > 0) {
      process.stderr.write(
        `the section(s) ${wanted.join(', ')} use ${name}, which only "live capture" defines.\n`
        + 'add "live capture" to the run, or expect it to fail.\n',
      );
      process.exit(2);
    }
  }
}

// The extraction is written beside the suite so its relative imports of
// ../index.mjs and ../lib/*.mjs resolve, and removed in a `finally` so a failed
// run does not leave it in the tree.
const target = resolve(here, '.fast-selftest.mjs');
writeFileSync(target, `// generated by test/fast.mjs — removed when the run ends\n${body.join('\n')}`);
process.stdout.write(`running ${chosen.length} of ${headings.length} sections, ${chosen.reduce((n, s) => n + countOf(s), 0)} cases\n\n`);

try {
  await import(pathToFileURL(target).href);
} finally {
  unlinkSync(target);
}
