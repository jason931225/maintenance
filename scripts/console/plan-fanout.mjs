#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;
const QUALITY_BIAS_DEFAULT = 0.6;

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function round(value) {
  return Number(value.toFixed(6));
}

export function normalizePattern(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('ownership pattern must be a non-empty string');
  }

  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (
    path.posix.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized.includes('\0')
    || /\s/.test(normalized)
  ) {
    throw new Error(`ownership pattern must be a repository-relative path: ${value}`);
  }
  return normalized.replace(/\/$/, '');
}

function patternBase(value) {
  const normalized = normalizePattern(value);
  const wildcard = normalized.search(/[*?[{]/);
  return (wildcard === -1 ? normalized : normalized.slice(0, wildcard)).replace(/\/$/, '');
}

function isBoundaryPrefix(prefix, candidate) {
  return prefix === candidate || candidate.startsWith(`${prefix}/`);
}

export function patternsOverlap(left, right) {
  const leftBase = patternBase(left);
  const rightBase = patternBase(right);
  if (leftBase === '' || rightBase === '') {
    return true;
  }
  return isBoundaryPrefix(leftBase, rightBase) || isBoundaryPrefix(rightBase, leftBase);
}

function globRegex(pattern) {
  const normalized = normalizePattern(pattern);
  let expression = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      expression += '.*';
      index += 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`);
}

function patternFullyCovers(sharedPattern, ownedPattern) {
  const shared = normalizePattern(sharedPattern);
  const owned = normalizePattern(ownedPattern);
  if (shared === owned) {
    return true;
  }

  const sharedWildcard = shared.search(/[*?[{]/);
  if (sharedWildcard === -1) {
    return false;
  }

  const isSimpleSubtree = shared.endsWith('/**')
    && shared.slice(0, -3).search(/[*?[{]/) === -1;
  if (isSimpleSubtree) {
    const sharedRoot = shared.slice(0, -3);
    return isBoundaryPrefix(sharedRoot, patternBase(owned));
  }

  const ownedWildcard = owned.search(/[*?[{]/);
  return ownedWildcard === -1 && globRegex(shared).test(owned);
}

function arrays(value) {
  return Array.isArray(value) ? value : [];
}

function stateText(capability, key) {
  const value = capability.state?.[key];
  return typeof value === 'string' ? value : '';
}

function backendSettled(value) {
  return value === 'not_applicable'
    || value.startsWith('existing_real_')
    || value === 'integrated_on_local_train'
    || value === 'integrated_dark_on_pr488'
    || value === 'complete';
}

function frontendSettled(value) {
  return value === 'not_applicable'
    || value === 'integrated_on_local_train'
    || value === 'integrated_dark_on_pr488'
    || value === 'complete';
}

function sourceComplete(capability) {
  return backendSettled(stateText(capability, 'backend'))
    && frontendSettled(stateText(capability, 'frontend'));
}

function laneSourceComplete(capability, laneKind) {
  if (laneKind.includes('frontend')) {
    return frontendSettled(stateText(capability, 'frontend'));
  }
  if (laneKind.includes('backend')) {
    return backendSettled(stateText(capability, 'backend'));
  }
  return sourceComplete(capability);
}

function independentReviewComplete(capability) {
  const review = stateText(capability, 'independent_review');
  return review === 'approved'
    || /^i\d+_independent_approved$/.test(review)
    || review === 'complete';
}

function capabilityRoots(capability) {
  const ownership = capability.ownership ?? {};
  return [
    ...arrays(ownership.frontend_roots),
    ...arrays(ownership.backend_roots),
    ...arrays(ownership.api_schema_roots),
  ];
}

function classifyRoots(rawRoots, sharedPatterns) {
  const invalid = [];
  const normalized = [];

  for (const rawRoot of rawRoots) {
    try {
      normalized.push(normalizePattern(rawRoot));
    } catch (error) {
      invalid.push(error instanceof Error ? error.message : String(error));
    }
  }

  const roots = [...new Set(normalized)].sort(compareText);
  const shared = sharedPatterns.filter((pattern) => (
    roots.some((root) => patternsOverlap(root, pattern))
  ));
  const fullyShared = new Set(roots.filter((root) => (
    sharedPatterns.some((pattern) => patternFullyCovers(pattern, root))
  )));
  return {
    invalid,
    privateRoots: roots.filter((root) => !fullyShared.has(root)),
    sharedRoots: shared,
    excludedSharedRoots: shared.filter((pattern) => (
      roots.some((root) => !fullyShared.has(root) && patternsOverlap(root, pattern))
    )),
  };
}

function sourceLaneDefinitions(capability) {
  const assignments = capability.lane_assignments ?? {};
  const splitLanes = Object.entries(assignments)
    .filter(([name, assignment]) => (
      name !== 'consolidation'
      && assignment
      && typeof assignment === 'object'
      && arrays(assignment.roots).length > 0
    ))
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, assignment]) => ({
      laneId: `${capability.id}#${name}`,
      kind: name,
      owner: assignment.owner,
      worktree: assignment.worktree,
      branch: assignment.branch,
      roots: arrays(assignment.roots),
      leafCommands: arrays(assignment.tests?.leaf_commands).length > 0
        ? arrays(assignment.tests.leaf_commands)
        : arrays(capability.tests?.leaf_commands),
      buckTargets: arrays(assignment.tests?.buck2_targets).length > 0
        ? arrays(assignment.tests.buck2_targets)
        : arrays(capability.tests?.buck2_targets),
    }));

  if (splitLanes.length > 0) {
    return splitLanes;
  }
  const evidenceRoot = typeof capability.evidence_path === 'string'
    ? `${normalizePattern(capability.evidence_path)}/**`
    : null;
  return [{
    laneId: capability.id,
    kind: 'source',
    owner: capability.owner,
    worktree: capability.worktree,
    branch: capability.branch,
    roots: [...capabilityRoots(capability), ...(evidenceRoot ? [evidenceRoot] : [])],
    leafCommands: arrays(capability.tests?.leaf_commands),
    buckTargets: arrays(capability.tests?.buck2_targets),
  }];
}

function admissionReasons(capability, lane, roots, evidenceOwned) {
  const reasons = [];
  if (!lane.owner || lane.owner === 'unassigned') {
    reasons.push('missing_assigned_owner');
  }
  if (typeof lane.worktree !== 'string' || !path.isAbsolute(lane.worktree)) {
    reasons.push('missing_isolated_worktree');
  }
  if (typeof lane.branch !== 'string' || lane.branch.trim() === '') {
    reasons.push('missing_branch');
  }
  if (
    !capability.signature_story
    || typeof capability.signature_story.id !== 'string'
    || typeof capability.signature_story.outcome !== 'string'
    || capability.signature_story.outcome.trim() === ''
  ) {
    reasons.push('missing_signature_story');
  }
  if (typeof capability.evidence_path !== 'string' || capability.evidence_path.trim() === '') {
    reasons.push('missing_evidence_path');
  } else if (!evidenceOwned) {
    reasons.push('missing_evidence_write_owner');
  }
  if (lane.leafCommands.length === 0) {
    reasons.push('missing_leaf_gates');
  }
  if (roots.invalid.length > 0) {
    reasons.push('invalid_ownership_roots');
  }
  if (roots.privateRoots.length === 0) {
    reasons.push('missing_private_ownership_roots');
  }

  const ownsBackend = lane.roots.some((root) => (
    typeof root === 'string' && root.startsWith('backend/')
  ));
  if (
    ownsBackend
    && stateText(capability, 'backend') !== 'not_applicable'
    && lane.buckTargets.length === 0
  ) {
    reasons.push('missing_backend_buck_targets');
  }
  return reasons;
}

function laneScore(capability, qualityBias) {
  const score = finiteNumber(capability.priority?.score);
  const correctness = finiteNumber(capability.priority?.inputs?.correctness_and_risk_reduction, score);
  const verification = finiteNumber(capability.priority?.inputs?.verification_readiness, score);
  return (1 - qualityBias) * score + qualityBias * ((correctness + verification) / 2);
}

function conflictBetween(left, right) {
  for (const leftRoot of left.private_roots) {
    for (const rightRoot of right.private_roots) {
      if (patternsOverlap(leftRoot, rightRoot)) {
        return [leftRoot, rightRoot];
      }
    }
  }
  return null;
}

function validateInputs(registry, options) {
  if (!registry || registry.schema_version !== 'console-capability-registry-v1') {
    throw new Error('unsupported console capability registry schema');
  }
  if (!FULL_SHA.test(options.anchorSha ?? '')) {
    throw new Error('anchor SHA must be a full lowercase 40-character Git SHA');
  }
  if (!Number.isInteger(options.maxWriters) || options.maxWriters < 1) {
    throw new Error('max writers must be a positive integer');
  }
  if (
    !Number.isFinite(options.qualityBias)
    || options.qualityBias < 0
    || options.qualityBias > 1
  ) {
    throw new Error('quality bias must be between 0 and 1');
  }
  if (!Array.isArray(registry.capabilities)) {
    throw new Error('registry capabilities must be an array');
  }
}

export function buildFanoutPlan(registry, options) {
  validateInputs(registry, options);

  const generatedFaces = options.generatedFaces ?? { schema_version: null, faces: [] };
  const declaredShared = arrays(registry.shared_collision_roots?.paths).map(normalizePattern);
  const generatedShared = arrays(generatedFaces.faces)
    .flatMap((face) => arrays(face.output_patterns))
    .map(normalizePattern);
  const sharedPatterns = [...new Set([...declaredShared, ...generatedShared])].sort(compareText);

  const ids = new Set();
  for (const capability of registry.capabilities) {
    if (typeof capability.id !== 'string' || capability.id === '') {
      throw new Error('every capability requires a stable id');
    }
    if (ids.has(capability.id)) {
      throw new Error(`duplicate capability id: ${capability.id}`);
    }
    ids.add(capability.id);
  }

  const held = [];
  const admitted = [];
  const completed = [];
  const completedLeafLanes = [];
  const reviewReady = [];
  const sharedRootsByCapability = new Map();
  const laneIdsByCapability = new Map();
  const unassignedRootsByCapability = new Map();

  for (const capability of [...registry.capabilities].sort((left, right) => compareText(left.id, right.id))) {
    const capabilityRootClasses = classifyRoots(capabilityRoots(capability), sharedPatterns);
    sharedRootsByCapability.set(capability.id, capabilityRootClasses.sharedRoots);
    if (sourceComplete(capability)) {
      completed.push(capability.id);
      if (!independentReviewComplete(capability)) {
        reviewReady.push({
          capability_id: capability.id,
          reason: 'source_complete_independent_review_required',
        });
      }
      continue;
    }

    const sourceLanes = sourceLaneDefinitions(capability);
    const assignedRootPatterns = sourceLanes.flatMap((lane) => lane.roots);
    const unassignedRoots = capabilityRootClasses.privateRoots.filter((root) => (
      !assignedRootPatterns.some((assignedRoot) => {
        try {
          return patternFullyCovers(assignedRoot, root);
        } catch {
          return false;
        }
      })
    ));
    unassignedRootsByCapability.set(capability.id, unassignedRoots);
    if (unassignedRoots.length > 0) {
      held.push({
        capability_id: capability.id,
        lane_id: `${capability.id}#unowned-roots`,
        reasons: ['unassigned_private_ownership_roots'],
        invalid_roots: [],
        unassigned_roots: unassignedRoots,
      });
    }

    const incompleteSourceLanes = sourceLanes.filter((lane) => {
      if (!laneSourceComplete(capability, lane.kind)) {
        return true;
      }
      completedLeafLanes.push(lane.laneId);
      if (!independentReviewComplete(capability)) {
        reviewReady.push({
          capability_id: capability.id,
          lane_id: lane.laneId,
          reason: 'source_lane_complete_independent_review_required',
        });
      }
      return false;
    });
    laneIdsByCapability.set(
      capability.id,
      incompleteSourceLanes.map((lane) => lane.laneId),
    );
    const evidencePath = typeof capability.evidence_path === 'string'
      ? normalizePattern(capability.evidence_path)
      : null;
    const evidenceOwned = evidencePath !== null && sourceLanes.some((lane) => (
      lane.roots.some((root) => {
        try {
          return patternFullyCovers(root, evidencePath);
        } catch {
          return false;
        }
      })
    ));
    for (const lane of incompleteSourceLanes) {
      const roots = classifyRoots(lane.roots, sharedPatterns);
      const reasons = admissionReasons(capability, lane, roots, evidenceOwned);
      if (reasons.length > 0) {
        held.push({
          capability_id: capability.id,
          lane_id: lane.laneId,
          reasons,
          invalid_roots: roots.invalid,
        });
        continue;
      }

      admitted.push({
        capability_id: capability.id,
        lane_id: lane.laneId,
        lane_kind: lane.kind,
        owner: lane.owner,
        worktree: lane.worktree,
        branch: lane.branch,
        signature_story_id: capability.signature_story.id,
        evidence_path: capability.evidence_path,
        private_roots: roots.privateRoots,
        shared_roots: roots.sharedRoots,
        excluded_shared_roots: roots.excludedSharedRoots,
        buck2_targets: [...new Set(lane.buckTargets)].sort(compareText),
        leaf_commands: [...new Set(lane.leafCommands)].sort(compareText),
        quality_utility: round(laneScore(capability, options.qualityBias)),
        dependencies: [...new Set(arrays(capability.dependencies))].sort(compareText),
      });
    }
  }

  const privateConflicts = [];
  const degree = new Map(admitted.map((lane) => [lane.lane_id, 0]));
  for (let leftIndex = 0; leftIndex < admitted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < admitted.length; rightIndex += 1) {
      const left = admitted[leftIndex];
      const right = admitted[rightIndex];
      const roots = conflictBetween(left, right);
      if (!roots) {
        continue;
      }
      privateConflicts.push({
        lane_ids: [left.lane_id, right.lane_id],
        roots,
      });
      degree.set(left.lane_id, degree.get(left.lane_id) + 1);
      degree.set(right.lane_id, degree.get(right.lane_id) + 1);
    }
  }

  const ranked = admitted
    .map((lane) => ({
      ...lane,
      selection_density: round(lane.quality_utility / (1 + degree.get(lane.lane_id))),
    }))
    .sort((left, right) => (
      right.selection_density - left.selection_density
      || right.quality_utility - left.quality_utility
      || compareText(left.lane_id, right.lane_id)
    ));

  const selected = [];
  const collisionBlocked = [];
  for (const lane of ranked) {
    if (selected.length >= options.maxWriters) {
      collisionBlocked.push({
        capability_id: lane.capability_id,
        lane_id: lane.lane_id,
        reason: 'writer_budget_exhausted',
      });
      continue;
    }
    const conflict = selected.find((chosen) => conflictBetween(lane, chosen));
    if (conflict) {
      collisionBlocked.push({
        capability_id: lane.capability_id,
        lane_id: lane.lane_id,
        reason: 'private_root_conflict',
        conflicts_with: conflict.lane_id,
      });
      continue;
    }
    selected.push(lane);
  }

  const byId = new Map(registry.capabilities.map((capability) => [capability.id, capability]));
  const selectedCapabilities = [...new Set(selected.map((lane) => lane.capability_id))].sort(compareText);
  const mergeDependencyHolds = selectedCapabilities
    .map((capabilityId) => {
      const lane = selected.find((candidate) => candidate.capability_id === capabilityId);
      return {
      capability_id: capabilityId,
      unresolved_dependencies: lane.dependencies.filter((dependency) => {
        const upstream = byId.get(dependency);
        return !upstream || !sourceComplete(upstream);
      }),
    };
    })
    .filter((entry) => entry.unresolved_dependencies.length > 0)
    .sort((left, right) => compareText(left.capability_id, right.capability_id));

  const consolidationQueue = selectedCapabilities
    .map((capabilityId) => {
      const selectedLaneIds = new Set(
        selected
          .filter((lane) => lane.capability_id === capabilityId)
          .map((lane) => lane.lane_id),
      );
      const awaitingLaneIds = (laneIdsByCapability.get(capabilityId) ?? [])
        .filter((laneId) => !selectedLaneIds.has(laneId))
        .sort(compareText);
      const unassignedRoots = unassignedRootsByCapability.get(capabilityId) ?? [];
      return {
        capability_id: capabilityId,
        shared_roots: sharedRootsByCapability.get(capabilityId) ?? [],
        ready_after_leaf_review: awaitingLaneIds.length === 0 && unassignedRoots.length === 0,
        awaiting_lane_ids: awaitingLaneIds,
        awaiting_unassigned_roots: unassignedRoots,
      };
    })
    .filter((lane) => lane.shared_roots.length > 0)
    .sort((left, right) => compareText(left.capability_id, right.capability_id));

  const reviewQueue = [
    ...selected.map((lane) => ({
      capability_id: lane.capability_id,
      lane_id: lane.lane_id,
      reason: 'leaf_result_requires_fresh_independent_review',
    })),
    ...reviewReady,
  ].sort((left, right) => (
    compareText(left.capability_id, right.capability_id)
    || compareText(left.reason, right.reason)
  ));

  return {
    schema_version: 'console-fanout-epoch-v1',
    anchor_sha: options.anchorSha,
    authority: {
      registry_schema: registry.schema_version,
      registry_digest_sha256: digest(registry),
      registry_source_revision: registry.source_revision ?? null,
      generated_face_registry_schema: generatedFaces.schema_version ?? null,
      generated_face_registry_digest_sha256: digest(generatedFaces),
    },
    policy: {
      max_writer_lanes: options.maxWriters,
      quality_bias: options.qualityBias,
      shared_owner: registry.shared_collision_roots?.owner ?? null,
      dependency_behavior: 'source_parallel_merge_fail_closed',
      generated_face_behavior: 'single_writer_after_leaf_review',
      selection_algorithm: 'deterministic_quality_weighted_maximal_independent_set',
    },
    selected,
    held,
    collision_blocked: collisionBlocked,
    completed_source_capabilities: completed,
    completed_leaf_lanes: completedLeafLanes.sort(compareText),
    private_conflicts: privateConflicts,
    merge_dependency_holds: mergeDependencyHolds,
    review_queue: reviewQueue,
    consolidation_queue: consolidationQueue,
  };
}

function usage() {
  return [
    'usage: node scripts/console/plan-fanout.mjs --anchor <40-char-sha> [options]',
    '',
    'options:',
    '  --registry <path>       capability registry (default: docs/program/console-capability-registry.json)',
    '  --max-writers <count>   bounded source writers (default: 6)',
    `  --quality-bias <0..1>   quality weighting (default: ${QUALITY_BIAS_DEFAULT})`,
  ].join('\n');
}

function parseArgs(argv) {
  const result = {
    registryPath: 'docs/program/console-capability-registry.json',
    anchorSha: null,
    maxWriters: 6,
    qualityBias: QUALITY_BIAS_DEFAULT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${argument}`);
    }
    if (argument === '--registry') {
      result.registryPath = value;
    } else if (argument === '--anchor') {
      result.anchorSha = value;
    } else if (argument === '--max-writers') {
      result.maxWriters = Number(value);
    } else if (argument === '--quality-bias') {
      result.qualityBias = Number(value);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
    index += 1;
  }
  return result;
}

function readRepoJson(repoRoot, relativePath) {
  const absolute = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`authority path escapes repository: ${relativePath}`);
  }
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const registry = readRepoJson(repoRoot, args.registryPath);
  const generatedRegistryPath = registry.shared_collision_roots?.generated_face_registry;
  const generatedFaces = generatedRegistryPath
    ? readRepoJson(repoRoot, generatedRegistryPath)
    : { schema_version: null, faces: [] };
  const plan = buildFanoutPlan(registry, {
    anchorSha: args.anchorSha,
    maxWriters: args.maxWriters,
    qualityBias: args.qualityBias,
    generatedFaces,
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`console-fanout-plan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
