import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFanoutPlan,
  patternsOverlap,
} from './plan-fanout.mjs';

const SHA = 'a'.repeat(40);

function capability({
  id,
  score = 0.5,
  correctness = 0.5,
  verification = 0.5,
  roots,
  dependencies = [],
  backend = 'writer_assigned_in_progress',
  frontend = 'writer_assigned_in_progress',
  review = 'missing',
  buckTargets = ['//backend/example:test'],
}) {
  return {
    id,
    label: id,
    frontier: 1,
    priority: {
      score,
      inputs: {
        correctness_and_risk_reduction: correctness,
        verification_readiness: verification,
      },
    },
    dependencies,
    owner: `owner-${id}`,
    worktree: `/tmp/${id}`,
    branch: `codex/${id}`,
    ownership: {
      frontend_roots: roots.filter((root) => root.startsWith('web/')),
      backend_roots: roots.filter((root) => root.startsWith('backend/crates/')),
      api_schema_roots: roots.filter((root) => root.startsWith('backend/openapi/')),
      migration_owner: 'not_applicable',
      integration_owner: 'console-consolidation',
    },
    signature_story: { id: `STORY-${id}`, outcome: `Complete ${id}` },
    evidence_path: `docs/evidence/console/${id}/`,
    tests: {
      files: [],
      leaf_commands: ['git diff --check'],
      buck2_targets: buckTargets,
    },
    state: {
      backend,
      frontend,
      independent_review: review,
      production_exposure: 'dark',
    },
  };
}

function registry(capabilities) {
  return {
    schema_version: 'console-capability-registry-v1',
    source_revision: `origin/main@${SHA}`,
    shared_collision_roots: {
      owner: 'console-consolidation',
      generated_face_registry: 'tools/buck/generated_face_registry.json',
      paths: [
        'backend/openapi/openapi.yaml',
        'backend/migrations/**',
        'web/src/console/screens/registry.ts',
      ],
    },
    capabilities,
  };
}

const generatedFaces = {
  schema_version: 2,
  faces: [
    {
      id: 'openapi-typescript',
      output_patterns: ['clients/ts/src/schema.d.ts'],
    },
  ],
};

test('path-pattern overlap is boundary aware', () => {
  assert.equal(patternsOverlap('backend/crates/equipment/**', 'backend/crates/equipment/rest/src/lib.rs'), true);
  assert.equal(patternsOverlap('backend/crates/equipment/**', 'backend/crates/equipment2/**'), false);
  assert.equal(patternsOverlap('web/src/x.ts', 'web/src/x.ts'), true);
});

test('a broad module root remains private while generated files inside it are excluded', () => {
  const plan = buildFanoutPlan(
    registry([
      capability({
        id: 'A',
        roots: ['backend/crates/equipment/**'],
      }),
    ]),
    {
      anchorSha: SHA,
      maxWriters: 1,
      qualityBias: 0.6,
      generatedFaces: {
        schema_version: 2,
        faces: [{ id: 'buck', output_patterns: ['backend/crates/**/BUCK'] }],
      },
    },
  );

  assert.deepEqual(plan.selected[0].private_roots, [
    'backend/crates/equipment/**',
    'docs/evidence/console/A/**',
  ]);
  assert.deepEqual(plan.selected[0].excluded_shared_roots, ['backend/crates/**/BUCK']);
});

test('shared generated faces are serialized without reducing leaf fan-out', () => {
  const plan = buildFanoutPlan(
    registry([
      capability({
        id: 'A',
        roots: ['backend/crates/a/**', 'backend/openapi/openapi.yaml', 'clients/ts/src/schema.d.ts'],
      }),
      capability({
        id: 'B',
        roots: ['backend/crates/b/**', 'backend/openapi/openapi.yaml', 'clients/ts/src/schema.d.ts'],
      }),
    ]),
    { anchorSha: SHA, maxWriters: 2, qualityBias: 0.6, generatedFaces },
  );

  assert.deepEqual(plan.selected.map((lane) => lane.lane_id), ['A', 'B']);
  assert.deepEqual(plan.private_conflicts, []);
  assert.deepEqual(
    plan.consolidation_queue.map((lane) => lane.capability_id),
    ['A', 'B'],
  );
  assert.deepEqual(plan.selected[0].private_roots, [
    'backend/crates/a/**',
    'docs/evidence/console/A/**',
  ]);
});

test('private ownership overlap is never co-scheduled', () => {
  const plan = buildFanoutPlan(
    registry([
      capability({ id: 'A', score: 0.8, roots: ['backend/crates/shared/**'] }),
      capability({ id: 'B', score: 0.7, roots: ['backend/crates/shared/child/**'] }),
    ]),
    { anchorSha: SHA, maxWriters: 2, qualityBias: 0.6, generatedFaces },
  );

  assert.equal(plan.selected.length, 1);
  assert.deepEqual(plan.private_conflicts, [
    {
      lane_ids: ['A', 'B'],
      roots: ['backend/crates/shared/**', 'backend/crates/shared/child/**'],
    },
  ]);
});

test('admission fails closed for incomplete ownership and backend gates', () => {
  const incomplete = capability({ id: 'A', roots: ['backend/crates/a/**'], buckTargets: [] });
  incomplete.owner = 'unassigned';
  incomplete.worktree = null;
  incomplete.signature_story = null;

  const plan = buildFanoutPlan(registry([incomplete]), {
    anchorSha: SHA,
    maxWriters: 2,
    qualityBias: 0.6,
    generatedFaces,
  });

  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.held[0].reasons, [
    'missing_assigned_owner',
    'missing_isolated_worktree',
    'missing_signature_story',
    'missing_backend_buck_targets',
  ]);
});

test('quality bias wins deterministic writer contention', () => {
  const plan = buildFanoutPlan(
    registry([
      capability({
        id: 'ECONOMY',
        score: 0.9,
        correctness: 0.2,
        verification: 0.2,
        roots: ['backend/crates/shared/**'],
      }),
      capability({
        id: 'QUALITY',
        score: 0.65,
        correctness: 1,
        verification: 1,
        roots: ['backend/crates/shared/child/**'],
      }),
    ]),
    { anchorSha: SHA, maxWriters: 1, qualityBias: 0.6, generatedFaces },
  );

  assert.deepEqual(plan.selected.map((lane) => lane.lane_id), ['QUALITY']);
});

test('unfinished dependencies are merge holds, not source-write blockers', () => {
  const plan = buildFanoutPlan(
    registry([
      capability({ id: 'UPSTREAM', roots: ['backend/crates/upstream/**'], frontend: 'missing' }),
      capability({
        id: 'LEAF',
        roots: ['backend/crates/leaf/**'],
        dependencies: ['UPSTREAM'],
      }),
    ]),
    { anchorSha: SHA, maxWriters: 2, qualityBias: 0.6, generatedFaces },
  );

  assert.deepEqual(plan.selected.map((lane) => lane.lane_id), ['LEAF', 'UPSTREAM']);
  assert.deepEqual(plan.merge_dependency_holds, [
    { capability_id: 'LEAF', unresolved_dependencies: ['UPSTREAM'] },
  ]);
});

test('one capability can safely fan out backend and frontend writers', () => {
  const split = capability({
    id: 'SPLIT',
    roots: [
      'backend/crates/split/**',
      'web/src/console/split/**',
      'backend/openapi/openapi.yaml',
    ],
  });
  split.owner = 'unassigned';
  split.worktree = null;
  split.branch = null;
  split.lane_assignments = {
    backend: {
      owner: 'backend-owner',
      worktree: '/tmp/split-backend',
      branch: 'codex/split-backend',
      roots: ['backend/crates/split/**'],
    },
    frontend: {
      owner: 'frontend-owner',
      worktree: '/tmp/split-frontend',
      branch: 'codex/split-frontend',
      roots: ['web/src/console/split/**', 'docs/evidence/console/SPLIT/**'],
    },
    consolidation: {
      owner: 'console-consolidation',
    },
  };

  const plan = buildFanoutPlan(registry([split]), {
    anchorSha: SHA,
    maxWriters: 2,
    qualityBias: 0.6,
    generatedFaces,
  });

  assert.deepEqual(plan.selected.map((lane) => lane.lane_id), ['SPLIT#backend', 'SPLIT#frontend']);
  assert.deepEqual(plan.consolidation_queue, [
    {
      capability_id: 'SPLIT',
      shared_roots: ['backend/openapi/openapi.yaml'],
      ready_after_leaf_review: true,
      awaiting_lane_ids: [],
    },
  ]);
});

test('identical inputs produce byte-stable plan data', () => {
  const input = registry([
    capability({ id: 'B', roots: ['backend/crates/b/**'] }),
    capability({ id: 'A', roots: ['backend/crates/a/**'] }),
  ]);
  const options = { anchorSha: SHA, maxWriters: 2, qualityBias: 0.6, generatedFaces };
  assert.equal(JSON.stringify(buildFanoutPlan(input, options)), JSON.stringify(buildFanoutPlan(input, options)));
});
