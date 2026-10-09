/**
 * The native codex binary of the pinned `@openai/codex` package (its platform package), started
 * directly so no Node launcher process sits in between.
 */
import { createRequire } from "node:module";
import * as path from "node:path";

const PLATFORM_PACKAGES: Record<string, { pkg: string; triple: string }> = {
  "linux-x64": { pkg: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" },
  "linux-arm64": { pkg: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" },
  "darwin-x64": { pkg: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" },
  "darwin-arm64": { pkg: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" },
  "win32-x64": { pkg: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
  "win32-arm64": { pkg: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
};

export function codexBinary(): string {
  const target = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`codex engine: no codex binary for ${process.platform}-${process.arch}`);
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve(`${target.pkg}/package.json`));
  return path.join(root, "vendor", target.triple, "bin", process.platform === "win32" ? "codex.exe" : "codex");
}
