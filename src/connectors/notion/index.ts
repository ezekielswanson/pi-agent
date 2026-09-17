import { Client } from "@notionhq/client";
import type { ClientScopedConnector, ConnectorResult } from "../../types/index.ts";
import { errorMessage, logCall, withRetry } from "../../utils/index.ts";

export interface NotionCreateInput {
  title: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  titlePropertyName?: string;
  properties?: Record<string, unknown>;
}

export interface NotionUpdateInput {
  pageId: string;
  properties: Record<string, unknown>;
}

function titleProperty(title: string) {
  return {
    title: [{ type: "text" as const, text: { content: title } }],
  };
}

function pageTitle(page: Record<string, unknown>): string {
  const properties = page.properties;
  if (typeof properties !== "object" || properties === null) return "";
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const prop = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (prop.type === "title") {
      return (prop.title ?? []).map((part) => part.plain_text ?? "").join("");
    }
  }
  return "";
}

function simplifyPage(page: unknown): Record<string, unknown> {
  if (typeof page !== "object" || page === null) return { raw: page };
  const record = page as Record<string, unknown>;
  return {
    id: record.id,
    url: record.url,
    object: record.object,
    title: pageTitle(record),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted");
}

function blockText(blocks: unknown[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const payload = record[type];
    if (typeof payload !== "object" || payload === null) continue;
    const richText = (payload as { rich_text?: Array<{ plain_text?: string }> }).rich_text;
    if (!richText) continue;
    const text = richText.map((part) => part.plain_text ?? "").join("");
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

export class NotionConnector implements ClientScopedConnector {
  constructor(private client: Client) {}

  async health(signal?: AbortSignal): Promise<ConnectorResult<{ status: string; user?: string }>> {
    try {
      throwIfAborted(signal);
      const me = await withRetry(() => this.client.users.me({}));
      const user =
        "name" in me && typeof me.name === "string"
          ? me.name
          : "id" in me && typeof me.id === "string"
            ? me.id
            : "bot";
      logCall("notion", "health", { ok: true, user });
      return { ok: true, data: { status: "ok", user } };
    } catch (err) {
      const error = errorMessage(err);
      logCall("notion", "health", { ok: false, error });
      return { ok: false, error };
    }
  }

  async find(query: string, signal?: AbortSignal): Promise<ConnectorResult<Record<string, unknown>[]>> {
    try {
      throwIfAborted(signal);
      const result = await withRetry(() => this.client.search({ query, page_size: 10 }));
      const items = result.results.map((page) => simplifyPage(page));
      logCall("notion", "find", { query, count: items.length });
      return { ok: true, data: items };
    } catch (err) {
      const error = errorMessage(err);
      logCall("notion", "find", { query, error });
      return { ok: false, error };
    }
  }

  async read(
    pageId: string,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<{ page: Record<string, unknown>; text: string }>> {
    try {
      throwIfAborted(signal);
      const page = await withRetry(() => this.client.pages.retrieve({ page_id: pageId }));
      const blocks = await withRetry(() =>
        this.client.blocks.children.list({ block_id: pageId, page_size: 50 }),
      );
      const data = { page: simplifyPage(page), text: blockText(blocks.results as unknown[]) };
      logCall("notion", "read", { pageId, title: data.page.title });
      return { ok: true, data };
    } catch (err) {
      const error = errorMessage(err);
      logCall("notion", "read", { pageId, error });
      return { ok: false, error };
    }
  }

  async create(input: NotionCreateInput, signal?: AbortSignal): Promise<ConnectorResult<Record<string, unknown>>> {
    try {
      const parent = input.parentDatabaseId
        ? { database_id: input.parentDatabaseId }
        : input.parentPageId
          ? { page_id: input.parentPageId }
          : null;
      if (!parent) {
        return { ok: false, error: "notion_create needs parentPageId or parentDatabaseId." };
      }

      const titleKey = input.parentDatabaseId
        ? (input.titlePropertyName ?? "Name")
        : (input.titlePropertyName ?? "title");
      const properties = {
        ...(input.properties ?? {}),
        [titleKey]: titleProperty(input.title),
      };

      throwIfAborted(signal);
      const page = await withRetry(() =>
        this.client.pages.create({
          parent,
          properties: properties as never,
        }),
      );
      const data = simplifyPage(page);
      logCall("notion", "create", { title: input.title, id: data.id });
      return { ok: true, data };
    } catch (err) {
      const error = errorMessage(err);
      logCall("notion", "create", { title: input.title, error });
      return { ok: false, error };
    }
  }

  async update(input: NotionUpdateInput, signal?: AbortSignal): Promise<ConnectorResult<Record<string, unknown>>> {
    try {
      throwIfAborted(signal);
      const page = await withRetry(() =>
        this.client.pages.update({ page_id: input.pageId, properties: input.properties as never }),
      );
      const data = simplifyPage(page);
      logCall("notion", "update", { pageId: input.pageId, id: data.id });
      return { ok: true, data };
    } catch (err) {
      const error = errorMessage(err);
      logCall("notion", "update", { pageId: input.pageId, error });
      return { ok: false, error };
    }
  }
}

export function createNotionConnector(token = process.env.NOTION_TOKEN): NotionConnector {
  if (!token) {
    throw new Error("NOTION_TOKEN is not set. Add it to clients/<slug>/.env");
  }
  return new NotionConnector(new Client({ auth: token }));
}
