import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorTag = "1.12.2";
const root = fileURLToPath(new URL("..", import.meta.url));
const cloneDir = resolve(
  root,
  `.cache/swift-openapi-generator-${generatorTag}`,
);
const generatorBin = resolve(
  cloneDir,
  ".build/release/swift-openapi-generator",
);
const outputDir = resolve(
  root,
  "clients/swift/Sources/MaintenanceAPIClient/Generated",
);
const config = resolve(root, "clients/swift/openapi-generator-config.yaml");
const inputSpec = resolve(root, "backend/openapi/openapi.yaml");
const stagingRoot = resolve(root, ".cache/generated-clients");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}`,
    );
  }
}

function patchKnownGeneratorGaps(stagingDir) {
  // swift-openapi-generator 1.12 skips the `null` branch for a required
  // oneOf[$ref, null] property and emits an empty struct. The OpenAPI contract
  // intentionally models SeriesByInstanceResponse.series as a present key whose
  // value may be null, so patch this generated shape until the generator supports
  // that schema form natively.
  const typesFile = resolve(stagingDir, "Types.swift");
  let text = readFileSync(typesFile, "utf8");

  // Swift's synthesized Codable treats an Optional property as both nullable
  // and omittable. OpenAPI distinguishes those states: a required-nullable
  // property must be present on the wire even when its value is null. Keep one
  // generated support wrapper at schema scope so every patched model gets
  // missing-key rejection and explicit-null encoding.
  const schemasAnchor = `    public enum Schemas {
`;
  const requiredNullableSupport = `    public enum Schemas {
        @propertyWrapper
        public struct RequiredNullable<Value: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
            public var wrappedValue: Value?
            public init(wrappedValue: Value?) {
                self.wrappedValue = wrappedValue
            }
            public init(from decoder: any Swift.Decoder) throws {
                let container = try decoder.singleValueContainer()
                self.wrappedValue = container.decodeNil() ? nil : try container.decode(Value.self)
            }
            public func encode(to encoder: any Swift.Encoder) throws {
                var container = encoder.singleValueContainer()
                if let wrappedValue {
                    try container.encode(wrappedValue)
                } else {
                    try container.encodeNil()
                }
            }
        }
`;
  if (text.includes(schemasAnchor)) {
    text = text.replace(schemasAnchor, requiredNullableSupport);
  } else if (!text.includes(requiredNullableSupport)) {
    throw new Error(
      "patchKnownGeneratorGaps: expected Components.Schemas anchor not found; " +
        "swift-openapi-generator output may have changed, update the patch.",
    );
  }
  const emptySeriesByInstance = `        /// The series an instance belongs to, or null.
        ///
        /// - Remark: Generated from \`#/components/schemas/SeriesByInstanceResponse\`.
        public struct SeriesByInstanceResponse: Codable, Hashable, Sendable {
            /// Creates a new \`SeriesByInstanceResponse\`.
            public init() {}
        }`;
  const patchedSeriesByInstance = `        /// The series an instance belongs to, or null.
        ///
        /// - Remark: Generated from \`#/components/schemas/SeriesByInstanceResponse\`.
        public struct SeriesByInstanceResponse: Codable, Hashable, Sendable {
            /// - Remark: Generated from \`#/components/schemas/SeriesByInstanceResponse/series\`.
            public var series: Components.Schemas.SeriesHead?
            /// Creates a new \`SeriesByInstanceResponse\`.
            ///
            /// - Parameters:
            ///   - series:
            public init(series: Components.Schemas.SeriesHead? = nil) {
                self.series = series
            }
            public enum CodingKeys: String, CodingKey {
                case series
            }
        }`;
  if (text.includes(emptySeriesByInstance)) {
    text = text.replace(emptySeriesByInstance, patchedSeriesByInstance);
  } else if (!text.includes(patchedSeriesByInstance)) {
    throw new Error(
      "patchKnownGeneratorGaps: expected generated SeriesByInstanceResponse shape not found; " +
        "swift-openapi-generator output may have changed, update the patch.",
    );
  }

  // swift-openapi-generator 1.12 also drops a required oneOf[$ref, null]
  // property entirely. LeaveRequestV2View.charge_units is required on the wire
  // even though its value can be null, so preserve both halves of that contract:
  // a missing key must fail decoding and nil must encode as an explicit null.
  const chargePropertyAnchor = `            @available(*, deprecated)
            public var days: Swift.Double
            /// - Remark: Generated from \`#/components/schemas/LeaveRequestV2View/charge_state\`.`;
  const patchedChargeProperty = `            @available(*, deprecated)
            public var days: Swift.Double
            /// Exact resolved charge; null while review is required or no charge applies.
            ///
            /// - Remark: Generated from \`#/components/schemas/LeaveRequestV2View/charge_units\`.
            @RequiredNullable public var chargeUnits: Components.Schemas.LeaveUnits?
            /// - Remark: Generated from \`#/components/schemas/LeaveRequestV2View/charge_state\`.`;
  const chargeInitAnchor = `                days: Swift.Double,
                chargeState: Components.Schemas.LeaveRequestV2View.ChargeStatePayload,`;
  const patchedChargeInit = `                days: Swift.Double,
                chargeUnits: Components.Schemas.LeaveUnits?,
                chargeState: Components.Schemas.LeaveRequestV2View.ChargeStatePayload,`;
  const chargeAssignmentAnchor = `                self.days = days
                self.chargeState = chargeState`;
  const patchedChargeAssignment = `                self.days = days
                self.chargeUnits = chargeUnits
                self.chargeState = chargeState`;
  const chargeCodingKeyAnchor = `                case days
                case chargeState = "charge_state"`;
  const patchedChargeCodingKey = `                case days
                case chargeUnits = "charge_units"
                case chargeState = "charge_state"`;

  const chargePatchPairs = [
    [chargePropertyAnchor, patchedChargeProperty],
    [chargeInitAnchor, patchedChargeInit],
    [chargeAssignmentAnchor, patchedChargeAssignment],
    [chargeCodingKeyAnchor, patchedChargeCodingKey],
  ];
  for (const [generated, patched] of chargePatchPairs) {
    if (text.includes(generated)) {
      text = text.replace(generated, patched);
    } else if (!text.includes(patched)) {
      throw new Error(
        "patchKnownGeneratorGaps: expected generated LeaveRequestV2View charge_units anchor not found; " +
          "swift-openapi-generator output may have changed, update the patch.",
      );
    }
  }

  const requiredNullablePagePatchPairs = [
    [
      `            /// - Remark: Generated from \`#/components/schemas/LeaveRequestV2Page/next_cursor\`.
            public var nextCursor: Swift.String?`,
      `            /// - Remark: Generated from \`#/components/schemas/LeaveRequestV2Page/next_cursor\`.
            @RequiredNullable public var nextCursor: Swift.String?`,
    ],
    [
      `                items: [Components.Schemas.LeaveRequestV2View],
                nextCursor: Swift.String? = nil`,
      `                items: [Components.Schemas.LeaveRequestV2View],
                nextCursor: Swift.String?`,
    ],
    [
      `            /// - Remark: Generated from \`#/components/schemas/ActionInboxResponse/next_cursor\`.
            public var nextCursor: Swift.String?`,
      `            /// - Remark: Generated from \`#/components/schemas/ActionInboxResponse/next_cursor\`.
            @RequiredNullable public var nextCursor: Swift.String?`,
    ],
    [
      `                total: Swift.Int,
                totalIsExact: Swift.Bool,
                nextCursor: Swift.String? = nil`,
      `                total: Swift.Int,
                totalIsExact: Swift.Bool,
                nextCursor: Swift.String?`,
    ],
  ];
  for (const [generated, patched] of requiredNullablePagePatchPairs) {
    if (text.includes(generated)) {
      text = text.replace(generated, patched);
    } else if (!text.includes(patched)) {
      throw new Error(
        "patchKnownGeneratorGaps: expected generated required-nullable pagination anchor not found; " +
          "swift-openapi-generator output may have changed, update the patch.",
      );
    }
  }

  writeFileSync(typesFile, text, "utf8");
}

function replaceDirectoryFromStaging(stagingDir, targetDir) {
  const backupDir = mkdtempSync(resolve(stagingRoot, "swift-previous-"));
  rmSync(backupDir, { recursive: true, force: true });

  try {
    if (existsSync(targetDir)) {
      renameSync(targetDir, backupDir);
    }
    renameSync(stagingDir, targetDir);
    rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(targetDir) && existsSync(backupDir)) {
      renameSync(backupDir, targetDir);
    }
    throw error;
  }
}

if (!existsSync(cloneDir)) {
  mkdirSync(resolve(root, ".cache"), { recursive: true });
  run("git", [
    "-c",
    "advice.detachedHead=false",
    "clone",
    "--branch",
    generatorTag,
    "--depth",
    "1",
    "https://github.com/apple/swift-openapi-generator",
    cloneDir,
  ]);
}

if (!existsSync(generatorBin)) {
  run("swift", [
    "build",
    "--package-path",
    cloneDir,
    "--configuration",
    "release",
    "--product",
    "swift-openapi-generator",
  ]);
}

mkdirSync(stagingRoot, { recursive: true });
const stagingDir = mkdtempSync(resolve(stagingRoot, "swift-"));

try {
  run(generatorBin, [
    "generate",
    "--config",
    config,
    "--output-directory",
    stagingDir,
    inputSpec,
  ]);
  patchKnownGeneratorGaps(stagingDir);
  replaceDirectoryFromStaging(stagingDir, outputDir);
} catch (error) {
  rmSync(stagingDir, { recursive: true, force: true });
  throw error;
}
