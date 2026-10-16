// Offline tests (no network, no keys). The live read-only check is smoke.mjs.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const t of ["flowindex", "parity", "safetynet", "exits", "pt-patch", "hl-idempotent", "lanes", "pairs", "dncost"]) {
  console.log(`\n=== ${t} ===`);
  try {
    execFileSync(process.execPath, [join(here, `${t}.mjs`)], { stdio: "inherit" });
  } catch {
    failed++;
  }
}
console.log(failed ? `\n${failed} test file(s) failed` : "\nall offline tests passed");
process.exit(failed ? 1 : 0);
