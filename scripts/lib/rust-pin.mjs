// Parsing //rust-toolchain.toml, in one place.
//
// Two generators need the pin -- the lockfile writer and the nightly roller --
// and a second copy of this parser would be exactly the duplicate the pin
// exists to eliminate: two readers that can disagree about what the file says.
export function parsePin(text) {
  const channel = /^\s*channel\s*=\s*"([^"]+)"/m.exec(text);
  const list = (key) => {
    const block = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(text);
    return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  };
  return {
    channel: channel ? channel[1] : null,
    components: list("components"),
    targets: list("targets"),
  };
}
