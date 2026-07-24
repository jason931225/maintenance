import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import openapiTS from "openapi-typescript";

const componentPathPrefix = "#/components/schemas/";
const modelRelativePath = "src/main/kotlin/com/maintenance/api/client/model";
const safeKotlinIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const kotlinKeywords = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface",
  "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias",
  "val", "var", "when", "while",
]);

// This is deliberately an explicit, narrow compatibility seam. Unmapped oneOf
// schemas (including EvidenceHoldRequest) remain generator-owned unchanged.
export const supportedWorkbenchUnionNames = Object.freeze([
  "WorkbenchActionSourceEnvelope",
  "WorkbenchCalendarSourceEnvelope",
  "WorkbenchEffectiveScope",
  "WorkbenchTodoSourceEnvelope",
]);

function fail(message) {
  throw new Error(`Kotlin discriminator union generation failed: ${message}`);
}

function requireSafeIdentifier(value, label) {
  if (typeof value !== "string" || !safeKotlinIdentifier.test(value) || kotlinKeywords.has(value)) {
    fail(`${label} must be a safe Kotlin identifier, received ${JSON.stringify(value)}`);
  }
}

function schemaNameFromRef(ref, label) {
  if (typeof ref !== "string" || !ref.startsWith(componentPathPrefix)) {
    fail(`${label} must be an internal component schema ref, received ${JSON.stringify(ref)}`);
  }
  const name = ref.slice(componentPathPrefix.length);
  requireSafeIdentifier(name, `${label} target`);
  return name;
}

function exactStringSet(values) {
  return [...new Set(values)].sort();
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function singletonDiscriminatorLiteral(schema, discriminator, childName) {
  const required = schema.required;
  if (!Array.isArray(required) || !required.includes(discriminator)) {
    fail(`${childName} must require discriminator property ${JSON.stringify(discriminator)}`);
  }
  const property = schema.properties?.[discriminator];
  requirePlainObject(property, `${childName}.${discriminator}`);
  if (typeof property.const === "string") {
    return property.const;
  }
  if (Array.isArray(property.enum) && property.enum.length === 1 && typeof property.enum[0] === "string") {
    return property.enum[0];
  }
  fail(`${childName}.${discriminator} must declare one exact string const or singleton enum`);
}

function validateUnion(name, parentSchema, componentSchemas) {
  requireSafeIdentifier(name, "parent schema name");
  requirePlainObject(parentSchema, name);
  if (!Array.isArray(parentSchema.oneOf) || parentSchema.oneOf.length === 0) {
    fail(`${name} must contain a non-empty oneOf`);
  }
  const discriminator = requirePlainObject(parentSchema.discriminator, `${name}.discriminator`);
  if (typeof discriminator.propertyName !== "string" || discriminator.propertyName.length === 0) {
    fail(`${name}.discriminator.propertyName must be a non-empty string`);
  }
  const mapping = requirePlainObject(discriminator.mapping, `${name}.discriminator.mapping`);
  const mappingEntries = Object.entries(mapping);
  if (mappingEntries.length === 0) {
    fail(`${name}.discriminator.mapping must be non-empty and explicit`);
  }

  const oneOfTargets = exactStringSet(parentSchema.oneOf.map((entry, index) => {
    requirePlainObject(entry, `${name}.oneOf[${index}]`);
    return schemaNameFromRef(entry.$ref, `${name}.oneOf[${index}]`);
  }));
  if (oneOfTargets.length !== parentSchema.oneOf.length) {
    fail(`${name}.oneOf must not repeat a target`);
  }

  const mappingTargets = exactStringSet(mappingEntries.map(([, ref]) => schemaNameFromRef(ref, `${name}.discriminator.mapping`)));
  if (mappingTargets.length !== mappingEntries.length) {
    fail(`${name}.discriminator.mapping must not map multiple literals to one target`);
  }
  if (!sameSet(oneOfTargets, mappingTargets)) {
    fail(`${name}.oneOf refs and discriminator.mapping refs must be the same set`);
  }

  const variants = mappingEntries.map(([literal, ref]) => {
    if (typeof literal !== "string" || literal.length === 0) {
      fail(`${name}.discriminator.mapping contains an empty/non-string wire literal`);
    }
    const schemaName = schemaNameFromRef(ref, `${name}.discriminator.mapping[${JSON.stringify(literal)}]`);
    const childSchema = componentSchemas.get(schemaName);
    if (!childSchema) {
      fail(`${name} maps ${JSON.stringify(literal)} to missing component ${schemaName}`);
    }
    if (childSchema.oneOf || childSchema.anyOf || childSchema.allOf) {
      fail(`${name} target ${schemaName} must be a concrete schema, not a composition`);
    }
    const actualLiteral = singletonDiscriminatorLiteral(childSchema, discriminator.propertyName, schemaName);
    if (actualLiteral !== literal) {
      fail(`${name} maps ${JSON.stringify(literal)} to ${schemaName}, but its ${discriminator.propertyName} is ${JSON.stringify(actualLiteral)}`);
    }
    return { literal, schemaName };
  }).sort((left, right) => left.literal.localeCompare(right.literal));

  return Object.freeze({ name, discriminator: discriminator.propertyName, variants: Object.freeze(variants) });
}

export function validateSupportedKotlinDiscriminatorUnions(componentSchemas) {
  if (!(componentSchemas instanceof Map)) {
    fail("componentSchemas must be a Map keyed by component schema name");
  }
  const names = [...supportedWorkbenchUnionNames].sort();
  const unions = names.map((name) => {
    const schema = componentSchemas.get(name);
    if (!schema) {
      fail(`missing required supported component ${name}`);
    }
    return validateUnion(name, schema, componentSchemas);
  });
  return Object.freeze(unions);
}

export async function collectSupportedKotlinDiscriminatorUnions(specUrl) {
  const parentSchemas = new Map();
  await openapiTS(specUrl, {
    silent: true,
    transform(schema, meta) {
      const path = meta.path;
      if (!path.startsWith(componentPathPrefix)) {
        return undefined;
      }
      const name = path.slice(componentPathPrefix.length);
      // openapi-typescript invokes transform for a component's nested members
      // with the component path too. A supported parent has this exact shape;
      // ignore every nested callback rather than treating it as a component.
      if (!supportedWorkbenchUnionNames.includes(name) || !Array.isArray(schema.oneOf)) {
        return undefined;
      }
      const previous = parentSchemas.get(name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(schema)) {
        fail(`component ${name} was observed with conflicting schemas`);
      }
      parentSchemas.set(name, schema);
      return undefined;
    },
  });

  const childNames = new Set();
  for (const name of supportedWorkbenchUnionNames) {
    const schema = parentSchemas.get(name);
    if (!schema) {
      fail(`missing required supported component ${name}`);
    }
    const mapping = schema.discriminator?.mapping;
    if (!mapping || typeof mapping !== "object") {
      fail(`${name}.discriminator.mapping must be non-empty and explicit`);
    }
    for (const ref of Object.values(mapping)) {
      childNames.add(schemaNameFromRef(ref, `${name}.discriminator.mapping`));
    }
  }

  const componentSchemas = new Map(parentSchemas);
  await openapiTS(specUrl, {
    silent: true,
    transform(schema, meta) {
      const name = meta.path.startsWith(componentPathPrefix) ? meta.path.slice(componentPathPrefix.length) : "";
      // Child roots are concrete objects that declare the discriminator as
      // required. Nested primitive/property callbacks share the parent path but
      // cannot satisfy this shape.
      if (!childNames.has(name) || schema.type !== "object" || !Array.isArray(schema.required)) {
        return undefined;
      }
      const previous = componentSchemas.get(name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(schema)) {
        fail(`component ${name} was observed with conflicting schemas`);
      }
      componentSchemas.set(name, schema);
      return undefined;
    },
  });
  return validateSupportedKotlinDiscriminatorUnions(componentSchemas);
}

function modelFile(modelDir, name) {
  return resolve(modelDir, `${name}.kt`);
}

function readRequired(path, label) {
  if (!existsSync(path)) {
    fail(`generated ${label} is missing: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function kotlinString(value) {
  return JSON.stringify(value);
}

function renderParent(union) {
  const cases = union.variants.map(({ literal, schemaName }) => `            ${kotlinString(literal)} -> jsonDecoder.json.decodeFromJsonElement(${schemaName}.serializer(), element)`).join("\n");
  const encoders = union.variants.map(({ literal, schemaName }) => `            is ${schemaName} -> ${kotlinString(literal)} to jsonEncoder.json.encodeToJsonElement(${schemaName}.serializer(), value)`).join("\n");
  return `/**\n *\n * Please note:\n * This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).\n * Do not edit this file manually.\n *\n */\n\npackage com.maintenance.api.client.model\n\nimport kotlinx.serialization.KSerializer\nimport kotlinx.serialization.Serializable\nimport kotlinx.serialization.SerializationException\nimport kotlinx.serialization.descriptors.SerialDescriptor\nimport kotlinx.serialization.descriptors.buildClassSerialDescriptor\nimport kotlinx.serialization.encoding.Decoder\nimport kotlinx.serialization.encoding.Encoder\nimport kotlinx.serialization.json.JsonDecoder\nimport kotlinx.serialization.json.JsonEncoder\nimport kotlinx.serialization.json.JsonNull\nimport kotlinx.serialization.json.JsonObject\nimport kotlinx.serialization.json.JsonPrimitive\nimport kotlinx.serialization.json.decodeFromJsonElement\nimport kotlinx.serialization.json.encodeToJsonElement\n\n@Serializable(with = ${union.name}Serializer::class)\nsealed interface ${union.name}\n\nobject ${union.name}Serializer : KSerializer<${union.name}> {\n    override val descriptor: SerialDescriptor = buildClassSerialDescriptor(${kotlinString(union.name)})\n\n    override fun deserialize(decoder: Decoder): ${union.name} {\n        val jsonDecoder = decoder as? JsonDecoder\n            ?: throw SerializationException(${kotlinString(`${union.name} can only be decoded from JSON`)})\n        val element = jsonDecoder.decodeJsonElement()\n        val objectValue = element as? JsonObject\n            ?: throw SerializationException(${kotlinString(`${union.name} must decode from a JSON object`)})\n        val discriminator = (objectValue[${kotlinString(union.discriminator)}] as? JsonPrimitive)\n            ?.takeUnless { it is JsonNull }\n            ?.content\n            ?: throw SerializationException(${kotlinString(`${union.name} requires string discriminator ${union.discriminator}`)})\n        return when (discriminator) {\n${cases}\n            else -> throw SerializationException(${kotlinString(`Unknown ${union.name} ${union.discriminator}: `)} + discriminator)\n        }\n    }\n\n    override fun serialize(encoder: Encoder, value: ${union.name}) {\n        val jsonEncoder = encoder as? JsonEncoder\n            ?: throw SerializationException(${kotlinString(`${union.name} can only be encoded as JSON`)})\n        val (expectedDiscriminator, element) = when (value) {\n${encoders}\n        }\n        val actualDiscriminator = ((element as? JsonObject)?.get(${kotlinString(union.discriminator)}) as? JsonPrimitive)\n            ?.takeUnless { it is JsonNull }\n            ?.content\n        if (actualDiscriminator != expectedDiscriminator) {\n            throw SerializationException(${kotlinString(`${union.name} serializer expected ${union.discriminator} `)} + expectedDiscriminator)\n        }\n        jsonEncoder.encodeJsonElement(element)\n    }\n}\n`;
}

function patchChildDeclaration(content, childName, parents) {
  const declaration = `data class ${childName} (`;
  const declarationIndex = content.indexOf(declaration);
  if (declarationIndex < 0 || content.indexOf(declaration, declarationIndex + declaration.length) >= 0) {
    fail(`generated child ${childName} must contain exactly one concrete data-class declaration`);
  }
  if (!/@(?:[A-Za-z0-9_.]+\.)?Serializable\b/.test(content.slice(0, declarationIndex))) {
    fail(`generated child ${childName} must be serializable`);
  }
  const constructorEnd = content.indexOf("\n) {\n", declarationIndex);
  if (constructorEnd < 0) {
    fail(`generated child ${childName} has an unsupported data-class declaration shape`);
  }
  const inheritance = parents.join(",\n    ");
  return `${content.slice(0, constructorEnd)}\n) :\n    ${inheritance} {\n${content.slice(constructorEnd + "\n) {\n".length)}`;
}

export function patchGeneratedKotlinMappedUnions({ stagingDir, unions }) {
  if (!Array.isArray(unions) || unions.length !== supportedWorkbenchUnionNames.length) {
    fail("patch call must include every supported Workbench union exactly once");
  }
  const orderedUnions = [...unions].sort((left, right) => left.name.localeCompare(right.name));
  const names = orderedUnions.map(({ name }) => name);
  if (!sameSet(names, [...supportedWorkbenchUnionNames].sort())) {
    fail("patch call contains unsupported or missing Workbench unions");
  }
  const modelDir = resolve(stagingDir, modelRelativePath);
  const childParents = new Map();
  for (const union of orderedUnions) {
    for (const { schemaName } of union.variants) {
      const parents = childParents.get(schemaName) ?? new Set();
      parents.add(union.name);
      childParents.set(schemaName, parents);
    }
  }

  // Validate the complete generated shape before writing any file.
  const parents = orderedUnions.map((union) => ({ union, path: modelFile(modelDir, union.name) }));
  const children = [...childParents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([childName, parentSet]) => ({
      childName,
      parents: [...parentSet].sort(),
      path: modelFile(modelDir, childName),
    }));
  for (const parent of parents) {
    readRequired(parent.path, `parent ${parent.union.name}`);
  }
  const childContents = children.map((child) => ({ ...child, content: readRequired(child.path, `child ${child.childName}`) }));

  const patchedParents = parents.map((parent) => ({ ...parent, content: renderParent(parent.union) }));
  const patchedChildren = childContents.map((child) => ({
    ...child,
    content: patchChildDeclaration(child.content, child.childName, child.parents),
  }));
  for (const parent of patchedParents) {
    writeFileSync(parent.path, parent.content, "utf8");
  }
  for (const child of patchedChildren) {
    writeFileSync(child.path, child.content, "utf8");
  }
  return Object.freeze({
    parentFiles: Object.freeze(parents.map(({ path }) => path)),
    childFiles: Object.freeze(children.map(({ path }) => path)),
    unionCount: parents.length,
    variantCount: orderedUnions.reduce((count, union) => count + union.variants.length, 0),
  });
}
