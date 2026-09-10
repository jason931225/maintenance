// Parsing //rust-toolchain.toml, in one place.
//
// Two callers read the pin: `lock-rust-toolchain.mjs`, which derives the lock
// from it, and `check-toolchain-pin.mjs`, which holds the lock to it. A second
// copy of this parser would be exactly the duplicate the pin exists to
// eliminate: two readers that can disagree about what the file says.
//
// An earlier revision of this comment justified the module by a "nightly
// roller" as its second caller. No roller exists -- not on `dev`, not on any
// branch -- so at that point this was a shared module with one consumer.
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
