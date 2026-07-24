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
  assert.match(value.held[0].reasons.join(','), /completed_source_missing_exact_leaf_review_receipts/);
  const invalid = cap('BAD', ['backend/x*/**'], { state: { backend: 'complete', frontend: 'not_applicable' } });
  assert.throws(() => plan([invalid]));
});

test('completed source checks unowned private roots before its review shortcut', () => {
  const complete = cap('DONE', ['backend/crates/done/**'], { state: { backend: 'complete', frontend: 'not_applicable' } });
  complete.lane_assignments = { source: { owner: complete.owner, worktree: complete.worktree, branch: complete.branch, roots: ['docs/evidence/DONE/**'], resources, tests: complete.tests } };
  const value = plan([complete]);
  assert.match(value.held[0].reasons.join(','), /unassigned_private_ownership_roots/);
});

test('consolidation is blocked until exact independent review and valid consolidation identity', () => {
  const source = cap('A', ['backend/crates/a/**', 'backend/openapi/openapi.yaml']);
  source.lane_assignments = { source: { owner: source.owner, worktree: source.worktree, branch: source.branch, roots: ['backend/crates/a/**', 'backend/openapi/openapi.yaml', 'docs/evidence/A/**'], resources, tests: source.tests }, consolidation: { owner: 'console-consolidation', worktree: '/tmp/consolidation', branch: 'codex/consolidation', resources } };
  const value = plan([source]);
  assert.equal(value.consolidation_queue[0].ready_after_leaf_review, false);
  assert.match(value.consolidation_queue[0].review_prerequisites.join(','), /exact_leaf_review_receipts_required/);
});

test('quality-weighted maximal independent set is deterministic', () => {
  const economy = cap('ECONOMY', ['backend/crates/shared/**'], { priority: { score: .9, inputs: { correctness_and_risk_reduction: .2, verification_readiness: .2 } } });
  const quality = cap('QUALITY', ['backend/crates/shared/child/**'], { priority: { score: .65, inputs: { correctness_and_risk_reduction: 1, verification_readiness: 1 } } });
  const first = plan([economy, quality], { maxWriters: 1 }); const second = plan([quality, economy], { maxWriters: 1 });
  assert.deepEqual(first.selected.map((entry) => entry.lane_id), ['QUALITY']);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('Buck isolation directories include a stable full-lane hash and reject caller-controlled traversal', async () => {
  const { buckIsolationDir } = await import('./plan-fanout.mjs');
  assert.equal(buckIsolationDir(SHA, 'A#backend'), buckIsolationDir(SHA, 'A#backend'));
  assert.notEqual(buckIsolationDir(SHA, 'A#backend'), buckIsolationDir(SHA, 'A#frontend'));
  assert.match(buckIsolationDir(SHA, 'A#backend'), /^\.buck2\/console-epochs\/[a-f0-9]{12}\/[a-z0-9-]+-[a-f0-9]{64}$/);
  const prefix = 'A'.repeat(90);
  assert.notEqual(buckIsolationDir(SHA, `${prefix}#one`), buckIsolationDir(SHA, `${prefix}#two`));
  assert.throws(() => buckIsolationDir(SHA, '../escape'));
});

test('review receipts fail closed unless an independent reviewer custody-binds the exact leaf result', async () => {
  const { validateReviewReceiptForAnchor, leafResultDigest } = await import('./plan-fanout.mjs');
  const LEAF = 'b'.repeat(40); const REVIEW = 'c'.repeat(40); const OTHER = 'd'.repeat(40);
  const lane = { laneId: 'A', owner: 'writer-a' };
  const authority = { reviewers: [{ id: 'reviewer-b', author_name: 'Reviewer', author_email: 'review@example.test', committer_name: 'Reviewer', committer_email: 'review@example.test', signing_fingerprint: 'ABCD' }] };
  const receipt = { status: 'approved', epoch_base_sha: SHA, lane_id: 'A', implementer: 'writer-a', reviewer: 'reviewer-b', leaf_commit: LEAF, leaf_result_sha256: leafResultDigest('base..leaf'), review_commit: REVIEW };
  const signature = '[GNUPG:] VALIDSIG ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234 2026-07-24 0 4 0 1 10 00 ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234\n';
  authority.reviewers[0].signing_fingerprint = 'ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234';
  const receiptFromSeparatelyParsedContent = JSON.parse(JSON.stringify(receipt));
  const operations = { hasCommit: (sha) => [LEAF, REVIEW, OTHER].includes(sha), isAncestor: (ancestor, descendant) => ancestor === SHA && descendant === LEAF, parentOf: (sha) => sha === REVIEW ? LEAF : OTHER, changedPaths: () => ['docs/evidence/console/fanout-receipts/559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd.json'], readJson: () => receiptFromSeparatelyParsedContent, leafDiff: () => 'base..leaf', commitIdentity: () => ({ author_name: 'Reviewer', author_email: 'review@example.test', committer_name: 'Reviewer', committer_email: 'review@example.test' }), verifySignature: () => signature };
  assert.deepEqual(validateReviewReceiptForAnchor(receipt, SHA, lane, authority, operations), receipt);
  const forgedDigest = { ...receipt, leaf_result_sha256: 'e'.repeat(64) };
  assert.throws(() => validateReviewReceiptForAnchor(forgedDigest, SHA, lane, authority, { ...operations, readJson: () => forgedDigest }), /digest/);
  assert.throws(() => validateReviewReceiptForAnchor({ ...receipt, implementer: '' }, SHA, lane, authority, operations), /not an exact trusted/);
  assert.throws(() => validateReviewReceiptForAnchor({ ...receipt, reviewer: 'writer-a' }, SHA, lane, authority, operations), /not an exact trusted/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, readJson: () => null }), /absent/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, changedPaths: () => ['code.js'] }), /mutates/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, parentOf: () => OTHER }), /direct child/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, isAncestor: () => false }), /anchored/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, verifySignature: () => '[GNUPG:] VALIDSIG 0000000000000000000000000000000000000000\n' }), /signature/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, verifySignature: () => '[GNUPG:] GOODSIG ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234 reviewer\n' }), /signature/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, verifySignature: () => '[GNUPG:] VALIDSIG malformed\n' }), /signature/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, verifySignature: () => `${signature}[GNUPG:] VALIDSIG malformed\n` }), /signature/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, verifySignature: () => `${signature}${signature}` }), /signature/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, verifySignature: () => { throw new Error('git unavailable'); } }), /unavailable/);
  assert.throws(() => validateReviewReceiptForAnchor(receipt, SHA, lane, authority, { ...operations, commitIdentity: () => ({ author_name: 'Reviewer', author_email: 'review@example.test', committer_name: 'Other', committer_email: 'review@example.test' }) }), /identity/);
});

test('review authority rejects duplicate IDs or fingerprints and incomplete exact identities', async () => {
  const { buildFanoutPlan } = await import('./plan-fanout.mjs');
  const reviewer = { id: 'reviewer-b', author_name: 'Reviewer', author_email: 'review@example.test', committer_name: 'Reviewer', committer_email: 'review@example.test', signing_fingerprint: 'ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234' };
  assert.throws(() => buildFanoutPlan(reg([cap('A', ['backend/crates/a/**'])], { review_authority: { reviewers: [reviewer, { ...reviewer, id: 'reviewer-c' }] } }), { anchorSha: SHA, maxWriters: 3, qualityBias: .6, generatedFaces: faces }), /duplicate trusted reviewer signing fingerprint/);
  assert.throws(() => buildFanoutPlan(reg([cap('A', ['backend/crates/a/**'])], { review_authority: { reviewers: [reviewer, { ...reviewer, signing_fingerprint: 'BCDE1234ABCD1234ABCD1234ABCD1234ABCD1234' }] } }), { anchorSha: SHA, maxWriters: 3, qualityBias: .6, generatedFaces: faces }), /duplicate trusted reviewer id/);
  assert.throws(() => buildFanoutPlan(reg([cap('A', ['backend/crates/a/**'])], { review_authority: { reviewers: [{ ...reviewer, committer_email: 'committer@example.test ' }] } }), { anchorSha: SHA, maxWriters: 3, qualityBias: .6, generatedFaces: faces }), /invalid trusted reviewer identity/);
});

test('admission manifests are single-parent manifest-only commits with unique connected references', async () => {
  const { validateAdmissionManifest } = await import('./plan-fanout.mjs');
  const REVIEW_A = 'b'.repeat(40); const REVIEW_B = 'c'.repeat(40); const ADMISSION = 'd'.repeat(40);
  const manifest = { schema_version: 'console-fanout-admission-v1', epoch_base_sha: SHA, receipts: [
    { lane_id: 'A', review_commit: REVIEW_A, receipt_path: 'docs/evidence/console/fanout-receipts/559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd.json' },
    { lane_id: 'B', review_commit: REVIEW_B, receipt_path: 'docs/evidence/console/fanout-receipts/df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c.json' },
  ] };
  const operations = { parentCount: () => 1, changedPaths: () => ['docs/evidence/console/fanout-admission.json'], isAncestor: (ancestor, descendant) => descendant === ADMISSION && [REVIEW_A, REVIEW_B].includes(ancestor), readJson: (sha) => ({ lane_id: sha === REVIEW_A ? 'A' : 'B', review_commit: sha }) };
  assert.deepEqual(validateAdmissionManifest(manifest, SHA, ADMISSION, operations), manifest.receipts);
  assert.throws(() => validateAdmissionManifest(manifest, SHA, ADMISSION, { ...operations, parentCount: () => 2 }), /single-parent/);
  assert.throws(() => validateAdmissionManifest(manifest, SHA, ADMISSION, { ...operations, changedPaths: () => ['docs/evidence/console/fanout-admission.json', 'unrelated.txt'] }), /manifest-only/);
  assert.throws(() => validateAdmissionManifest({ ...manifest, receipts: [manifest.receipts[0], { ...manifest.receipts[0] }] }, SHA, ADMISSION, operations), /duplicate/);
  assert.throws(() => validateAdmissionManifest({ ...manifest, receipts: [manifest.receipts[0], { ...manifest.receipts[1], review_commit: REVIEW_A }] }, SHA, ADMISSION, operations), /duplicate/);
  assert.throws(() => validateAdmissionManifest(manifest, SHA, ADMISSION, { ...operations, isAncestor: () => false }), /ancestor/);
});

test('runtime-ineligible lanes are held before ranking so lower safe lanes fill capacity', () => {
  const high = cap('HIGH', ['backend/crates/high/**'], { priority: { score: 1, inputs: { correctness_and_risk_reduction: 1, verification_readiness: 1 } } });
  const low = cap('LOW', ['backend/crates/low/**'], { priority: { score: .2, inputs: { correctness_and_risk_reduction: .2, verification_readiness: .2 } } });
  const value = plan([high, low], { maxWriters: 1, runtimeLaneEligibility: { HIGH: 'declared_worktree_dirty' } });
  assert.deepEqual(value.selected.map((lane) => lane.lane_id), ['LOW']);
  assert.match(value.held.find((entry) => entry.lane_id === 'HIGH').reasons.join(','), /declared_worktree_dirty/);
});

test('source revision syntax requires a full immutable baseline SHA', async () => {
  const { parseSourceRevision } = await import('./plan-fanout.mjs');
  assert.deepEqual(parseSourceRevision(`origin/main@${SHA}`), { ref: 'origin/main', sha: SHA });
  for (const bad of ['origin/main@abcdef', `origin/main@${'A'.repeat(40)}`, `origin/main@${SHA} trailing`, `@${SHA}`]) assert.throws(() => parseSourceRevision(bad));
});

test('source provenance admits only an existing immutable ancestor and non-conflicting ref', async () => {
  const { validateSourceRevisionForAnchor } = await import('./plan-fanout.mjs');
  const BASE = 'b'.repeat(40); const ANCHOR = 'c'.repeat(40); const OTHER = 'd'.repeat(40);
  const operations = { hasCommit: (sha) => [BASE, ANCHOR, OTHER].includes(sha), isAncestor: (a, b) => a === b || (a === BASE && b === ANCHOR), resolveRef: (ref) => ref === 'origin/main' ? ANCHOR : null };
  assert.deepEqual(validateSourceRevisionForAnchor(`origin/main@${BASE}`, ANCHOR, operations), { ref: 'origin/main', sha: BASE });
  assert.throws(() => validateSourceRevisionForAnchor(`origin/main@${'e'.repeat(40)}`, ANCHOR, operations), /does not exist/);
  assert.throws(() => validateSourceRevisionForAnchor(`origin/main@${OTHER}`, ANCHOR, operations), /not an ancestor/);
  assert.throws(() => validateSourceRevisionForAnchor(`origin/main@${'abcdef'}`, ANCHOR, operations));
  assert.throws(() => validateSourceRevisionForAnchor(`origin/main@${OTHER}`, OTHER, { ...operations, resolveRef: () => BASE }), /behind or conflicts/);
});
