import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFanoutPlan, normalizePattern, patternsOverlap } from './plan-fanout.mjs';
const SHA = 'a'.repeat(40);
const resources = { writer: 1, postgres: 0, browser: 0, ios: 0, graph: 1, cas: 1 };
function cap(id, roots, patch = {}) { return { id, label: id, priority: { score: .7, inputs: { correctness_and_risk_reduction: .8, verification_readiness: .9 } }, dependencies: [], owner: `owner-${id}`, worktree: `/tmp/${id}`, branch: `codex/${id}`, ownership: { frontend_roots: roots.filter((root) => root.startsWith('web/')), backend_roots: roots.filter((root) => root.startsWith('backend/')), api_schema_roots: [], migration_owner: 'not_applicable', integration_owner: 'console-consolidation' }, signature_story: { id: `STORY-${id}`, outcome: id }, evidence_path: `docs/evidence/${id}`, tests: { leaf_commands: ['git diff --check'], buck2_targets: roots.some((root) => root.startsWith('backend/')) ? ['//backend/example:test'] : [] }, resource_requirements: resources, state: { backend: roots.some((root) => root.startsWith('backend/')) ? 'writer_assigned_in_progress' : 'not_applicable', frontend: roots.some((root) => root.startsWith('web/')) ? 'writer_assigned_in_progress' : 'not_applicable', independent_review: 'missing', production_exposure: 'dark' }, ...patch }; }
function reg(capabilities, patch = {}) { return { schema_version: 'console-capability-registry-v1', source_revision: `git@${SHA}`, resource_budgets: { writer: 3, postgres: 1, browser: 1, ios: 1, graph: 3, cas: 3 }, shared_collision_roots: { owner: 'console-consolidation', generated_face_registry: 'tools/buck/generated_face_registry.json', paths: ['backend/openapi/openapi.yaml', 'backend/crates/platform/db/migrations/**', 'web/src/console/screens/registry.ts'] }, capabilities, ...patch }; }
const faces = { schema_version: 2, faces: [{ id: 'buck', output_patterns: ['clients/ts/src/schema.d.ts'] }] };
function plan(capabilities, options = {}) { return buildFanoutPlan(reg(capabilities), { anchorSha: SHA, maxWriters: 3, qualityBias: .6, generatedFaces: faces, ...options }); }

test('only literal paths plus terminal subtree suffix are canonical ownership syntax', () => {
  assert.equal(normalizePattern('backend/crates/a/**'), 'backend/crates/a/**');
  for (const bad of ['foo*/**', 'foobar*', '.', '/.', '..', 'a/../b', './a', 'a/**/b']) assert.throws(() => normalizePattern(bad));
  assert.equal(patternsOverlap('backend/crates/a/**', 'backend/crates/a/x'), true);
  assert.equal(patternsOverlap('backend/crates/a/**', 'backend/crates/ab/**'), false);
});

test('unsupported authority intersections fail closed', () => {
  assert.throws(() => plan([cap('A', ['backend/crates/a/**'])], { generatedFaces: { schema_version: 2, faces: [{ output_patterns: ['foo*'] }] } }));
  assert.throws(() => plan([cap('A', ['backend/crates/a/**'])], { generatedFaces: null }));
});

test('migration roots are excluded from leaves and serialised', () => {
  const value = plan([cap('A', ['backend/crates/a/**', 'backend/crates/platform/db/migrations/**'])]);
  assert.deepEqual(value.selected[0].private_roots, ['backend/crates/a/**', 'docs/evidence/A/**']);
  assert.deepEqual(value.selected[0].excluded_shared_roots, ['backend/crates/platform/db/migrations/**']);
});

test('per-lane resource declarations are mandatory and budgets produce explicit holds', () => {
  const missing = cap('MISSING', ['backend/crates/missing/**'], { resource_requirements: undefined });
  assert.match(plan([missing]).held[0].reasons.join(','), /invalid_lane_resource_requirements/);
  const first = cap('A', ['backend/crates/a/**'], { resource_requirements: { ...resources, postgres: 1 } });
  const second = cap('B', ['backend/crates/b/**'], { resource_requirements: { ...resources, postgres: 1 } });
  const value = plan([first, second]);
  assert.equal(value.selected.length, 1);
  assert.deepEqual(value.collision_blocked[0].resources, ['postgres']);
});

test('same writer, worktree, or branch cannot be co-selected', () => {
  const a = cap('A', ['backend/crates/a/**']); const b = cap('B', ['backend/crates/b/**'], { owner: a.owner });
  const value = plan([a, b]);
  assert.equal(value.selected.length, 0);
  assert.equal(value.held.filter((entry) => entry.reasons.includes('duplicate_owner_within_epoch')).length, 2);
});

test('completed source cannot bypass invalid roots or exact review receipts', () => {
  const complete = cap('DONE', ['backend/crates/done/**'], { state: { backend: 'complete', frontend: 'not_applicable' } });
  const value = plan([complete]);
  assert.deepEqual(value.completed_source_capabilities, []);
  assert.match(value.held[0].reasons.join(','), /completed_source_missing_exact_review_receipt/);
  const invalid = cap('BAD', ['backend/x*/**'], { state: { backend: 'complete', frontend: 'not_applicable' } });
  assert.throws(() => plan([invalid]));
});

test('consolidation is blocked until exact independent review and valid consolidation identity', () => {
  const source = cap('A', ['backend/crates/a/**', 'backend/openapi/openapi.yaml']);
  source.lane_assignments = { source: { owner: source.owner, worktree: source.worktree, branch: source.branch, roots: ['backend/crates/a/**', 'backend/openapi/openapi.yaml', 'docs/evidence/A/**'], resources, tests: source.tests }, consolidation: { owner: 'console-consolidation', worktree: '/tmp/consolidation', branch: 'codex/consolidation', resources } };
  const value = plan([source]);
  assert.equal(value.consolidation_queue[0].ready_after_leaf_review, false);
  assert.match(value.consolidation_queue[0].review_prerequisites.join(','), /exact_leaf_review_receipt_required/);
});

test('quality-weighted maximal independent set is deterministic', () => {
  const economy = cap('ECONOMY', ['backend/crates/shared/**'], { priority: { score: .9, inputs: { correctness_and_risk_reduction: .2, verification_readiness: .2 } } });
  const quality = cap('QUALITY', ['backend/crates/shared/child/**'], { priority: { score: .65, inputs: { correctness_and_risk_reduction: 1, verification_readiness: 1 } } });
  const first = plan([economy, quality], { maxWriters: 1 }); const second = plan([quality, economy], { maxWriters: 1 });
  assert.deepEqual(first.selected.map((entry) => entry.lane_id), ['QUALITY']);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('Buck isolation directories are stable, unique, and reject caller-controlled traversal', async () => {
  const { buckIsolationDir } = await import('./plan-fanout.mjs');
  assert.equal(buckIsolationDir(SHA, 'A#backend'), buckIsolationDir(SHA, 'A#backend'));
  assert.notEqual(buckIsolationDir(SHA, 'A#backend'), buckIsolationDir(SHA, 'A#frontend'));
  assert.match(buckIsolationDir(SHA, 'A#backend'), /^\.buck2\/console-epochs\/[a-f0-9]{12}\/[a-z0-9-]+$/);
  assert.throws(() => buckIsolationDir(SHA, '../escape'));
});
