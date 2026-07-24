export function parseSingleBuckOutput(target, stdout) {
  const acceptedLabels = new Set([target, `root${target}`]);
  const outputLines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match || !acceptedLabels.has(match[1])) return null;
      return match[2].trim();
    })
    .filter(Boolean);
  if (outputLines.length !== 1) {
    throw new Error(
      `Buck2 did not report exactly one output for ${target}; refusing to run an ambiguous artifact`,
    );
  }
  return outputLines[0];
}
