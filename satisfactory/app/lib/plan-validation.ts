import type { PlanData } from "../data/types.ts";

export const MAX_PLAN_BYTES = 1_000_000;

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

const fail = (message: string): never => { throw new PlanValidationError(message); };
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 20_000, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    fail(`${label} must be ${allowEmpty ? "text" : "non-empty text"} of at most ${max} characters.`);
  }
  return value as string;
}
function array(value: unknown, label: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length > max || value.length < min) {
    fail(`${label} must contain ${min}–${max} entries.`);
  }
  return value as unknown[];
}
function pdfUrl(value: unknown): string {
  const text = string(value, "Original PDF URL", 2_000, false);
  if (/[\u0000-\u0020\\]/.test(text)) fail("The original PDF URL is invalid.");
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) fail("Use a valid HTTP or HTTPS original PDF URL.");
    return text;
  } catch { return fail("Use a valid original PDF URL."); }
}

/** Validate, then copy only supported fields; untrusted imports never become executable markup. */
export function validatePlan(value: unknown): PlanData {
  const input = object(value, "Plan");
  const workspace = object(input.workspace, "Workspace");
  const seen = new Set<string>();
  function id(value: unknown): string {
    const identifier = string(value, "ID", 120, false);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(identifier)) fail("IDs may contain letters, numbers, hyphens and underscores only.");
    if (seen.has(identifier)) fail(`Duplicate ID: ${identifier}.`);
    seen.add(identifier);
    return identifier;
  }
  const data = {
    workspace: {
      name: string(workspace.name, "World name", 160),
      playerA: string(workspace.playerA, "Pioneer A", 160),
      playerB: string(workspace.playerB, "Pioneer B", 160),
    },
    documents: array(input.documents, "Documents", 8, 1).map((rawDocument) => {
      const document = object(rawDocument, "Document");
      return {
        id: id(document.id),
        title: string(document.title, "Document title", 300, false),
        shortTitle: string(document.shortTitle, "Document short title", 160, false),
        description: string(document.description, "Document description", 5_000),
        pdfUrl: pdfUrl(document.pdfUrl),
        pages: array(document.pages, "Pages", 100, 1).map((rawPage) => {
          const page = object(rawPage, "Page");
          if (!Number.isSafeInteger(page.number) || (page.number as number) < 1 || (page.number as number) > 10000) fail("Page numbers must be positive integers.");
          return {
            id: id(page.id), number: page.number as number,
            title: string(page.title, "Page title", 300, false),
            subtitle: string(page.subtitle, "Page subtitle", 2_000),
            blocks: array(page.blocks, "Page blocks", 300).map((rawBlock) => {
              const block = object(rawBlock, "Block");
              const blockId = id(block.id);
              if (block.type === "text" || block.type === "heading") {
                return { id: blockId, type: block.type, text: string(block.text, "Text") };
              }
              if (block.type === "check") {
                if (typeof block.checked !== "boolean") fail("Checklist status must be true or false.");
                if (typeof block.assignee !== "string" || !/^(unassigned|a|b|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(block.assignee)) fail("Choose a valid player or unassigned.");
                return { id: blockId, type: "check", text: string(block.text, "Checklist text"), checked: block.checked, assignee: block.assignee };
              }
              if (block.type === "note") {
                return { id: blockId, type: "note", label: string(block.label, "Note label", 500), value: string(block.value, "Note") };
              }
              if (block.type === "table") {
                const headers = array(block.headers, "Table headers", 20, 1).map((cell) => string(cell, "Column heading", 500));
                const rows = array(block.rows, "Table rows", 500).map((rawRow) => {
                  const row = array(rawRow, "Row cells", headers.length, headers.length);
                  return row.map((cell) => string(cell, "Table cell", 4_000));
                });
                return { id: blockId, type: "table", headers, rows };
              }
              return fail("Unknown block type.");
            }),
          };
        }),
      };
    }),
  };
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_PLAN_BYTES) fail("The plan is too large to save.");
  return data as PlanData;
}

export function validatePlanUpdate(value: unknown): { data: PlanData; revision: number } {
  const input = object(value, "Update");
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || (input.revision as number) >= Number.MAX_SAFE_INTEGER) fail("A valid revision is required.");
  return { data: validatePlan(input.data), revision: input.revision as number };
}

export function isSameOriginWrite(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin && request.headers.get("sec-fetch-site") !== "cross-site";
}

/** Bound the streamed body as well as Content-Length; chunked input cannot evade the cap. */
export async function readPlanUpdate(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) fail("Send the plan as JSON.");
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > MAX_PLAN_BYTES) fail("The plan is too large to save.");
  const reader = request.body?.getReader() ?? fail("The update is empty.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_PLAN_BYTES) { await reader.cancel(); fail("The plan is too large to save."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("The update is not valid JSON."); }
}
