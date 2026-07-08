// Small formatting helpers shared by workspace chrome components.

export function chipPrefix(code: string): string {
  return code.includes("-") ? code.split("-")[0] : code.slice(0, 2);
}
