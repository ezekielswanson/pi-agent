import { ScopeError } from "../../utils/errors.ts";

export interface BlockListPage {
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface BlockContinuation {
  blockId: string;
  cursor: string | null;
  depth: number;
}

export interface BlockCollection {
  text: string;
  blockCount: number;
  completeness: "complete" | "partial";
  reason?: string;
  continuation?: BlockContinuation;
}

export const NOTION_READ_LIMITS = {
  maxDepth: 3,
  maxBlocks: 100,
  maxChars: 12_000,
  pageSize: 50,
};

export type ListBlocks = (
  blockId: string,
  cursor: string | undefined,
  signal?: AbortSignal,
) => Promise<BlockListPage>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Operation cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function richText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const parts = (value as { rich_text?: Array<{ plain_text?: string }> }).rich_text;
  if (!parts) return "";
  return parts.map((part) => part.plain_text ?? "").join("");
}

export function blockPlainText(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  return richText(record[type]);
}

function partial(
  reason: string,
  text: string,
  blockCount: number,
  continuation: BlockContinuation,
): BlockCollection {
  return { text, blockCount, completeness: "partial", reason, continuation };
}

export async function collectBlockText(
  list: ListBlocks,
  rootId: string,
  signal?: AbortSignal,
  limits = NOTION_READ_LIMITS,
): Promise<BlockCollection> {
  const queue: BlockContinuation[] = [{ blockId: rootId, cursor: null, depth: 0 }];
  const lines: string[] = [];
  let blockCount = 0;
  let chars = 0;

  while (queue.length > 0) {
    throwIfAborted(signal);
    const frame = queue.shift();
    if (!frame) break;
    if (frame.depth > limits.maxDepth) {
      return partial("Nested blocks exceed the depth cap.", lines.join("\n"), blockCount, frame);
    }
    const page = await list(frame.blockId, frame.cursor ?? undefined, signal);
    throwIfAborted(signal);
    for (const block of page.results) {
      blockCount += 1;
      const record = typeof block === "object" && block !== null ? (block as Record<string, unknown>) : {};
      const blockId = typeof record.id === "string" ? record.id : frame.blockId;
      if (blockCount > limits.maxBlocks) {
        return partial("Block cap reached.", lines.join("\n"), blockCount - 1, {
          blockId: frame.blockId,
          cursor: page.next_cursor ?? frame.cursor,
          depth: frame.depth,
        });
      }
      const text = blockPlainText(block);
      if (chars + text.length > limits.maxChars) {
        return partial("Text cap reached.", lines.join("\n"), blockCount, {
          blockId: frame.blockId,
          cursor: page.next_cursor ?? frame.cursor,
          depth: frame.depth,
        });
      }
      if (text) {
        lines.push(text);
        chars += text.length;
      }
      if (record.has_children === true) {
        const child = { blockId, cursor: null, depth: frame.depth + 1 };
        if (child.depth > limits.maxDepth) {
          return partial("Nested blocks exceed the depth cap.", lines.join("\n"), blockCount, child);
        }
        queue.push(child);
      }
    }
    if (page.has_more) {
      if (!page.next_cursor) {
        return partial("Notion reported more blocks without a cursor.", lines.join("\n"), blockCount, frame);
      }
      queue.unshift({ blockId: frame.blockId, cursor: page.next_cursor, depth: frame.depth });
    }
  }

  return { text: lines.join("\n"), blockCount, completeness: "complete" };
}

export function paragraphBlocks(body: string, maxBlocks = 20): unknown[] {
  const chunks: string[] = [];
  let rest = body;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 2000));
    rest = rest.slice(2000);
  }
  if (chunks.length > maxBlocks) {
    throw new ScopeError("Notion body exceeds the block cap. Split the write.");
  }
  return chunks.map((content) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  }));
}

export function findTitleProperty(properties: unknown): string | null {
  if (typeof properties !== "object" || properties === null) return null;
  for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && (value as { type?: string }).type === "title") return name;
  }
  return null;
}
