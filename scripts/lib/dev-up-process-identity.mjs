// A PID alone is not an authority to signal: it can be reused after a crash or
// restart. The launcher persists both the OS start token and command observed
// immediately after spawning, and permits shutdown only while both remain.
export function processIdentityMatches(expected, current) {
  return Boolean(
    expected?.startToken &&
      expected?.command &&
      current?.startToken === expected.startToken &&
      current.command === expected.command,
  );
}

export function shouldSignalManagedProcess(expected, current) {
  return processIdentityMatches(expected, current);
}
