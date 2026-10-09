/** Prompt helpers every engine that takes one text prompt shares. */
import type { InputMessage } from "../api/input.js";

/** Folds input messages into one prompt: developer/system messages become tagged blocks ahead of the user text. */
export function foldInput(items: InputMessage[], instructions: string | null): string {
  const parts: string[] = [];
  if (instructions) parts.push(`<instructions>\n${instructions}\n</instructions>`);
  for (const it of items) {
    if (it.role === "user") parts.push(it.content);
    else parts.push(`<${it.role}>\n${it.content}\n</${it.role}>`);
  }
  return parts.join("\n\n");
}

/** The text of a message's content (a string or an array of parts with `text`). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}
