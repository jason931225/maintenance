// The single object-type registry cache the dynamic console consumes: one
// bootstrap fetch of GET /api/v1/object-types feeds (a) the code-prefix grammar
// (codeGrammar.primeCodePrefixes), (b) the ONT_TYPES availability lookup
// (modules/typeRegistry.getObjectType), and (c) MOD_SCREENS surface derivation
// (modules/moduleScreens.getModuleScreen). A type registered via the Ontology
// Manager therefore wires its codes and module surface with NO frontend edit.
//
// Fail-closed: on any network/parse error the cache and the static-fallback
// grammar are left intact — never emptied — and the fetch resolves to the last
// good cache (or []). The registry only tells us WHICH types exist and their
// code prefixes; per-type property/link/action schemas are not served for
// projected domain kinds yet, so rich detail still comes from the static
// ONT_TYPES defs (see modules/typeRegistry.ts) with new kinds getting a generic
// surface. wire-pending: W1-be-ontology GET /api/v1/ontology/object-types/{key}
// projected-type schema → generic surfaces gain their real columns.
//
// The fetch is co-located here (not api/ontology.ts) to keep this lane's files
// self-contained; api/ontology.ts is under concurrent edit by the serial-wire
// lane. It still goes through the generated typed client, so the path/response
// are compile-checked.
import type { ConsoleApiClient } from "../../api/client";

import { primeCodePrefixes } from "./codeGrammar";

/** ObjectTypeResponse — one seeded object-type registry head. */
export interface RegistryObjectType {
  kind: string;
  /** Canonical per-kind code prefix (e.g. "AP-", "CS-"); null for id/name-referenced kinds. */
  codePrefix: string | null;
  description: string;
  status: "draft" | "active" | "archived";
  /** Instances visible to the caller (same per-kind visibility as resolveObject). */
  activeCount: number;
}

let cachedTypes: readonly RegistryObjectType[] | null = null;

/** The last-loaded registry, or null before the bootstrap fetch lands. */
export function registeredObjectTypes(): readonly RegistryObjectType[] | null {
  return cachedTypes;
}

/** One registered type by kind, or undefined (unknown / not yet loaded). */
export function registeredObjectType(kind: string): RegistryObjectType | undefined {
  return cachedTypes?.find((type) => type.kind === kind);
}

function ingest(types: readonly RegistryObjectType[]): void {
  cachedTypes = types;
  primeCodePrefixes(types.map((type) => type.codePrefix));
}

/**
 * Bootstrap fetch — call once at app start (see report: shell wiring seam).
 * Loads the object-type registry, caches it, and primes the code-prefix
 * grammar. Fail-closed: a network/parse error leaves the previous cache and the
 * static-fallback grammar untouched and resolves to the last good cache (or []).
 */
export async function loadObjectTypeRegistry(
  api: ConsoleApiClient,
): Promise<readonly RegistryObjectType[]> {
  try {
    const { data } = await api.GET("/api/v1/object-types");
    if (!data) return cachedTypes ?? [];
    const types: RegistryObjectType[] = data.map((row) => ({
      kind: row.kind,
      codePrefix: row.code_prefix ?? null,
      description: row.description,
      status: row.status,
      activeCount: row.active_count,
    }));
    ingest(types);
    return types;
  } catch {
    return cachedTypes ?? [];
  }
}

/** Seed the cache + grammar from a payload directly. Bootstrap/test seam. */
export function primeObjectTypeRegistry(types: readonly RegistryObjectType[]): void {
  ingest(types);
}

/** Clear the cache. Test isolation only (pair with codeGrammar.resetCodePrefixes). */
export function resetObjectTypeRegistry(): void {
  cachedTypes = null;
}
