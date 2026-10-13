// npm run build          → dev bundle in dist/ (auto-reloads the unpacked extension on file changes)
// npm run build:release  → release/paper-route-<version>.zip: no dev code, runtime files only,
//                          and it refuses to write a zip that contains a key or API token.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = process.argv.includes("--release");

// what the unpacked extension needs at runtime — nothing else is shipped
const RUNTIME_FILES = ["manifest.json", "content.js", "hedge-ui.js", "chart-bridge.js", "hud.css", "options.html", "options.js", "assets"];

async function bundle(outfile, { dev }) {
  await build({
    entryPoints: [join(ROOT, "src/background.js")],
    bundle: true,
    format: "esm",
    target: "chrome120",
    outfile,
    minify: !dev,
    // __BUILD_ID__ lets a woken worker notice it is older than dist/ on disk (src/dev-reload.js)
    define: { __DEV__: String(dev), __BUILD_ID__: JSON.stringify(`build-${Date.now()}`) },
    logLevel: "info",
  });
}

if (!RELEASE) {
  await bundle(join(ROOT, "dist/background.js"), { dev: true });
} else {
  const { version } = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const name = `paper-route-${version}`;
  const stage = join(ROOT, "release", name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const f of RUNTIME_FILES) cpSync(join(ROOT, f), join(stage, f), { recursive: true });
  await bundle(join(stage, "dist/background.js"), { dev: false });

  cpSync(join(ROOT, "INSTALL.md"), join(stage, "INSTALL.md"));
  cpSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));

  // hard stop if anything personal slipped in: stream tokens, Wayfinder keys, or a 32-byte hex
  // value that isn't one of the crypto libraries' own constants (e.g. secp256k1's field prime)
  const grepAll = (args) => {
    try {
      return execFileSync("grep", args, { encoding: "utf8" }).trim();
    } catch (err) {
      if (err.status === 1) return ""; // no matches — the good case
      throw err;
    }
  };
  const tokenLeaks = grepAll(["-rlE", "wk_[A-Za-z0-9]{8}|[a-z]{3}_[0-9a-f]{32}", stage]);
  if (tokenLeaks) throw new Error(`Refusing to package — API tokens found in:\n${tokenLeaks}`);
  const hex64 = new Set(grepAll(["-rhoE", "0x[0-9a-fA-F]{64}", stage]).split("\n").filter(Boolean));
  const libDirs = ["node_modules/@noble", "node_modules/viem", "node_modules/@nktkas", "node_modules/ox"].map((d) => join(ROOT, d)).filter(existsSync);
  const unknownHex = [...hex64].filter((h) => !grepAll(["-rlF", "-m1", h.slice(2), ...libDirs]));
  if (unknownHex.length) throw new Error(`Refusing to package — ${unknownHex.length} unexplained 32-byte hex value(s) (possible private key)`);
  for (const devOnly of ["src", "node_modules", "test"]) {
    if (existsSync(join(stage, devOnly))) throw new Error(`${devOnly} must not be in the release`);
  }

  const zip = join(ROOT, "release", `${name}.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, name], { cwd: join(ROOT, "release") });
  console.log(`\n${zip}`);
}
