// Serial-wire input: {screenKey → component} + the ko keys it needs merged.
// screenKey matches nav.ts's `finance` item (nav label 재무). Do not mount this
// directly in ConsoleShell.tsx from this lane — the wire step owns that.
import { ModuleFinanceScreenBody } from "./ModuleFinanceScreenBody";
import { financeKoManifest } from "./koManifest";

export const screenKey = "finance";
export const Component = ModuleFinanceScreenBody;
export const koManifest = financeKoManifest;
