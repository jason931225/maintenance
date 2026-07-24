#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nodeStatus(node) {
  return String(node?.testStatus ?? node?.status ?? node?.result ?? "").toLowerCase();
}

function nodeIdentifier(node, ancestry) {
  return String(node?.nodeIdentifier ?? node?.identifier ?? node?.testIdentifier ?? node?.id ?? ancestry.join("/"));
}

function nodeName(node) {
  return String(node?.name ?? node?.testName ?? node?.identifier ?? "unnamed test");
}

function childNodes(node) {
  return [
    ...asArray(node?.children),
    ...asArray(node?.subtests),
    ...asArray(node?.tests),
    ...asArray(node?.testNodes),
  ].filter(isObject);
}

function structuralNodes(node) {
  return [
    ...asArray(node?.devices),
    ...asArray(node?.testPlanConfigurations),
    ...asArray(node?.testableSummaries),
    ...asArray(node?.testables),
    ...asArray(node?.testResults),
  ].filter(isObject);
}

/**
 * Extract executable test leaves from both Xcode 16 `test-results tests` tree
 * responses and the testable-summary shape returned by older Xcode 16 builds.
 */
export function collectXcresultTestCases(tests) {
  const leaves = [];
  const seenObjects = new Set();

  function visit(node, ancestry = []) {
    if (!isObject(node) || seenObjects.has(node)) return;
    seenObjects.add(node);
    const children = childNodes(node);
    const structuralChildren = structuralNodes(node);
    const name = nodeName(node);
    const nextAncestry = [...ancestry, name];
    const type = String(node.nodeType ?? node.type ?? "").toLowerCase();
    const identifier = nodeIdentifier(node, nextAncestry);
    const looksLikeCase = /test case|testcase/.test(type)
      || /\/test[A-Za-z0-9_]+(?:\(|$)/.test(identifier)
      || (/^test[A-Z_]/.test(name) && children.length === 0);

    // Xcode 16 attaches a diagnostic child (for example Failure Message) to a
    // failed/skipped Test Case.  The Test Case is still the executable leaf;
    // do not descend into diagnostics or lose its non-success status.
    if (looksLikeCase) {
      leaves.push({ identifier, name, status: nodeStatus(node) });
      return;
    }
    for (const child of [...children, ...structuralChildren]) visit(child, nextAncestry);
  }

  if (isObject(tests)) visit(tests);
  return leaves;
}

function numericSummary(summary, names) {
  for (const name of names) {
    const value = summary?.[name];
    if (typeof value === "number") return value;
  }
  return null;
}

function summaryEvidence(summary) {
  const candidates = [];
  const seen = new Set();
  function visit(value) {
    if (!isObject(value) || seen.has(value)) return;
    seen.add(value);
    const passed = numericSummary(value, ["passedTests", "passedTestsCount", "passedCount"]);
    const failed = numericSummary(value, ["failedTests", "failedTestsCount", "failedCount"]);
    const skipped = numericSummary(value, ["skippedTests", "skippedTestsCount", "skippedCount"]);
    if (passed !== null || failed !== null || skipped !== null) {
      candidates.push({
        passed,
        failed,
        skipped,
        total: numericSummary(value, ["totalTestCount", "totalTests", "testsCount"]),
        result: String(value.result ?? ""),
        errors: numericSummary(value, ["errorCount", "errorsCount", "errors"]),
        testFailures: asArray(value.testFailures),
        topInsights: asArray(value.topInsights),
      });
    }
    for (const key of ["devicesAndConfigurations", "devices", "testPlanConfigurations", "testPlanSummaries", "testableSummaries", "summaries"]) {
      for (const child of asArray(value[key])) visit(child);
    }
  }
  visit(summary);
  return candidates;
}

// This test warms only XCTest and the app host before functional shards. Its
// raw result is deliberately not uploaded or aggregated as product evidence;
// worker failure is enforced separately by the workflow. Keep this exact and
// closed: no class-level or prefix rule may hide future functional coverage.
const infrastructureOnlyFunctionalAggregateExclusions = Object.freeze([
  "XCTestPrewarmUITests/testRunnerAndHostLaunch",
]);

export function discoverExpectedSwiftTests(sourceByPath) {
  const expected = new Set();
  for (const source of Object.values(sourceByPath)) {
    let className = null;
    for (const line of String(source).split(/\r?\n/)) {
      const classMatch = line.match(/\b(?:final\s+)?class\s+(\w*(?:UITests|Tests))\s*:/);
      if (classMatch) className = classMatch[1];
      const testMatch = line.match(/\bfunc\s+(test\w+)\s*\(/);
      if (className && testMatch) {
        const testID = `${className}/${testMatch[1]}`;
        if (!infrastructureOnlyFunctionalAggregateExclusions.includes(testID)) expected.add(testID);
      }
    }
  }
  return [...expected].sort();
}

function canonicalObservedCase(testCase) {
  const method = (testCase.name.match(/(test\w+)/)?.[1] ?? testCase.identifier.match(/[/.](test\w+)/)?.[1] ?? "");
  const className = testCase.identifier.match(/(?:^|[/.])(\w*(?:UITests|Tests))[/.]test\w+/)?.[1]
    ?? testCase.name.match(/(?:^|[/.])(\w*(?:UITests|Tests))[/.]test\w+/)?.[1]
    ?? "";
  return className && method ? `${className}/${method}` : testCase.identifier;
}

/**
 * Fail closed unless structured xcresult evidence proves every discovered
 * XCTest case ran exactly once and no skip/failure/error survived.
 */
export function verifyStructuredXcresult({ summary, tests, expectedTests }) {
  const failures = [];
  const cases = collectXcresultTestCases(tests);
  const evidence = summaryEvidence(summary);
  const complete = evidence.filter((candidate) => candidate.passed !== null && candidate.failed !== null && candidate.skipped !== null);
  const aggregate = complete.find((candidate) => candidate.result === String(summary?.result ?? "")) ?? complete[0] ?? null;
  const total = aggregate && aggregate.passed !== null && aggregate.failed !== null && aggregate.skipped !== null
    ? aggregate.passed + aggregate.failed + aggregate.skipped : null;
  const skipped = aggregate?.skipped ?? null;
  const failed = aggregate?.failed ?? null;
  const errors = aggregate?.errors ?? null;

  if (cases.length === 0) failures.push("xcresult tests JSON did not expose any executable XCTest case");
  if (!aggregate) failures.push("xcresult summary JSON did not expose one internally consistent aggregate result");
  if (total === null) failures.push("xcresult summary JSON did not expose passed, failed, and skipped test counts");
  if (aggregate?.total !== null && aggregate?.total !== undefined && total !== null && aggregate.total !== total) {
    failures.push(`xcresult summary reports totalTestCount ${aggregate.total} but counters sum to ${total}`);
  }
  if (skipped === null) failures.push("xcresult summary JSON did not expose a skipped test count");
  if (failed === null) failures.push("xcresult summary JSON did not expose a failed test count");
  const topLevelResult = String(summary?.result ?? "");
  if (!/^passed$/i.test(topLevelResult)) failures.push(`xcresult summary top-level result is ${JSON.stringify(topLevelResult || "missing")}, not Passed`);

  if (total !== null && total !== cases.length) {
    failures.push(`xcresult summary reports ${total} tests but tests JSON discovered ${cases.length} executable XCTest case(s)`);
  }
  if (skipped !== null && skipped !== 0) failures.push(`xcresult summary reports ${skipped} skipped test(s)`);
  if (failed !== null && failed !== 0) failures.push(`xcresult summary reports ${failed} failed test(s)`);
  if (errors !== null && errors !== 0) failures.push(`xcresult summary reports ${errors} error(s)`);
  if (asArray(summary?.testFailures).length !== 0) failures.push("xcresult summary exposes testFailures despite a passing result");
  if (asArray(summary?.topInsights).some((insight) => /error|fail|skip/i.test(JSON.stringify(insight)))) {
    failures.push("xcresult summary exposes failure, error, or skip insight despite a passing result");
  }
  for (const candidate of complete) {
    if (!/^passed$/i.test(candidate.result || topLevelResult)) failures.push(`xcresult configuration result is ${JSON.stringify(candidate.result || "missing")}, not Passed`);
    if (candidate.failed !== 0 || candidate.skipped !== 0) failures.push("xcresult configuration has failed or skipped tests");
    if (candidate.errors !== null && candidate.errors !== 0) failures.push("xcresult configuration has errors");
    if (candidate.testFailures.length !== 0) failures.push("xcresult configuration exposes testFailures despite a passing result");
    if (candidate.topInsights.some((insight) => /error|fail|skip/i.test(JSON.stringify(insight)))) {
      failures.push("xcresult configuration exposes failure, error, or skip insight despite a passing result");
    }
  }

  const counts = new Map();
  for (const testCase of cases) {
    counts.set(testCase.identifier, (counts.get(testCase.identifier) ?? 0) + 1);
    if (!/^(success|passed|pass)$/.test(testCase.status)) {
      failures.push(`XCTest case ${testCase.identifier} has non-success status ${JSON.stringify(testCase.status || "missing")}`);
    }
  }
  for (const [identifier, count] of counts) {
    if (count !== 1) failures.push(`XCTest case ${identifier} was discovered ${count} times; expected exactly once`);
  }

  const expected = expectedTests === undefined ? null : new Set(expectedTests);
  const observed = new Map();
  for (const testCase of cases) {
    const canonical = canonicalObservedCase(testCase);
    observed.set(canonical, (observed.get(canonical) ?? 0) + 1);
  }
  if (expected) {
    for (const expectedCase of expected) {
      const count = observed.get(expectedCase) ?? 0;
      if (count !== 1) failures.push(`expected XCTest case ${expectedCase} was observed ${count} times; expected exactly once`);
    }
    for (const [observedCase, count] of observed) {
      if (!expected.has(observedCase)) failures.push(`unexpected XCTest case ${observedCase} was observed ${count} times`);
    }
  }

  return { failures, cases, expectedTests: expected ? [...expected] : [] };
}

/**
 * Verify separately executed XCTest shards, then prove the union is exactly the
 * source-discovered suite. Each shard keeps its own internally consistent
 * xcresult summary; cross-shard duplicate or missing tests still fail closed.
 */
export function verifyStructuredXcresultBatches({ runs, expectedTests }) {
  const failures = [];
  const cases = [];
  runs.forEach((run, index) => {
    const result = verifyStructuredXcresult({ summary: run.summary, tests: run.tests });
    failures.push(...result.failures.map((failure) => `xcresult shard ${index + 1}: ${failure}`));
    cases.push(...result.cases);
  });

  const expected = new Set(expectedTests ?? []);
  const observed = new Map();
  for (const testCase of cases) {
    const canonical = canonicalObservedCase(testCase);
    observed.set(canonical, (observed.get(canonical) ?? 0) + 1);
  }
  for (const expectedCase of expected) {
    const count = observed.get(expectedCase) ?? 0;
    if (count !== 1) failures.push(`expected XCTest case ${expectedCase} was observed ${count} times across shards; expected exactly once`);
  }
  for (const [observedCase, count] of observed) {
    if (!expected.has(observedCase)) failures.push(`unexpected XCTest case ${observedCase} was observed ${count} times across shards`);
    else if (count !== 1) failures.push(`XCTest case ${observedCase} was observed ${count} times across shards; expected exactly once`);
  }

  return { failures, cases, expectedTests: [...expected] };
}

/**
 * Read every requested shard independently.  A broken extraction must never
 * hide diagnostics from a later shard, and valid shards still contribute to
 * the cross-shard source-coverage proof.
 */
export function loadStructuredXcresultRuns({ summaryPaths, testsPaths }) {
  const failures = [];
  const runs = [];
  for (let index = 0; index < summaryPaths.length; index += 1) {
    const shard = index + 1;
    let summary;
    let tests;
    let readable = true;
    for (const [kind, path] of [["summary", summaryPaths[index]], ["tests", testsPaths[index]]]) {
      try {
        const parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
        if (kind === "summary") summary = parsed;
        else tests = parsed;
      } catch (error) {
        readable = false;
        const operation = error instanceof SyntaxError ? "parse" : "read";
        failures.push(`xcresult shard ${shard} ${kind} JSON ${operation} failed (${path}): ${error.message}`);
      }
    }
    if (readable) runs.push({ summary, tests });
  }
  return { failures, runs };
}

function readSwiftSources(directory) {
  const sources = {};
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) Object.assign(sources, readSwiftSources(path));
    else if (entry.endsWith(".swift")) sources[path] = readFileSync(path, "utf8");
  }
  return sources;
}

function main(argv) {
  const optionValues = (name) => argv.flatMap((value, index) => value === name && argv[index + 1] ? [argv[index + 1]] : []);
  const summaryPaths = optionValues("--summary");
  const testsPaths = optionValues("--tests");
  const sourceIndex = argv.indexOf("--swift-tests");
  if (summaryPaths.length === 0 || summaryPaths.length !== testsPaths.length || sourceIndex === -1 || !argv[sourceIndex + 1]) {
    console.error("usage: verify-xcresult-test-results.mjs [--summary <summary.json> --tests <tests.json>]... --swift-tests <ios/UITests>");
    return 2;
  }
  const loaded = loadStructuredXcresultRuns({ summaryPaths, testsPaths });
  let expectedTests;
  try {
    expectedTests = discoverExpectedSwiftTests(readSwiftSources(resolve(argv[sourceIndex + 1])));
  } catch (error) {
    console.error(`unable to read Swift UI test sources: ${error.message}`);
    return 2;
  }
  const verification = loaded.runs.length === 1
    ? verifyStructuredXcresult({ ...loaded.runs[0], expectedTests })
    : verifyStructuredXcresultBatches({ runs: loaded.runs, expectedTests });
  const failures = [...loaded.failures, ...verification.failures];
  const { cases } = verification;
  if (failures.length > 0) {
    console.error("structured xcresult verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log(`structured xcresult verification passed (${cases.length} XCTest case(s), zero skipped/failures/errors).`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
