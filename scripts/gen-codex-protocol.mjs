// Regenerates the Codex app-server protocol types from the pinned codex binary (`npm run gen:codex-protocol`).
// The output is codex's own generated code, checked in as it is; an engine upgrade regenerates it and the diff shows what changed.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codexBinary } from "../dist/engine/codex-binary.js";

const out = fileURLToPath(new URL("../src/engine/codex-protocol", import.meta.url));
rmSync(out, { recursive: true, force: true });
execFileSync(codexBinary(), ["app-server", "generate-ts", "--out", out], { stdio: "inherit" });
// The generated files import each other without extensions: they are type-only, so a CommonJS scope lets them resolve.
writeFileSync(`${out}/package.json`, `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
