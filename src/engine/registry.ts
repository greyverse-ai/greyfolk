/**
 * Engine registry: each engine registers itself by name in its own file; `engine/index.ts`
 * lists the engine files (one line each). Nothing else names an engine, so adding one is one
 * strategy file plus one line there.
 */
import type { Engine, EngineOptions } from "./engine.js";
import type { OptionSpec } from "../options.js";

export interface EngineDefinition {
  name: string;
  /** False only for engines that run no model (the fake). */
  needsSoul: boolean;
  /** The engine's own start options, named `<engine>-<option>`; merged into the one option table. */
  options?: OptionSpec[];
  create(opts: EngineOptions): Engine;
}

const engines = new Map<string, EngineDefinition>();

export function registerEngine(def: EngineDefinition): void {
  if (engines.has(def.name)) throw new Error(`engine '${def.name}' is registered twice`);
  engines.set(def.name, def);
}

export function getEngine(name: string): EngineDefinition {
  const def = engines.get(name);
  if (!def) throw new Error(`unknown engine '${name}' (known: ${engineNames().join(", ")})`);
  return def;
}

export function engineNames(): string[] {
  return [...engines.keys()];
}

/** The engines' own options, for the one option table. */
export function engineOptions(): OptionSpec[] {
  return [...engines.values()].flatMap((d) => d.options ?? []);
}
