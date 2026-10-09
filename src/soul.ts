/**
 * The soul file (spec §1): a Markdown body with an optional metadata header
 * (`name`, `description`, `author`, `version`, …) kept as YAML-style frontmatter:
 *
 *   ---
 *   name: Alice
 *   version: 1
 *   ---
 *   You are Alice…
 *
 * No header is fine (every field null). A header that opens and does not close, or holds a line
 * that is not `key: value`, is refused with a clear error: a half-parsed soul must never reach the
 * model as its prompt. Only the body is passed as the system prompt.
 */

export interface SoulMetadata {
  name: string | null;
  description: string | null;
  author: string | null;
  version: string | null;
  /** Any other header fields, kept verbatim for a later shareable schema. */
  extra: Record<string, string>;
}

export interface Soul {
  metadata: SoulMetadata;
  /** The Markdown body: what the model sees as its system prompt. */
  body: string;
  hasHeader: boolean;
}

const KNOWN = ["name", "description", "author", "version"] as const;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

export function parseSoul(text: string): Soul {
  const src = text.replace(/^﻿/, "");
  const lines = src.split(/\r?\n/);
  const metadata: SoulMetadata = { name: null, description: null, author: null, version: null, extra: {} };
  if (lines[0]?.trim() !== "---") return { metadata, body: src, hasHeader: false };

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error("soul metadata header opened with '---' but never closed");

  const seen = new Set<string>();
  for (let i = 1; i < close; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`soul metadata header line ${i + 1} is not 'key: value': ${JSON.stringify(line)}`);
    const key = line.slice(0, colon).trim();
    if (!KEY.test(key)) throw new Error(`soul metadata header line ${i + 1} has an invalid key ${JSON.stringify(key)}`);
    if (seen.has(key)) throw new Error(`soul metadata header repeats '${key}'`);
    seen.add(key);
    const value = unquote(line.slice(colon + 1));
    if ((KNOWN as readonly string[]).includes(key)) {
      if (!value) throw new Error(`soul metadata '${key}' is empty`);
      metadata[key as (typeof KNOWN)[number]] = value;
    } else {
      metadata.extra[key] = value;
    }
  }
  const body = lines.slice(close + 1).join("\n").replace(/^\n+/, "");
  return { metadata, body, hasHeader: true };
}
