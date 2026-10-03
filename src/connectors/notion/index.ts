import { Client } from "@notionhq/client";
import {
  allowedNotionDataSources,
  allowedNotionDatabases,
  allowedNotionPages,
  assertAllowedId,
} from "../../config/allowlist.ts";
import { credentialFor, secretValues } from "../../config/loadEnv.ts";
import type { ConnectorResult, LoadedClient } from "../../types/index.ts";
import { ScopeError } from "../../utils/errors.ts";
import { runOperation } from "../../utils/result.ts";
import { withRetry } from "../../utils/retry.ts";
import {
  collectBlockText,
  findTitleProperty,
  NOTION_READ_LIMITS,
  paragraphBlocks,
  type BlockListPage,
} from "./blocks.ts";

export interface NotionCreateInput {
  title: string;
  body?: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  parentDataSourceId?: string;
  titlePropertyName?: string;
  properties?: Record<string, unknown>;
}

export interface NotionAppendInput {
  pageId: string;
  body: string;
}

export interface NotionUpdateInput {
  pageId: string;
  properties: Record<string, unknown>;
}

export interface NotionApi {
  users: { me: (args: Record<string, never>) => Promise<unknown> };
  search: (args: { query: string; page_size: number }) => Promise<{ results: unknown[] }>;
  pages: {
    retrieve: (args: { page_id: string }) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
  blocks: {
    children: {
      list: (args: { block_id: string; page_size: number; start_cursor?: string }) => Promise<BlockListPage>;
      append?: (args: { block_id: string; children: unknown[] }) => Promise<unknown>;
    };
  };
  databases?: { retrieve: (args: { database_id: string }) => Promise<unknown> };
  dataSources?: { retrieve: (args: { data_source_id: string }) => Promise<unknown> };
}

function titleProperty(title: string) {
  return { title: [{ type: "text" as const, text: { content: title } }] };
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

function simplifyPage(page: unknown, retrievedAt: string): Record<string, unknown> {
  if (typeof page !== "object" || page === null) return { raw: page, retrievedAt };
  const record = page as Record<string, unknown>;
  return {
    id: record.id,
    url: record.url,
    object: record.object,
    title: pageTitle(record),
    properties: record.properties ?? {},
    retrievedAt,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Operation cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function defaultNotionClient(token: string): NotionApi {
  return new Client({
    auth: token,
    retry: false,
    logger: () => {},
  }) as unknown as NotionApi;
}

export class NotionConnector {
  constructor(
    private client: NotionApi,
    private loaded: LoadedClient,
  ) {}

  private meta(operation: string) {
    return { client: this.loaded.slug, system: "notion", operation };
  }

  private secrets(): string[] {
    return secretValues(this.loaded.secrets);
  }

  async health(signal?: AbortSignal): Promise<ConnectorResult<{ status: string; user?: string }>> {
    return runOperation(this.meta("health"), this.secrets(), async () => {
      throwIfAborted(signal);
      const me = await withRetry(() => this.client.users.me({}), { idempotent: true, signal });
      const user =
        typeof me === "object" && me !== null && "name" in me && typeof me.name === "string"
          ? me.name
          : typeof me === "object" && me !== null && "id" in me && typeof me.id === "string"
            ? me.id
            : "bot";
      return { status: "ok", user };
    });
  }

  async find(query: string, signal?: AbortSignal): Promise<ConnectorResult<Record<string, unknown>[]>> {
    return runOperation(
      this.meta("find"),
      this.secrets(),
      async () => {
        throwIfAborted(signal);
        const result = await withRetry(() => this.client.search({ query, page_size: 10 }), {
          idempotent: true,
          signal,
        });
        return result.results.map((page) => simplifyPage(page, new Date().toISOString()));
      },
      { completeness: "partial" },
    );
  }

  async read(
    pageId: string,
    signal?: AbortSignal,
  ): Promise<
    ConnectorResult<{
      page: Record<string, unknown>;
      text: string;
      continuation?: { blockId: string; cursor: string | null; depth: number };
      partialReason?: string;
    }>
  > {
    const result = await runOperation(this.meta("read"), this.secrets(), async () => {
      assertAllowedId(allowedNotionPages(this.loaded.profile), pageId, "Notion page");
      throwIfAborted(signal);
      const page = await withRetry(() => this.client.pages.retrieve({ page_id: pageId }), {
        idempotent: true,
        signal,
      });
      const retrievedAt = new Date().toISOString();
      const collected = await collectBlockText(
        (blockId, cursor, pageSignal) =>
          withRetry(
            () =>
              this.client.blocks.children.list({
                block_id: blockId,
                page_size: NOTION_READ_LIMITS.pageSize,
                start_cursor: cursor,
              }),
            { idempotent: true, signal: pageSignal },
          ),
        pageId,
        signal,
      );
      return {
        page: simplifyPage(page, retrievedAt),
        text: collected.text,
        continuation: collected.continuation,
        partialReason: collected.reason,
        completeness: collected.completeness,
      };
    });
    if (!result.ok) return result;
    const url = result.data.page.url;
    return {
      ...result,
      completeness: result.data.completeness,
      links: typeof url === "string" ? [url] : undefined,
    };
  }

  private async titleKey(input: NotionCreateInput, signal?: AbortSignal): Promise<string> {
    if (input.titlePropertyName) return input.titlePropertyName;
    if (input.parentPageId) return "title";
    throwIfAborted(signal);
    let schema: unknown;
    if (input.parentDataSourceId) {
      const dataSources = this.client.dataSources;
      if (!dataSources) throw new ScopeError("Could not discover the Notion title property. Name it explicitly.");
      schema = await withRetry(() => dataSources.retrieve({ data_source_id: input.parentDataSourceId as string }), {
        idempotent: true,
        signal,
      });
    } else {
      const databases = this.client.databases;
      if (!databases) throw new ScopeError("Could not discover the Notion title property. Name it explicitly.");
      schema = await withRetry(() => databases.retrieve({ database_id: input.parentDatabaseId as string }), {
        idempotent: true,
        signal,
      });
    }
    const properties =
      typeof schema === "object" && schema !== null ? (schema as { properties?: unknown }).properties : undefined;
    const discovered = findTitleProperty(properties);
    if (!discovered) throw new ScopeError("Could not discover the Notion title property. Name it explicitly.");
    return discovered;
  }

  async create(input: NotionCreateInput, signal?: AbortSignal): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("create"), this.secrets(), async () => {
      const parents = [input.parentDatabaseId, input.parentPageId, input.parentDataSourceId].filter(Boolean);
      if (parents.length !== 1) throw new ScopeError("notion create needs exactly one parent page, database, or data source.");
      if (input.parentDatabaseId) {
        assertAllowedId(allowedNotionDatabases(this.loaded.profile), input.parentDatabaseId, "Notion database");
      } else if (input.parentDataSourceId) {
        assertAllowedId(allowedNotionDataSources(this.loaded.profile), input.parentDataSourceId, "Notion data source");
      } else if (input.parentPageId) {
        assertAllowedId(allowedNotionPages(this.loaded.profile), input.parentPageId, "Notion page");
      }
      const parent = input.parentDatabaseId
        ? { database_id: input.parentDatabaseId }
        : input.parentDataSourceId
          ? { type: "data_source_id", data_source_id: input.parentDataSourceId }
          : { page_id: input.parentPageId as string };
      const titleKey = await this.titleKey(input, signal);
      const children = input.body ? paragraphBlocks(input.body) : undefined;
      throwIfAborted(signal);
      const page = await withRetry(
        () =>
          this.client.pages.create({
            parent,
            properties: { ...(input.properties ?? {}), [titleKey]: titleProperty(input.title) },
            children,
          }),
        { idempotent: false, signal },
      );
      return simplifyPage(page, new Date().toISOString());
    });
  }

  async append(input: NotionAppendInput, signal?: AbortSignal): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("append"), this.secrets(), async () => {
      assertAllowedId(allowedNotionPages(this.loaded.profile), input.pageId, "Notion page");
      if (!input.body.trim()) throw new ScopeError("notion append needs body text.");
      const children = paragraphBlocks(input.body);
      const append = this.client.blocks.children.append;
      if (!append) throw new ScopeError("Notion block append is unavailable.");
      throwIfAborted(signal);
      await withRetry(() => append.call(this.client.blocks.children, { block_id: input.pageId, children }), {
        idempotent: false,
        signal,
      });
      return { id: input.pageId, appendedBlocks: children.length };
    });
  }

  async update(input: NotionUpdateInput, signal?: AbortSignal): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("update"), this.secrets(), async () => {
      assertAllowedId(allowedNotionPages(this.loaded.profile), input.pageId, "Notion page");
      const names = Object.keys(input.properties);
      if (names.length === 0) throw new ScopeError("notion update needs at least one named property.");
      const properties: Record<string, unknown> = {};
      for (const name of names) properties[name] = input.properties[name];
      throwIfAborted(signal);
      const page = await withRetry(
        () => this.client.pages.update({ page_id: input.pageId, properties }),
        { idempotent: false, signal },
      );
      return simplifyPage(page, new Date().toISOString());
    });
  }
}

export function createNotionConnector(
  loaded: LoadedClient,
  factory: (token: string) => NotionApi = defaultNotionClient,
): NotionConnector {
  return new NotionConnector(factory(credentialFor(loaded.secrets, "notion")), loaded);
}
