import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const outfile = "sensitive-guard.exe";

console.log("Building Windows exe...");
execSync(
  `bun build --compile --target=bun-windows-x64 ./src/cli.ts --outfile=${outfile}`,
  { stdio: "inherit" }
);

if (existsSync("icon.ico")) {
  try {
    const { rcedit } = await import("rcedit");
    await rcedit(outfile, { icon: "icon.ico" });
    console.log("Icon embedded.");
  } catch {
    console.log("Icon embed skipped (rcedit needs Wine on macOS/Linux).");
    console.log("Run on Windows: npx rcedit sensitive-guard.exe --set-icon icon.ico");
  }
} else {
  console.log("icon.ico not found, skipping icon.");
}
