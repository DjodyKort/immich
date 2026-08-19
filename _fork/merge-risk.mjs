#!/usr/bin/env node
// [FORK] Deterministic triage of an incoming upstream merge, by risk to this fork's invariants.
//
// This is the floor the AI triage stands on, and it is deliberately not AI. Two reasons:
//
// 1. It must work when every model route is unavailable. A home server can be down, a subscription can
//    be rate limited, an API key can be revoked. When that happens you should still get a report
//    telling you which parts of the merge deserve eyes, rather than nothing.
// 2. It is what keeps the model affordable. Upstream runs 44 to 76 commits a week; feeding a raw
//    150-commit diff to a model is both expensive and unreliable. The model reads this instead, and
//    only deep-reads what is flagged.
//
// Usage:
//   node _fork/merge-risk.mjs [--base <ref>] [--head <ref>] [--json]
//
// Default range is merge-base(HEAD, upstream/main)..upstream/main, i.e. what is about to arrive.
// Always exits 0: this reports, it does not gate. The gates are the test suites and the other
// _fork checks.

import { execFileSync } from 'node:child_process';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const asJson = process.argv.includes('--json');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const head = arg('head', 'upstream/main');
let base = arg('base', null);
if (!base) {
  try {
    base = git('merge-base', 'HEAD', head);
  } catch {
    console.error(`Could not find a merge-base with ${head}. Pass --base explicitly, or fetch upstream.`);
    process.exit(0);
  }
}

/**
 * Risk rules, most specific first. `why` is written for whoever reads the report, so it says what to
 * check rather than merely naming the file.
 *
 * These paths encode where this fork's invariants live. Adding a rule is cheap; the cost of a missing
 * one is a change nobody looked at, so err toward listing.
 */
const RULES = [
  {
    level: 'high',
    match: /^server\/src\/utils\/visibility-policy\.ts$/,
    why: 'The entire visibility policy. Any change to POLICY, SURFACE_BIT, or a helper moves every surface at once. Run the visibility matrix before and after and diff which cells moved.',
  },
  {
    level: 'high',
    match: /^server\/src\/schema\/migrations\//,
    why: 'A migration. Check whether it touches asset.visibility, asset.hiddenFrom, or asset_id_timeline_notDeleted_idx: dropping or re-predicating that partial index degrades every timeline query without failing anything.',
  },
  {
    level: 'high',
    match: /^server\/src\/schema\/tables\/asset\.table\.ts$/,
    why: 'The asset table. hiddenFrom and visibility live here; a type or nullability change reinterprets stored masks.',
  },
  {
    level: 'high',
    match: /^mobile\/lib\/infrastructure\/utils\/visibility_policy\.dart$/,
    why: "Mobile's own mask. Its bit values are local and unrelated to the server's, because sync carries surface names rather than integers. A change here must not start depending on the server's numbering.",
  },
  {
    level: 'high',
    match: /^server\/src\/(services|repositories)\/sync\./,
    why: 'Sync. This is the channel mobile builds its local visibility mask from, and it is invisible to the asset-surface detector because the stream response has no schema.',
  },
  {
    level: 'medium',
    match: /^open-api\/immich-openapi-specs\.json$/,
    why: 'The API surface changed. _fork/asset-surfaces.mjs fails on a new asset-returning operation, so check that gate first; this entry is here for removals and response-shape changes, which it only warns about.',
  },
  {
    level: 'medium',
    match: /^server\/src\/repositories\/.*\.repository\.ts$/,
    why: 'A repository. Check whether a query that returns assets gained or lost a surface predicate, and whether an existing predicate is still on the query it was written for.',
  },
  {
    level: 'medium',
    match: /^mobile\/lib\/infrastructure\/repositories\//,
    why: "Mobile repositories carry our local filters. Upstream restructuring these has already moved a filter's call site once, which no conflict revealed.",
  },
  {
    level: 'medium',
    match: /^server\/src\/(controllers|dtos)\//,
    why: 'A controller or DTO. New read endpoints are new surfaces; the asset-surface gate covers the asset-bearing ones.',
  },
  {
    level: 'medium',
    match: /^packages\/plugin-(core|sdk)\//,
    why: 'Plugin surface. A new WorkflowTrigger or method changes what workflows can react to, and the trigger to type map in src/utils/workflow.ts must agree.',
  },
  {
    level: 'low',
    match: /^server\/src\/services\//,
    why: 'A service. Usually benign, but this is where a read path can quietly start returning assets through a helper that has no surface.',
  },
];

// `git diff a..b` is symmetric: it reports our own work as changed too, because upstream does not have
// it. That turns a report about what is arriving into a report that also lists everything this fork has
// ever written, which is worse than useless because it looks authoritative. Only an ancestor base gives
// a purely incoming diff, so anything else is called out rather than quietly reported.
let baseIsAncestor = true;
try {
  execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' });
} catch {
  baseIsAncestor = false;
}

const files = git('diff', '--name-only', `${base}..${head}`).split('\n').filter(Boolean);
const commits = Number(git('rev-list', '--count', `${base}..${head}`));

const findings = [];
for (const file of files) {
  const rule = RULES.find(({ match }) => match.test(file));
  if (rule) {
    findings.push({ file, level: rule.level, why: rule.why });
  }
}

const byLevel = (level) => findings.filter((f) => f.level === level);
const groups = ['high', 'medium', 'low'].map((level) => ({ level, items: byLevel(level) }));
const unmatched = files.length - findings.length;

if (asJson) {
  console.log(
    JSON.stringify(
      { base, head, commits, fileCount: files.length, baseIsAncestor, findings, unmatchedCount: unmatched },
      null,
      2,
    ),
  );
  process.exit(0);
}

const lines = [];
lines.push(`## Merge risk report`);
lines.push('');
lines.push(`\`${base.slice(0, 12)}..${head}\` - **${commits}** commit(s), **${files.length}** file(s) changed.`);
lines.push('');

if (!baseIsAncestor) {
  lines.push(
    "> **This range is not purely incoming.** The base is not an ancestor of the head, so `git diff` also" +
      " reports this fork's own work as changed, which makes the report look authoritative while listing" +
      ' files nobody is about to merge. Use the default range, `merge-base(HEAD, upstream/main)..upstream/main`.',
  );
  lines.push('');
}

if (findings.length === 0) {
  lines.push('No file in this range touches a known invariant. That is not a guarantee: it means the');
  lines.push('rules in `_fork/merge-risk.mjs` matched nothing, and a genuinely new kind of change would');
  lines.push('not match either. The gate suites remain the thing that decides.');
} else {
  for (const { level, items } of groups) {
    if (items.length === 0) {
      continue;
    }
    lines.push(`### ${level} (${items.length})`);
    lines.push('');
    // Grouped by reason rather than by file: 40 migrations share one instruction, and repeating it 40
    // times is what makes a report get skimmed instead of read.
    const byWhy = new Map();
    for (const item of items) {
      byWhy.set(item.why, [...(byWhy.get(item.why) ?? []), item.file]);
    }
    for (const [why, group] of byWhy) {
      lines.push(`- ${why}`);
      for (const file of group.slice(0, 12)) {
        lines.push(`  - \`${file}\``);
      }
      if (group.length > 12) {
        lines.push(`  - ...and ${group.length - 12} more`);
      }
    }
    lines.push('');
  }
  lines.push(`${unmatched} changed file(s) matched no rule.`);
}

console.log(lines.join('\n'));
