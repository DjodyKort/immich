#!/usr/bin/env node
// [FORK] Detect API operations that can return asset-bearing data, and fail when a new one appears
// that nobody has classified.
//
// Why this exists. This fork's visibility model is an invariant over a codebase upstream keeps
// reshaping: a POLICY table of named surfaces, a persisted SURFACE_BIT per surface, and a parallel
// mask on mobile. The failure mode that scares us is not a merge conflict and not a compile error.
// It is upstream adding an endpoint that returns assets. Nothing conflicts, nothing fails to build,
// no test breaks, because server/test/medium/specs/visibility-matrix.spec.ts only knows the endpoints
// someone told it about - and a locked or per-asset-hidden photo can be served from the new one.
//
// So the check is mechanical: every operation whose response can carry asset-shaped data must be
// listed in _fork/asset-surfaces.json with a classification. A new one fails CI until a human
// decides which Surface it is, or records why it is not a surface.
//
// Usage:
//   node _fork/asset-surfaces.mjs check   # CI: exit 1 on unclassified operations
//   node _fork/asset-surfaces.mjs list    # print what it detects, for seeding or auditing
//
// Deliberately over-inclusive. Classifying one extra endpoint once is cheap; missing one is a leak.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, '..', 'open-api', 'immich-openapi-specs.json');
const listPath = join(here, 'asset-surfaces.json');

// Schemas that carry assets, or carry something that carries assets. Anchors, not an allowlist: the
// transitive walk below finds anything that reaches one of these, so a new DTO that embeds
// AssetResponseDto is caught without being named here.
const ANCHORS = [
  'AssetResponseDto',
  'AlbumResponseDto',
  'MemoryResponseDto',
  'PersonResponseDto',
  'DuplicateResponseDto',
  'AssetStackResponseDto',
  'TimeBucketAssetResponseDto',
  // The sync family. No endpoint returns these under a typed 2xx today, because the sync stream is
  // untyped NDJSON (see the `manual` note below), but they are anchored so that any future endpoint
  // which does return them typed is caught immediately.
  'SyncAssetV1',
  'SyncAssetV2',
  'SyncAlbumV1',
  'SyncAlbumToAssetV1',
];

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const schemas = spec.components?.schemas ?? {};

// If an anchor stops existing, upstream renamed it and this detector has gone quietly blind. That is
// worse than it failing, so treat a missing anchor as a hard error rather than a smaller result set.
const missingAnchors = ANCHORS.filter((name) => !(name in schemas));

const refName = (ref) => (typeof ref === 'string' && ref.startsWith('#/components/schemas/') ? ref.split('/').pop() : null);

/** Every schema name reachable from a node, following $ref transitively. */
const reachable = (node, seen = new Set()) => {
  if (!node || typeof node !== 'object') {
    return seen;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref') {
      const name = refName(value);
      if (name && !seen.has(name)) {
        seen.add(name);
        reachable(schemas[name], seen);
      }
      continue;
    }
    if (value && typeof value === 'object') {
      reachable(value, seen);
    }
  }
  return seen;
};

const detected = [];
for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (!op || typeof op !== 'object' || !op.operationId) {
      continue;
    }
    // Responses only. A request body mentioning an asset id is not a read surface.
    const ok = Object.entries(op.responses ?? {}).filter(([code]) => code.startsWith('2'));
    if (ok.length === 0) {
      continue;
    }
    const names = reachable(Object.fromEntries(ok));
    const hits = ANCHORS.filter((a) => names.has(a));
    if (hits.length > 0) {
      detected.push({ operationId: op.operationId, route: `${method.toUpperCase()} ${path}`, via: hits });
    }
  }
}
detected.sort((a, b) => a.operationId.localeCompare(b.operationId));

const mode = process.argv[2] ?? 'check';

if (mode === 'list') {
  if (missingAnchors.length > 0) {
    console.log(`WARNING missing anchors: ${missingAnchors.join(', ')}`);
  }
  console.log(`${detected.length} asset-bearing operation(s):`);
  for (const d of detected) {
    console.log(`  ${d.operationId}\t${d.route}\tvia ${d.via.join(',')}`);
  }
  process.exit(0);
}

const gha = (level, message) => console.log(`::${level} ::${message}`);
let failed = false;

if (missingAnchors.length > 0) {
  gha(
    'error',
    `asset-surfaces.mjs anchor schema(s) no longer exist in the spec: ${missingAnchors.join(', ')}. ` +
      `Upstream probably renamed them, which makes this detector blind. Update ANCHORS in _fork/asset-surfaces.mjs.`,
  );
  failed = true;
}

const known = JSON.parse(readFileSync(listPath, 'utf8'));
const classified = new Map(Object.entries(known.operations ?? {}));

// Channels the spec cannot express, so no schema walk will ever see them. Today that is the sync
// stream: its 2xx response carries no schema at all because it is NDJSON, while the body is what
// mobile builds its entire local visibility mask from. 59 operations have untyped 2xx responses, far
// too many to flag wholesale, so these are named by hand. What is still mechanical is their
// existence: if upstream renames or removes one, the classification is silently about nothing.
const allOperationIds = new Set(
  Object.values(spec.paths ?? {})
    .flatMap((methods) => Object.values(methods))
    .filter((op) => op && typeof op === 'object' && op.operationId)
    .map((op) => op.operationId),
);
for (const id of Object.keys(known.manual ?? {})) {
  if (!allOperationIds.has(id)) {
    gha(
      'error',
      `${id} is listed under "manual" in _fork/asset-surfaces.json but no longer exists in the spec. ` +
        `It was there because the schema walk cannot see it, so nothing else will notice it is gone.`,
    );
    failed = true;
  }
}

const unclassified = detected.filter((d) => !classified.has(d.operationId));
for (const d of unclassified) {
  gha(
    'error',
    `${d.operationId} (${d.route}) can return asset-bearing data and is not classified in ` +
      `_fork/asset-surfaces.json. Decide which Surface it belongs to in ` +
      `server/src/utils/visibility-policy.ts, cover it in visibility-matrix.spec.ts, then add it there. ` +
      `If it is not a read surface, record that with a reason.`,
  );
  failed = true;
}

const detectedIds = new Set(detected.map((d) => d.operationId));
const stale = [...classified.keys()].filter((id) => !detectedIds.has(id));
for (const id of stale) {
  // Informational: upstream removing an endpoint is not our problem to fix, but a stale entry hides
  // the fact that the classification no longer applies to anything.
  gha('notice', `${id} is classified in _fork/asset-surfaces.json but no longer exists in the spec. Consider removing it.`);
}

const grandfathered = detected.filter((d) => classified.get(d.operationId)?.surface === null);
if (grandfathered.length > 0) {
  gha(
    'notice',
    `${grandfathered.length} operation(s) predate this check and are still unclassified: ` +
      `${grandfathered.map((d) => d.operationId).join(', ')}. Not a failure, but each is an unreviewed surface.`,
  );
}

console.log(
  `${detected.length} asset-bearing operation(s); ${detected.length - unclassified.length} classified, ` +
    `${unclassified.length} new, ${grandfathered.length} grandfathered.`,
);
process.exit(failed ? 1 : 0);
