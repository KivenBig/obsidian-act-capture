import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const esbuildCandidates = [
  join(__dirname, "node_modules/.bin/esbuild"),
  join(__dirname, "../action-tracker/node_modules/.bin/esbuild")
];

const esbuild = esbuildCandidates.find((candidate) => existsSync(candidate));
if (!esbuild) {
  throw new Error("Cannot find esbuild. Run npm install in the plugin directory first.");
}

execFileSync(
  esbuild,
  ["main.ts", "--bundle", "--platform=browser", "--format=cjs", "--external:obsidian", "--outfile=main.js"],
  { cwd: __dirname, stdio: "inherit" }
);
