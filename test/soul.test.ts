import { describe, expect, it } from "vitest";
import { parseSoul } from "../src/soul.js";

describe("soul metadata header (spec §1)", () => {
  it("parses name/description/author/version and keeps only the body for the prompt", () => {
    const s = parseSoul('---\nname: Alice\ndescription: "A quiet archivist"\nauthor: someone\nversion: 2\nlicense: MIT\n---\n\nYou are Alice.\n');
    expect(s.hasHeader).toBe(true);
    expect(s.metadata).toEqual({ name: "Alice", description: "A quiet archivist", author: "someone", version: "2", extra: { license: "MIT" } });
    expect(s.body).toBe("You are Alice.\n");
  });

  it("allows a missing header", () => {
    const s = parseSoul("You are Bob.\n---\nnot a header\n");
    expect(s.hasHeader).toBe(false);
    expect(s.metadata.name).toBeNull();
    expect(s.body).toBe("You are Bob.\n---\nnot a header\n");
  });

  it("refuses a malformed header with a clear error", () => {
    expect(() => parseSoul("---\nname: Alice\nYou are Alice.")).toThrow(/never closed/);
    expect(() => parseSoul("---\nname Alice\n---\nbody")).toThrow(/not 'key: value'/);
    expect(() => parseSoul("---\nname:\n---\nbody")).toThrow(/'name' is empty/);
    expect(() => parseSoul("---\nname: a\nname: b\n---\nbody")).toThrow(/repeats 'name'/);
    expect(() => parseSoul("---\n1bad: x\n---\nbody")).toThrow(/invalid key/);
  });

  it("tolerates blank and comment lines and a BOM", () => {
    const s = parseSoul("﻿---\n# soul\n\nname: Cy\n---\nbody");
    expect(s.metadata.name).toBe("Cy");
    expect(s.body).toBe("body");
  });
});
