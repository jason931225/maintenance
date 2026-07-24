export function resolveBootstrapModes(env) {
  const devAuth = env.MNT_DEV_AUTH_E2E === "1";
  const consolePreview = env.VITE_CONSOLE_DEV_PREVIEW === "1";
  return {
    devAuth,
    consolePreview,
    startVite: devAuth || consolePreview,
  };
}
