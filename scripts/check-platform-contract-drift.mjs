import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultOpenApiPath = resolve(root, "backend/openapi/openapi.yaml");
const defaultPlatformRestFiles = [
  resolve(root, "backend/crates/platform/platform-rest/src/lib.rs"),
  resolve(root, "backend/crates/platform/platform-rest/src/view_as.rs"),
];
const httpMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export function checkPlatformContractDrift({
  openApiPath = defaultOpenApiPath,
  platformRestFiles = defaultPlatformRestFiles,
} = {}) {
  const openApiYaml = readFileSync(openApiPath, "utf8");
  const platformSources = platformRestFiles.map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));

  const backendOperations = platformRestOperations(platformSources);
  const openApiOperations = openApiPlatformOperations(openApiYaml);

  const missing = [...backendOperations]
    .filter((operation) => !openApiOperations.has(operation))
    .sort();
  const unexpected = [...openApiOperations]
    .filter((operation) => !backendOperations.has(operation))
    .sort();

  if (missing.length > 0 || unexpected.length > 0) {
    const sections = [];
    if (missing.length > 0) {
      sections.push(
        [
          "OpenAPI is missing /api/platform route operations defined by backend platform-rest:",
          ...missing.map((operation) => `  - ${operation}`),
        ].join("\n"),
      );
    }
    if (unexpected.length > 0) {
      sections.push(
        [
          "OpenAPI documents /api/platform operations not defined by backend platform-rest:",
          ...unexpected.map((operation) => `  - ${operation}`),
        ].join("\n"),
      );
    }
    throw new Error(sections.join("\n\n"));
  }

  return { backendOperations, openApiOperations };
}

function platformRestOperations(platformSources) {
  const constants = new Map();
  for (const { source } of platformSources) {
    for (const match of source.matchAll(/pub(?:\([^)]*\))?\s+const\s+([A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]+)";/g)) {
      constants.set(match[1], match[2]);
    }
  }

  const operations = new Set();
  for (const { path: sourcePath, source } of platformSources) {
    for (const routeCall of extractRouteCalls(source)) {
      const [pathExpression, routeMethodsExpression] = splitTopLevelRouteArguments(routeCall);
      const constantName = pathExpression.trim();
      const routePath = constants.get(constantName);
      if (!routePath) {
        throw new Error(`${sourcePath}: route uses unknown path constant ${constantName}`);
      }
      if (!routePath.startsWith("/api/platform/")) {
        continue;
      }

      const routeMethods = new Set(
        [
          ...routeMethodsExpression.matchAll(
            /\b(get|put|post|delete|options|head|patch|trace)\s*\(/g,
          ),
        ].map((methodMatch) => methodMatch[1].toUpperCase()),
      );
      if (routeMethods.size === 0) {
        throw new Error(`${sourcePath}: ${constantName} has no recognized HTTP method`);
      }
      for (const method of routeMethods) {
        operations.add(operationKey(method, routePath));
      }
    }
  }

  return operations;
}

function extractRouteCalls(source) {
  const routeCalls = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const routeStart = source.indexOf(".route(", searchFrom);
    if (routeStart === -1) {
      break;
    }

    const openParen = source.indexOf("(", routeStart);
    let depth = 0;
    let closeParen = -1;
    for (let index = openParen; index < source.length; index += 1) {
      const char = source[index];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          closeParen = index;
          break;
        }
      }
    }
    if (closeParen === -1) {
      throw new Error("unterminated .route(...) call in platform-rest source");
    }

    routeCalls.push(source.slice(openParen + 1, closeParen));
    searchFrom = closeParen + 1;
  }

  return routeCalls;
}

function splitTopLevelRouteArguments(routeCall) {
  let depth = 0;
  for (let index = 0; index < routeCall.length; index += 1) {
    const char = routeCall[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return [routeCall.slice(0, index), routeCall.slice(index + 1)];
    }
  }
  throw new Error(`could not split .route(...) arguments: ${routeCall}`);
}

function openApiPlatformOperations(yaml) {
  const operations = new Set();
  let currentPath = null;

  for (const line of yaml.split(/\r?\n/)) {
    const trimmedRight = line.trimEnd();
    const pathMatch = trimmedRight.match(/^  (\/[^:]+):$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (!line.startsWith(" ")) {
      currentPath = null;
      continue;
    }
    if (!currentPath?.startsWith("/api/platform/")) {
      continue;
    }

    const methodMatch = trimmedRight.match(/^    ([a-z]+):$/);
    if (methodMatch && httpMethods.has(methodMatch[1])) {
      operations.add(operationKey(methodMatch[1].toUpperCase(), currentPath));
    }
  }

  return operations;
}

function operationKey(method, path) {
  return `${method.toUpperCase()} ${normalizePathParameters(path)}`;
}

function normalizePathParameters(path) {
  return path.replaceAll(/\{[^}/]+\}/g, "{}");
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    const openApiPath = process.argv[2] ? resolve(process.argv[2]) : defaultOpenApiPath;
    const { backendOperations } = checkPlatformContractDrift({ openApiPath });
    console.log(`Platform contract drift gate passed (${backendOperations.size} backend operations covered).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
