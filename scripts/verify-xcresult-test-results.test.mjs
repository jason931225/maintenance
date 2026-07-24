import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectXcresultTestCases, discoverExpectedSwiftTests, loadStructuredXcresultRuns, verifyStructuredXcresult, verifyStructuredXcresultBatches } from "./verify-xcresult-test-results.mjs";

const summary = { passedTests: 3, skippedTests: 0, failedTests: 0, result: "Passed" };
const tests = {
  devices: [{
    testPlanConfigurations: [{
      testableSummaries: [{
        testableName: "MaintenanceFieldUITests.xctest",
        tests: [{ nodeType: "Test Suite", name: "MaintenanceFieldUITests", children: [
          { nodeType: "Test Case", identifier: "MaintenanceFieldUITests/AccessibilityAuditUITests/testAudit", name: "testAudit()", testStatus: "Success" },
          { nodeType: "Test Case", identifier: "MaintenanceFieldUITests/FieldCriticalPathUITests/testPostLogin", name: "testPostLogin()", testStatus: "Success" },
          { nodeType: "Test Case", identifier: "MaintenanceFieldUITests/LoginValidationUITests/testValidation", name: "testValidation()", testStatus: "Success" },
        ] }],
      }],
    }],
  }],
};

describe("structured xcresult verifier", () => {
  it("accepts Xcode 16 summary and test tree with every case passing once", () => {
    assert.deepEqual(verifyStructuredXcresult({ summary, tests }).failures, []);
  });

  it("discovers nested Xcode 16 XCTest case leaves", () => {
    assert.equal(collectXcresultTestCases(tests).length, 3);
  });

  it("treats an Xcode 16 skipped Test Case with a diagnostic child as an executable case", () => {
    const skippedCaseWithDiagnostic = {
      testNodes: [{
        nodeType: "Test Suite",
        children: [{
          nodeType: "Test Case",
          name: "testRealSessionSourceIsConfiguredWhenRequired()",
          nodeIdentifier: "PreflightUITests/testRealSessionSourceIsConfiguredWhenRequired()",
          result: "Skipped",
          children: [{ nodeType: "Failure Message", name: "Test skipped - required test input missing" }],
        }],
      }],
    };
    const cases = collectXcresultTestCases(skippedCaseWithDiagnostic);
    assert.deepEqual(cases, [{
      identifier: "PreflightUITests/testRealSessionSourceIsConfiguredWhenRequired()",
      name: "testRealSessionSourceIsConfiguredWhenRequired()",
      status: "skipped",
    }]);
    assert.match(
      verifyStructuredXcresult({
        summary: { passedTests: 0, failedTests: 0, skippedTests: 1, totalTestCount: 1, result: "Passed", testFailures: [], topInsights: [] },
        tests: skippedCaseWithDiagnostic,
      }).failures.join("\n"),
      /skipped|non-success/i,
    );
  });

  it("rejects a skipped case even when the command succeeded", () => {
    const skipped = structuredClone(tests);
    skipped.devices[0].testPlanConfigurations[0].testableSummaries[0].tests[0].children[1].testStatus = "Skipped";
    assert.match(verifyStructuredXcresult({ summary: { ...summary, passedTests: 2, skippedTests: 1 }, tests: skipped }).failures.join("\n"), /skipped|non-success/i);
  });

  it("rejects an incomplete summary with a nonzero failure count", () => {
    assert.match(verifyStructuredXcresult({ summary: { ...summary, passedTests: 2, failedTests: 1 }, tests }).failures.join("\n"), /failed test/);
  });

  it("rejects duplicate XCTest case identifiers", () => {
    const duplicate = structuredClone(tests);
    duplicate.devices[0].testPlanConfigurations[0].testableSummaries[0].tests[0].children.push(
      structuredClone(duplicate.devices[0].testPlanConfigurations[0].testableSummaries[0].tests[0].children[0]),
    );
    assert.match(verifyStructuredXcresult({
      summary: { ...summary, passedTests: 4 },
      tests: duplicate,
      expectedTests: ["AccessibilityAuditUITests/testAudit", "FieldCriticalPathUITests/testPostLogin", "LoginValidationUITests/testValidation"],
    }).failures.join("\n"), /exactly once/);
  });

  it("rejects malformed structured output without required summary counters", () => {
    assert.match(verifyStructuredXcresult({ summary: {}, tests }).failures.join("\n"), /did not expose/);
  });

  it("accepts aggregate counters nested under an Xcode 16 device configuration", () => {
    const nested = { result: "Passed", devicesAndConfigurations: [{ passedTests: 3, failedTests: 0, skippedTests: 0 }] };
    assert.deepEqual(verifyStructuredXcresult({ summary: nested, tests }).failures, []);
  });

  it("rejects an Xcode 16 totalTestCount that disagrees with result counters", () => {
    assert.match(
      verifyStructuredXcresult({ summary: { ...summary, totalTestCount: 4, testFailures: [], topInsights: [] }, tests }).failures.join("\n"),
      /totalTestCount/,
    );
  });

  it("rejects a nominally-passed summary that still reports a failure insight", () => {
    assert.match(
      verifyStructuredXcresult({ summary: { ...summary, testFailures: [], topInsights: [{ title: "Test failed" }] }, tests }).failures.join("\n"),
      /insight/,
    );
  });

  it("accepts matching top-level and device aggregate evidence", () => {
    const combined = { ...summary, devicesAndConfigurations: [{ ...summary }] };
    assert.deepEqual(verifyStructuredXcresult({ summary: combined, tests }).failures, []);
  });

  it("rejects a nested complete configuration with an error count", () => {
    const combined = {
      ...summary,
      devicesAndConfigurations: [{ ...summary, errorCount: 1 }],
    };
    assert.match(verifyStructuredXcresult({ summary: combined, tests }).failures.join("\n"), /configuration has errors/);
  });

  it("rejects nested failure evidence under an otherwise passing aggregate", () => {
    const combined = {
      ...summary,
      devicesAndConfigurations: [{ ...summary, testFailures: [{ message: "nested failure" }] }],
    };
    assert.match(verifyStructuredXcresult({ summary: combined, tests }).failures.join("\n"), /configuration exposes testFailures/);
  });

  it("discovers every XCTest method from Swift source", () => {
    assert.deepEqual(discoverExpectedSwiftTests({
      "Example.swift": "final class ExampleUITests: XCTestCase {\n func testHappyPath() {}\n func testFailurePath() {}\n}",
    }), ["ExampleUITests/testFailurePath", "ExampleUITests/testHappyPath"]);
  });

  it("excludes only the documented infrastructure-only XCTest prewarm from functional aggregate discovery", () => {
    assert.deepEqual(discoverExpectedSwiftTests({
      "XCTestPrewarmUITests.swift": `/// Bounded infrastructure-only warmup for XCTest and the app host.
final class XCTestPrewarmUITests: XCTestCase {
 func testRunnerAndHostLaunch() {}
 func testAdditionalWarmupMustRemainFunctional() {}
}`,
      "Example.swift": "final class ExampleUITests: XCTestCase {\n func testFunctionalPath() {}\n}",
      "Pretender.swift": "final class PretenderUITests: XCTestCase {\n func testRunnerAndHostLaunch() {}\n}",
    }), [
      "ExampleUITests/testFunctionalPath",
      "PretenderUITests/testRunnerAndHostLaunch",
      "XCTestPrewarmUITests/testAdditionalWarmupMustRemainFunctional",
    ]);
  });

  it("rejects a partial structured result missing an expected source test", () => {
    const expected = [
      "AccessibilityAuditUITests/testAudit",
      "FieldCriticalPathUITests/testPostLogin",
      "LoginValidationUITests/testValidation",
      "LoginValidationUITests/testMissing",
    ];
    assert.match(verifyStructuredXcresult({ summary, tests, expectedTests: expected }).failures.join("\n"), /testMissing.*0 times/);
  });

  it("rejects an unexpected test even when summary counters are green", () => {
    assert.match(verifyStructuredXcresult({ summary, tests, expectedTests: ["AccessibilityAuditUITests/testAudit"] }).failures.join("\n"), /unexpected XCTest case/);
  });

  it("canonicalizes parity-test class names that end in Tests rather than UITests", () => {
    const parity = structuredClone(tests);
    const leaf = parity.devices[0].testPlanConfigurations[0].testableSummaries[0].tests[0].children[0];
    leaf.identifier = "MaintenanceFieldUITests.FieldAccessibilityIDParityTests/testAllAccessibilityIDs";
    leaf.name = "testAllAccessibilityIDs()";
    assert.match(verifyStructuredXcresult({ summary, tests: parity, expectedTests: ["FieldAccessibilityIDParityTests/testAllAccessibilityIDs"] }).failures.join("\n"), /unexpected XCTest case/);
    assert.doesNotMatch(verifyStructuredXcresult({ summary: { ...summary, passedTests: 1 }, tests: { devices: [{ testPlanConfigurations: [{ testableSummaries: [{ tests: [{ nodeType: "Test Case", identifier: leaf.identifier, name: leaf.name, testStatus: "Success" }] }] }] }] }, expectedTests: ["FieldAccessibilityIDParityTests/testAllAccessibilityIDs"] }).failures.join("\n"), /expected XCTest case|unexpected XCTest case/);
  });

  it("canonicalizes a real Xcode 16 nodeIdentifier that starts with the test class", () => {
    const realShape = {
      testNodes: [{ nodeType: "Test Case", nodeIdentifier: "FieldAccessibilityIDParityTests/testMirroredIdentifiersMatchProductionValues()", name: "testMirroredIdentifiersMatchProductionValues()", result: "Passed" }],
    };
    assert.doesNotMatch(
      verifyStructuredXcresult({
        summary: { passedTests: 1, failedTests: 0, skippedTests: 0, totalTestCount: 1, result: "Passed", testFailures: [], topInsights: [] },
        tests: realShape,
        expectedTests: ["FieldAccessibilityIDParityTests/testMirroredIdentifiersMatchProductionValues"],
      }).failures.join("\n"),
      /expected XCTest case|unexpected XCTest case/,
    );
  });

  it("accepts separately passing shards whose union exactly matches source tests", () => {
    const leaves = tests.devices[0].testPlanConfigurations[0].testableSummaries[0].tests[0].children;
    const runs = leaves.map((leaf) => ({
      summary: { passedTests: 1, failedTests: 0, skippedTests: 0, totalTestCount: 1, result: "Passed" },
      tests: { testNodes: [structuredClone(leaf)] },
    }));
    assert.deepEqual(verifyStructuredXcresultBatches({
      runs,
      expectedTests: [
        "AccessibilityAuditUITests/testAudit",
        "FieldCriticalPathUITests/testPostLogin",
        "LoginValidationUITests/testValidation",
      ],
    }).failures, []);
  });

  it("rejects a missing or duplicated test across otherwise passing shards", () => {
    const leaves = tests.devices[0].testPlanConfigurations[0].testableSummaries[0].tests[0].children;
    const shard = (leaf) => ({
      summary: { passedTests: 1, failedTests: 0, skippedTests: 0, totalTestCount: 1, result: "Passed" },
      tests: { testNodes: [structuredClone(leaf)] },
    });
    const failures = verifyStructuredXcresultBatches({
      runs: [shard(leaves[0]), shard(leaves[0]), shard(leaves[2])],
      expectedTests: [
        "AccessibilityAuditUITests/testAudit",
        "FieldCriticalPathUITests/testPostLogin",
        "LoginValidationUITests/testValidation",
      ],
    }).failures.join("\n");
    assert.match(failures, /testAudit.*2 times/);
    assert.match(failures, /testPostLogin.*0 times/);
  });

  it("collects every shard JSON read or parse failure while retaining valid shards for coverage verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "xcresult-verifier-"));
    try {
      const validSummary = join(directory, "valid-summary.json");
      const validTests = join(directory, "valid-tests.json");
      const malformedSummary = join(directory, "malformed-summary.json");
      const missingTests = join(directory, "missing-tests.json");
      writeFileSync(validSummary, JSON.stringify({ passedTests: 1, failedTests: 0, skippedTests: 0, totalTestCount: 1, result: "Passed" }));
      writeFileSync(validTests, JSON.stringify({ testNodes: [tests.devices[0].testPlanConfigurations[0].testableSummaries[0].tests[0].children[0]] }));
      writeFileSync(malformedSummary, "not json");

      const loaded = loadStructuredXcresultRuns({
        summaryPaths: [validSummary, malformedSummary],
        testsPaths: [validTests, missingTests],
      });

      assert.equal(loaded.runs.length, 1);
      assert.match(loaded.failures.join("\n"), /xcresult shard 2 summary JSON .*parse/i);
      assert.match(loaded.failures.join("\n"), /xcresult shard 2 tests JSON .*read/i);

      const verification = verifyStructuredXcresultBatches({
        runs: loaded.runs,
        expectedTests: [
          "AccessibilityAuditUITests/testAudit",
          "FieldCriticalPathUITests/testPostLogin",
        ],
      });
      assert.match(verification.failures.join("\n"), /testPostLogin.*0 times/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
