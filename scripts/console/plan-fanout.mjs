#!/usr/bin/env node

import { createHash } from 'node:crypto';

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;
const QUALITY_BIAS_DEFAULT = 0.6;
const RESOURCE_KEYS = ['writer', 'postgres', 'browser', 'ios', 'graph', 'cas'];

function compareText(a, b) { return a.localeCompare(b, 'en'); }
function arrays(value) { return Array.isArray(value) ? value : []; }
function finiteNumber(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }
function round(value) { return Number(value.toFixed(6)); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function registryDigest(registry) { return digest({ ...registry, capabilities: [...registry.capabilities].sort((a, b) => compareText(a.id, b.id)) }); }

/** Only repository literals and a terminal subtree suffix are ownership syntax. */
export function normalizePattern(value) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') throw new Error('ownership pattern must be a non-empty canonical string');
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.endsWith('/') || /[?*[{]/.test(value.replace(/\/\*\*$/, ''))) throw new Error(`unsupported ownership wildcard or path alias: ${value}`);
  const subtree = value.endsWith('/**');
  const literal = subtree ? value.slice(0, -3) : value;
  if (literal === '' || literal === '.' || literal === '..' || literal.startsWith('./') || literal.startsWith('../') || literal.includes('/./') || literal.includes('/../') || literal.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error(`ownership pattern must be a repository-relative literal: ${value}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(literal)) throw new Error(`ownership pattern contains unsupported characters: ${value}`);
  return subtree ? `${literal}/**` : literal;
}
function isSubtree(pattern) { return pattern.endsWith('/**'); }
function patternRoot(pattern) { const normalized = normalizePattern(pattern); return isSubtree(normalized) ? normalized.slice(0, -3) : normalized; }
function boundaryPrefix(prefix, candidate) { return prefix === candidate || candidate.startsWith(`${prefix}/`); }
export function patternsOverlap(left, right) {
  const leftNormal = normalizePattern(left); const rightNormal = normalizePattern(right);
  const leftRoot = patternRoot(leftNormal); const rightRoot = patternRoot(rightNormal);
  if (!isSubtree(leftNormal) && !isSubtree(rightNormal)) return leftRoot === rightRoot;
  if (isSubtree(leftNormal) && isSubtree(rightNormal)) return boundaryPrefix(leftRoot, rightRoot) || boundaryPrefix(rightRoot, leftRoot);
  return isSubtree(leftNormal) ? boundaryPrefix(leftRoot, rightRoot) : boundaryPrefix(rightRoot, leftRoot);
}
function patternFullyCovers(parent, child) {
  const normalizedParent = normalizePattern(parent); const normalizedChild = normalizePattern(child);
  return normalizedParent === normalizedChild || (isSubtree(normalizedParent) && boundaryPrefix(patternRoot(normalizedParent), patternRoot(normalizedChild)));
}
function validatePatternList(values, label) { return arrays(values).map((value) => { try { return normalizePattern(value); } catch (error) { throw new Error(`${label}: ${error.message}`); } }); }
function stateText(capability, key) { return typeof capability.state?.[key] === 'string' ? capability.state[key] : ''; }
function backendSettled(value) { return value === 'not_applicable' || value.startsWith('existing_real_') || ['integrated_on_local_train', 'integrated_dark_on_pr488', 'complete'].includes(value); }
function frontendSettled(value) { return value === 'not_applicable' || ['integrated_on_local_train', 'integrated_dark_on_pr488', 'complete'].includes(value); }
function sourceComplete(capability) { return backendSettled(stateText(capability, 'backend')) && frontendSettled(stateText(capability, 'frontend')); }
function laneSourceComplete(capability, kind) { return kind.includes('frontend') ? frontendSettled(stateText(capability, 'frontend')) : kind.includes('backend') ? backendSettled(stateText(capability, 'backend')) : sourceComplete(capability); }
function capabilityRoots(capability) { const ownership = capability.ownership ?? {}; return [...arrays(ownership.frontend_roots), ...arrays(ownership.backend_roots), ...arrays(ownership.api_schema_roots)]; }
function validResources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  for (const key of RESOURCE_KEYS) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return null;
    normalized[key] = value[key];
  }
  return normalized.writer === 1 ? normalized : null;
}
function resourceBudgets(registry) {
  const raw = registry.resource_budgets;
  if (!raw || typeof raw !== 'object') throw new Error('missing resource_budgets authority');
  const result = {};
  for (const key of RESOURCE_KEYS) {
    if (!Number.isInteger(raw[key]) || raw[key] < 0) throw new Error(`invalid resource budget: ${key}`);
    result[key] = raw[key];
  }
  if (result.writer < 1) throw new Error('writer budget must be positive');
  return result;
}
function sourceLaneDefinitions(capability) {
  const assignments = capability.lane_assignments ?? {};
  const split = Object.entries(assignments).filter(([name, entry]) => name !== 'consolidation' && entry && typeof entry === 'object' && arrays(entry.roots).length > 0).sort(([a], [b]) => compareText(a, b)).map(([kind, entry]) => ({
    laneId: `${capability.id}#${kind}`, kind, owner: entry.owner, worktree: entry.worktree, branch: entry.branch, roots: arrays(entry.roots),
    leafCommands: arrays(entry.tests?.leaf_commands).length ? arrays(entry.tests.leaf_commands) : arrays(capability.tests?.leaf_commands),
    buckTargets: arrays(entry.tests?.buck2_targets).length ? arrays(entry.tests.buck2_targets) : arrays(capability.tests?.buck2_targets),
    resources: entry.resources ?? capability.resource_requirements,
  }));
  if (split.length) return split;
  const evidence = typeof capability.evidence_path === 'string' ? `${normalizePattern(capability.evidence_path)}/**` : null;
  return [{ laneId: capability.id, kind: 'source', owner: capability.owner, worktree: capability.worktree, branch: capability.branch, roots: [...capabilityRoots(capability), ...(evidence ? [evidence] : [])], leafCommands: arrays(capability.tests?.leaf_commands), buckTargets: arrays(capability.tests?.buck2_targets), resources: capability.resource_requirements }];
}
function classifyRoots(rawRoots, sharedPatterns, migrationRoots) {
  const roots = validatePatternList(rawRoots, 'ownership root');
  const privateRoots = roots.filter((root) => !sharedPatterns.some((shared) => patternFullyCovers(shared, root)) && !migrationRoots.some((migration) => patternFullyCovers(migration, root)));
  const shared = sharedPatterns.filter((shared) => roots.some((root) => patternsOverlap(root, shared)));
  const migrations = migrationRoots.filter((migration) => roots.some((root) => patternsOverlap(root, migration)));
  return { roots: [...new Set(roots)].sort(compareText), privateRoots: [...new Set(privateRoots)].sort(compareText), sharedRoots: shared, migrationRoots: migrations, excludedSharedRoots: [...new Set([...shared, ...migrations])].sort(compareText) };
}
export function buckIsolationDir(anchorSha, laneId) {
  if (!FULL_SHA.test(anchorSha) || typeof laneId !== 'string' || !/^[A-Za-z0-9#._-]+$/.test(laneId)) throw new Error('invalid immutable lane identity for Buck isolation');
  const slug = laneId.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return `.buck2/console-epochs/${anchorSha.slice(0, 12)}/${slug.slice(0, 72)}`;
}
function laneScore(capability, qualityBias) { const score = finiteNumber(capability.priority?.score); const c = finiteNumber(capability.priority?.inputs?.correctness_and_risk_reduction, score); const v = finiteNumber(capability.priority?.inputs?.verification_readiness, score); return (1 - qualityBias) * score + qualityBias * ((c + v) / 2); }
function conflictBetween(left, right) { for (const a of left.private_roots) for (const b of right.private_roots) if (patternsOverlap(a, b)) return [a, b]; return null; }
function reviewReceipt(capability, anchorSha) {
  const receipt = capability.state?.independent_review_receipt;
  return receipt && typeof receipt === 'object' && receipt.status === 'approved' && receipt.anchor_sha === anchorSha && FULL_SHA.test(receipt.review_commit ?? '') ? receipt : null;
}
function validateInputs(registry, options) {
  if (!registry || registry.schema_version !== 'console-capability-registry-v1') throw new Error('unsupported console capability registry schema');
  if (!FULL_SHA.test(options.anchorSha ?? '')) throw new Error('anchor SHA must be a full lowercase 40-character Git SHA');
  if (!Number.isInteger(options.maxWriters) || options.maxWriters < 1) throw new Error('max writers must be a positive integer');
  if (!Number.isFinite(options.qualityBias) || options.qualityBias < 0 || options.qualityBias > 1) throw new Error('quality bias must be between 0 and 1');
  if (!Array.isArray(registry.capabilities)) throw new Error('registry capabilities must be an array');
}
function normalizeGeneratedFacePattern(value) {
  try { return normalizePattern(value); } catch (error) {
    // A generated-output glob such as backend/crates/**/BUCK cannot be
    // intersected precisely by the literal ownership algebra. Conservatively
    // widen only the literal prefix to a terminal subtree.
    if (typeof value === 'string' && value.match(/^[A-Za-z0-9._/-]+\/\*\*\/[A-Za-z0-9._-]+$/)) {
      return `${value.slice(0, value.indexOf('/**/'))}/**`;
    }
    throw error;
  }
}
function validateAuthority(registry, generatedFaces) {
  const paths = validatePatternList(registry.shared_collision_roots?.paths, 'shared authority root');
  const generatedPath = registry.shared_collision_roots?.generated_face_registry;
  if (typeof generatedPath !== 'string') throw new Error('missing generated-face authority path');
  normalizePattern(generatedPath);
  if (!generatedFaces || generatedFaces.schema_version !== 2 || !Array.isArray(generatedFaces.faces) || generatedFaces.faces.length === 0) throw new Error('missing or incompatible generated-face authority');
  const generated = generatedFaces.faces.flatMap((face) => arrays(face?.output_patterns).map(normalizeGeneratedFacePattern));
  if (generated.length === 0) throw new Error('generated-face authority has no output patterns');
  return { sharedPatterns: [...new Set([...paths, ...generated])].sort(compareText), migrationRoots: paths.filter((entry) => entry.includes('/migrations/**')) };
}

export function buildFanoutPlan(registry, options) {
  validateInputs(registry, options);
  const budgets = resourceBudgets(registry);
  const generatedFaces = options.generatedFaces;
  const { sharedPatterns, migrationRoots } = validateAuthority(registry, generatedFaces);
  if (!migrationRoots.includes('backend/crates/platform/db/migrations/**')) throw new Error('shared authority must declare backend/crates/platform/db/migrations/**');
  const ids = new Set();
  for (const capability of registry.capabilities) {
    if (typeof capability.id !== 'string' || capability.id === '' || ids.has(capability.id)) throw new Error(`invalid or duplicate capability id: ${capability.id}`);
    ids.add(capability.id);
    // Validate all roots before any completed-source shortcut.
    validatePatternList(capabilityRoots(capability), `capability ${capability.id}`);
    if (typeof capability.evidence_path !== 'string') throw new Error(`capability ${capability.id} missing evidence_path`);
    normalizePattern(capability.evidence_path);
  }

  const held = [], admitted = [], completed = [], completedLeafLanes = [], reviewReady = [];
  const sharedByCapability = new Map(), laneIdsByCapability = new Map(), unassignedByCapability = new Map();
  for (const capability of [...registry.capabilities].sort((a, b) => compareText(a.id, b.id))) {
    const classes = classifyRoots(capabilityRoots(capability), sharedPatterns, migrationRoots);
    sharedByCapability.set(capability.id, [...classes.sharedRoots, ...classes.migrationRoots].sort(compareText));
    const lanes = sourceLaneDefinitions(capability);
    const assigned = lanes.flatMap((lane) => validatePatternList(lane.roots, `lane ${lane.laneId}`));
    const unassigned = classes.privateRoots.filter((root) => !assigned.some((entry) => patternFullyCovers(entry, root)));
    unassignedByCapability.set(capability.id, unassigned);
    if (sourceComplete(capability)) {
      if (!reviewReceipt(capability, options.anchorSha)) held.push({ capability_id: capability.id, lane_id: `${capability.id}#completed-review`, reasons: ['completed_source_missing_exact_review_receipt'] });
      else completed.push(capability.id);
      continue;
    }
    if (unassigned.length) held.push({ capability_id: capability.id, lane_id: `${capability.id}#unowned-roots`, reasons: ['unassigned_private_ownership_roots'], unassigned_roots: unassigned });
    const incomplete = [];
    for (const lane of lanes) {
      if (laneSourceComplete(capability, lane.kind)) { completedLeafLanes.push(lane.laneId); if (!reviewReceipt(capability, options.anchorSha)) reviewReady.push({ capability_id: capability.id, lane_id: lane.laneId, reason: 'source_lane_complete_exact_independent_review_required' }); continue; }
      incomplete.push(lane);
      const roots = classifyRoots(lane.roots, sharedPatterns, migrationRoots);
      const reasons = [];
      if (!lane.owner || lane.owner === 'unassigned') reasons.push('missing_assigned_owner');
      if (typeof lane.worktree !== 'string' || !path.isAbsolute(lane.worktree)) reasons.push('missing_isolated_worktree');
      if (typeof lane.branch !== 'string' || !lane.branch.trim()) reasons.push('missing_branch');
      if (!capability.signature_story?.id || !capability.signature_story?.outcome?.trim()) reasons.push('missing_signature_story');
      if (!lane.leafCommands.length) reasons.push('missing_leaf_gates');
      if (!roots.privateRoots.length) reasons.push('missing_private_ownership_roots');
      const resources = validResources(lane.resources);
      if (!resources) reasons.push('invalid_lane_resource_requirements');
      if (lane.roots.some((root) => normalizePattern(root).startsWith('backend/')) && stateText(capability, 'backend') !== 'not_applicable' && !lane.buckTargets.length) reasons.push('missing_backend_buck_targets');
      if (reasons.length) { held.push({ capability_id: capability.id, lane_id: lane.laneId, reasons }); continue; }
      admitted.push({ capability_id: capability.id, lane_id: lane.laneId, lane_kind: lane.kind, owner: lane.owner, worktree: lane.worktree, branch: lane.branch, resources, buck_isolation_dir: buckIsolationDir(options.anchorSha, lane.laneId), signature_story_id: capability.signature_story.id, evidence_path: capability.evidence_path, private_roots: roots.privateRoots, shared_roots: sharedByCapability.get(capability.id), excluded_shared_roots: roots.excludedSharedRoots, buck2_targets: [...new Set(lane.buckTargets)].sort(compareText), leaf_commands: [...new Set(lane.leafCommands)].sort(compareText), quality_utility: round(laneScore(capability, options.qualityBias)), dependencies: [...new Set(arrays(capability.dependencies))].sort(compareText) });
    }
    laneIdsByCapability.set(capability.id, incomplete.map((lane) => lane.laneId));
  }
  const duplicateFields = ['owner', 'worktree', 'branch'];
  for (const field of duplicateFields) {
    const index = new Map(); for (const lane of admitted) { if (!index.has(lane[field])) index.set(lane[field], []); index.get(lane[field]).push(lane.lane_id); }
    for (const [value, laneIds] of index) if (laneIds.length > 1) for (const laneId of laneIds) held.push({ capability_id: laneId.split('#')[0], lane_id: laneId, reasons: [`duplicate_${field}_within_epoch`], duplicate_value: value });
  }
  const invalidLaneIds = new Set(held.filter((entry) => entry.lane_id && !entry.lane_id.endsWith('#unowned-roots') && !entry.lane_id.endsWith('#completed-review')).map((entry) => entry.lane_id));
  const candidates = admitted.filter((lane) => !invalidLaneIds.has(lane.lane_id));
  const degree = new Map(candidates.map((lane) => [lane.lane_id, 0])); const privateConflicts = [];
  for (let i = 0; i < candidates.length; i += 1) for (let j = i + 1; j < candidates.length; j += 1) { const roots = conflictBetween(candidates[i], candidates[j]); if (roots) { privateConflicts.push({ lane_ids: [candidates[i].lane_id, candidates[j].lane_id], roots }); degree.set(candidates[i].lane_id, degree.get(candidates[i].lane_id) + 1); degree.set(candidates[j].lane_id, degree.get(candidates[j].lane_id) + 1); } }
  const ranked = candidates.map((lane) => ({ ...lane, selection_density: round(lane.quality_utility / (1 + degree.get(lane.lane_id))) })).sort((a, b) => b.selection_density - a.selection_density || b.quality_utility - a.quality_utility || compareText(a.lane_id, b.lane_id));
  const selected = [], collisionBlocked = [], allocated = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, 0]));
  for (const lane of ranked) {
    const resourceExceeded = RESOURCE_KEYS.filter((key) => allocated[key] + lane.resources[key] > budgets[key]);
    if (selected.length >= Math.min(options.maxWriters, budgets.writer)) { collisionBlocked.push({ capability_id: lane.capability_id, lane_id: lane.lane_id, reason: 'writer_budget_exhausted' }); continue; }
    const conflict = selected.find((chosen) => conflictBetween(lane, chosen)); if (conflict) { collisionBlocked.push({ capability_id: lane.capability_id, lane_id: lane.lane_id, reason: 'private_root_conflict', conflicts_with: conflict.lane_id }); continue; }
    if (resourceExceeded.length) { collisionBlocked.push({ capability_id: lane.capability_id, lane_id: lane.lane_id, reason: 'resource_budget_exhausted', resources: resourceExceeded }); continue; }
    selected.push(lane); for (const key of RESOURCE_KEYS) allocated[key] += lane.resources[key];
  }
  const byId = new Map(registry.capabilities.map((capability) => [capability.id, capability]));
  const selectedCapabilities = [...new Set(selected.map((lane) => lane.capability_id))].sort(compareText);
  const mergeDependencyHolds = selectedCapabilities.map((id) => ({ capability_id: id, unresolved_dependencies: selected.find((lane) => lane.capability_id === id).dependencies.filter((dependency) => !byId.has(dependency) || !sourceComplete(byId.get(dependency))) })).filter((entry) => entry.unresolved_dependencies.length).sort((a,b) => compareText(a.capability_id,b.capability_id));
  const consolidationQueue = selectedCapabilities.map((id) => {
    const capability = byId.get(id); const consolidation = capability.lane_assignments?.consolidation; const selectedIds = new Set(selected.filter((lane) => lane.capability_id === id).map((lane) => lane.lane_id)); const awaiting = (laneIdsByCapability.get(id) ?? []).filter((laneId) => !selectedIds.has(laneId)).sort(compareText); const receipt = reviewReceipt(capability, options.anchorSha); const consolidationResources = validResources(consolidation?.resources ?? capability.consolidation_resources);
    const prerequisites = [];
    if (!receipt) prerequisites.push('exact_leaf_review_receipt_required');
    if (!consolidation?.owner || consolidation.owner !== registry.shared_collision_roots.owner) prerequisites.push('invalid_consolidation_owner');
    if (typeof consolidation?.worktree !== 'string' || !path.isAbsolute(consolidation.worktree)) prerequisites.push('invalid_consolidation_worktree');
    if (typeof consolidation?.branch !== 'string' || !consolidation.branch.trim()) prerequisites.push('invalid_consolidation_branch');
    if (!consolidationResources) prerequisites.push('invalid_consolidation_resource_requirements');
    return { capability_id: id, shared_roots: sharedByCapability.get(id) ?? [], ready_after_leaf_review: prerequisites.length === 0 && awaiting.length === 0 && !(unassignedByCapability.get(id) ?? []).length, review_prerequisites: prerequisites, awaiting_lane_ids: awaiting, awaiting_unassigned_roots: unassignedByCapability.get(id) ?? [] };
  }).filter((entry) => entry.shared_roots.length).sort((a,b) => compareText(a.capability_id,b.capability_id));
  const reviewQueue = [...selected.map((lane) => ({ capability_id: lane.capability_id, lane_id: lane.lane_id, reason: 'leaf_result_requires_exact_independent_review_receipt' })), ...reviewReady].sort((a,b) => compareText(a.capability_id,b.capability_id) || compareText(a.reason,b.reason));
  return { schema_version: 'console-fanout-epoch-v2', anchor_sha: options.anchorSha, authority: { registry_schema: registry.schema_version, registry_digest_sha256: registryDigest(registry), registry_source_revision: registry.source_revision ?? null, generated_face_registry_schema: generatedFaces.schema_version, generated_face_registry_digest_sha256: digest(generatedFaces) }, policy: { max_writer_lanes: Math.min(options.maxWriters, budgets.writer), resource_budgets: budgets, allocated_resources: allocated, buck_isolation_policy: 'stable_epoch_lane_isolation_shared_remote_cache', quality_bias: options.qualityBias, shared_owner: registry.shared_collision_roots?.owner ?? null, dependency_behavior: 'source_parallel_merge_fail_closed', generated_face_behavior: 'single_writer_after_exact_review', selection_algorithm: 'deterministic_quality_weighted_maximal_independent_set' }, selected, held, collision_blocked: collisionBlocked, completed_source_capabilities: completed, completed_leaf_lanes: completedLeafLanes.sort(compareText), private_conflicts: privateConflicts, merge_dependency_holds: mergeDependencyHolds, review_queue: reviewQueue, consolidation_queue: consolidationQueue };
}

function usage() { return ['usage: node scripts/console/plan-fanout.mjs --anchor <40-char-sha> [options]', '', 'options:', '  --registry <path>       capability registry (default: docs/program/console-capability-registry.json)', '  --max-writers <count>   bounded source writers (default: 6)', `  --quality-bias <0..1>   quality weighting (default: ${QUALITY_BIAS_DEFAULT})`].join('\n'); }
function parseArgs(argv) { const result = { registryPath: 'docs/program/console-capability-registry.json', anchorSha: null, maxWriters: 6, qualityBias: QUALITY_BIAS_DEFAULT }; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === '--help' || arg === '-h') { process.stdout.write(`${usage()}\n`); process.exit(0); } const value = argv[i + 1]; if (value === undefined) throw new Error(`missing value for ${arg}`); if (arg === '--registry') result.registryPath = value; else if (arg === '--anchor') result.anchorSha = value; else if (arg === '--max-writers') result.maxWriters = Number(value); else if (arg === '--quality-bias') result.qualityBias = Number(value); else throw new Error(`unknown argument: ${arg}`); i += 1; } return result; }
function git(repoRoot, args) { return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim(); }
function readAnchorJson(repoRoot, anchor, relativePath) { return JSON.parse(git(repoRoot, ['show', `${anchor}:${relativePath}`])); }
function sourceRevisionMatches(value, anchor) { return typeof value === 'string' && value.endsWith(`@${anchor}`); }
function worktreeEntries(repoRoot) { const output = git(repoRoot, ['worktree', 'list', '--porcelain']); const entries = []; let current = {}; for (const line of output.split('\n')) { if (!line) { if (current.worktree) entries.push(current); current = {}; } else { const [key, ...rest] = line.split(' '); current[key] = rest.join(' '); } } if (current.worktree) entries.push(current); return entries; }
function assertAnchorAuthority(repoRoot, anchor, registryPath, registry, generatedPath, generated) { if (git(repoRoot, ['rev-parse', '--verify', anchor]) !== anchor) throw new Error('anchor is not a resolvable immutable commit'); if (git(repoRoot, ['status', '--porcelain']) !== '') throw new Error('planner requires a clean worktree'); if (!sourceRevisionMatches(registry.source_revision, anchor)) throw new Error('registry source_revision does not match anchor'); const anchoredRegistry = readAnchorJson(repoRoot, anchor, registryPath); if (registryDigest(anchoredRegistry) !== registryDigest(registry)) throw new Error('registry differs from anchor blob'); const anchoredGenerated = readAnchorJson(repoRoot, anchor, generatedPath); if (digest(anchoredGenerated) !== digest(generated)) throw new Error('generated-face authority differs from anchor blob'); try { git(repoRoot, ['cat-file', '-e', `${anchor}:backend/crates/platform/db/migrations`]); } catch { throw new Error('migration authority root missing at anchor'); } }
function validateDeclaredWorktrees(repoRoot, plan, anchor) { const entries = worktreeEntries(repoRoot); const byPath = new Map(entries.map((entry) => [entry.worktree, entry])); const owners = new Set(), worktrees = new Set(), branches = new Set(); for (const lane of plan.selected) { const entry = byPath.get(lane.worktree); if (!entry || entry.branch !== `refs/heads/${lane.branch}`) throw new Error(`declared worktree/branch is not live: ${lane.lane_id}`); if (git(lane.worktree, ['status', '--porcelain']) !== '') throw new Error(`declared worktree is dirty: ${lane.lane_id}`); const head = git(lane.worktree, ['rev-parse', 'HEAD']); if (head !== anchor && git(repoRoot, ['merge-base', '--is-ancestor', anchor, head]) !== '') throw new Error(`declared worktree is not anchored or immutable descendant: ${lane.lane_id}`); for (const [label, values, value] of [['owner', owners, lane.owner], ['worktree', worktrees, lane.worktree], ['branch', branches, lane.branch]]) { if (values.has(value)) throw new Error(`selected epoch duplicates ${label}: ${value}`); values.add(value); } } }
function main() { const args = parseArgs(process.argv.slice(2)); const repoRoot = process.cwd(); const registry = readAnchorJson(repoRoot, args.anchorSha, args.registryPath); const generatedPath = registry.shared_collision_roots?.generated_face_registry; if (typeof generatedPath !== 'string') throw new Error('missing generated-face authority path'); const generated = readAnchorJson(repoRoot, args.anchorSha, generatedPath); assertAnchorAuthority(repoRoot, args.anchorSha, args.registryPath, registry, generatedPath, generated); const plan = buildFanoutPlan(registry, { anchorSha: args.anchorSha, maxWriters: args.maxWriters, qualityBias: args.qualityBias, generatedFaces: generated }); validateDeclaredWorktrees(repoRoot, plan, args.anchorSha); process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); }
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) { try { main(); } catch (error) { process.stderr.write(`console-fanout-plan: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
