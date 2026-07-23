export interface ConsoleDevelopmentPreviewEnvironment {
  dev: boolean;
  flag: string | undefined;
}

/**
 * The mounted console inventory is available only when both the compile-time
 * development build marker and the explicit local opt-in are present.
 */
export function isConsoleDevelopmentPreviewEnabled({
  dev,
  flag,
}: ConsoleDevelopmentPreviewEnvironment): boolean {
  return dev && flag === "1";
}
