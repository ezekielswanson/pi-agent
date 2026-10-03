import { allowedAsanaProjects, allowedAsanaTasks, assertAllowedId } from "../../config/allowlist.ts";
import { credentialFor, secretValues } from "../../config/loadEnv.ts";
import type { ConnectorResult, LoadedClient } from "../../types/index.ts";
import { HttpFailure, parseRetryAfter, ScopeError } from "../../utils/errors.ts";
import { runOperation } from "../../utils/result.ts";
import { withRetry } from "../../utils/retry.ts";

const ASANA_API = "https://app.asana.com/api/1.0";
const SEARCH_LIMIT = 10;

export interface AsanaFindInput {
  query: string;
  resourceType?: "task" | "project";
}

export interface AsanaCreateTaskInput {
  name: string;
  notes?: string;
  projectGid?: string;
  workspaceGid?: string;
  assignee?: string;
  dueOn?: string;
}

export interface AsanaUpdateTaskInput {
  taskGid: string;
  name?: string;
  notes?: string;
  completed?: boolean;
  assignee?: string;
  dueOn?: string;
}

interface AsanaErrorBody {
  errors?: Array<{ message?: string }>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AsanaConnector {
  constructor(
    private token: string,
    private loaded: LoadedClient,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private meta(operation: string) {
    return { client: this.loaded.slug, system: "asana", operation };
  }

  private secrets(): string[] {
    return secretValues(this.loaded.secrets);
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    return withRetry(
      async () => {
        const response = await this.fetchImpl(`${ASANA_API}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: options.body === undefined ? undefined : JSON.stringify({ data: options.body }),
          signal: options.signal,
        });
        const json = (await response.json()) as { data?: T } & AsanaErrorBody;
        if (!response.ok) {
          const message = json.errors?.[0]?.message ?? `Asana HTTP ${response.status}`;
          throw new HttpFailure(
            response.status,
            message.slice(0, 200),
            parseRetryAfter(response.headers.get("retry-after")),
            method === "GET",
          );
        }
        return json.data as T;
      },
      { idempotent: method === "GET", signal: options.signal },
    );
  }

  private expectedWorkspace(): string {
    const workspaceGid = this.loaded.profile.asana.workspaceGid;
    if (!workspaceGid) throw new ScopeError("Asana workspaceGid is not set on the client profile.");
    return workspaceGid;
  }

  private async assertProjectInWorkspace(projectGid: string, signal?: AbortSignal): Promise<void> {
    const project = await this.request<{ workspace?: { gid?: string } }>(`/projects/${projectGid}`, { signal });
    if (project.workspace?.gid !== this.expectedWorkspace()) {
      throw new ScopeError("Asana project is not in the active client's workspace.");
    }
  }

  private async assertTaskInWorkspace(taskGid: string, signal?: AbortSignal): Promise<void> {
    const task = await this.request<{
      workspace?: { gid?: string };
      memberships?: Array<{ project?: { gid?: string } }>;
    }>(`/tasks/${taskGid}?opt_fields=workspace,memberships.project`, { signal });
    if (task.workspace?.gid !== this.expectedWorkspace()) {
      throw new ScopeError("Asana task is not in the active client's workspace.");
    }
    const projects = (task.memberships ?? []).map((membership) => membership.project?.gid).filter((gid) => Boolean(gid));
    const allowed = allowedAsanaProjects(this.loaded.profile);
    if (projects.length > 0 && !projects.some((gid) => gid && allowed.has(gid))) {
      throw new ScopeError("Asana task is not in an allowlisted project.");
    }
  }

  async health(signal?: AbortSignal): Promise<ConnectorResult<{ status: string; user?: string }>> {
    return runOperation(this.meta("health"), this.secrets(), async () => {
      const data = await this.request<{ gid?: string; name?: string; email?: string }>("/users/me", { signal });
      return { status: "ok", user: data.name ?? data.email ?? data.gid };
    });
  }

  async find(
    input: AsanaFindInput,
    signal?: AbortSignal,
  ): Promise<
    ConnectorResult<{ items: Array<Record<string, unknown>>; limit: number; truncated: boolean }>
  > {
    const result = await runOperation(this.meta("find"), this.secrets(), async () => {
      const workspaceGid = this.expectedWorkspace();
      const resourceType = input.resourceType ?? "task";
      if (/^\d+$/.test(input.query)) {
        if (resourceType === "task") {
          assertAllowedId(allowedAsanaTasks(this.loaded.profile), input.query, "Asana task");
          await this.assertTaskInWorkspace(input.query, signal);
        }
        if (resourceType === "project") {
          assertAllowedId(allowedAsanaProjects(this.loaded.profile), input.query, "Asana project");
          await this.assertProjectInWorkspace(input.query, signal);
        }
        const path = resourceType === "project" ? `/projects/${input.query}` : `/tasks/${input.query}`;
        const item = await this.request<Record<string, unknown>>(path, { signal });
        return { items: [item], limit: 1, truncated: false, completeness: "complete" as const };
      }
      const params = new URLSearchParams({
        resource_type: resourceType,
        query: input.query,
        count: String(SEARCH_LIMIT),
      });
      const items = await this.request<Array<Record<string, unknown>>>(
        `/workspaces/${workspaceGid}/typeahead?${params.toString()}`,
        { signal },
      );
      const list = Array.isArray(items) ? items : [];
      const truncated = list.length >= SEARCH_LIMIT;
      return {
        items: list,
        limit: SEARCH_LIMIT,
        truncated,
        completeness: truncated ? ("partial" as const) : ("complete" as const),
      };
    });
    if (!result.ok) return result;
    return { ...result, completeness: result.data.completeness };
  }

  async createTask(
    input: AsanaCreateTaskInput,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("create_task"), this.secrets(), async () => {
      if (!input.projectGid) throw new ScopeError("asana create needs a project in this client's allowlist.");
      assertAllowedId(allowedAsanaProjects(this.loaded.profile), input.projectGid, "Asana project");
      await this.assertProjectInWorkspace(input.projectGid, signal);
      const workspaceGid = input.workspaceGid ?? this.loaded.profile.asana.workspaceGid;
      if (input.workspaceGid && input.workspaceGid !== this.loaded.profile.asana.workspaceGid) {
        throw new ScopeError("Asana workspace does not match the active client.");
      }
      const body: Record<string, unknown> = { name: input.name, projects: [input.projectGid] };
      if (input.notes) body.notes = input.notes;
      if (input.assignee) body.assignee = input.assignee;
      if (input.dueOn) body.due_on = input.dueOn;
      if (workspaceGid) body.workspace = workspaceGid;
      return this.request<Record<string, unknown>>("/tasks", { method: "POST", body, signal });
    });
  }

  async updateTask(
    input: AsanaUpdateTaskInput,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("update_task"), this.secrets(), async () => {
      assertAllowedId(allowedAsanaTasks(this.loaded.profile), input.taskGid, "Asana task");
      await this.assertTaskInWorkspace(input.taskGid, signal);
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.notes !== undefined) body.notes = input.notes;
      if (input.completed !== undefined) body.completed = input.completed;
      if (input.assignee !== undefined) body.assignee = input.assignee;
      if (input.dueOn !== undefined) body.due_on = input.dueOn;
      return this.request<Record<string, unknown>>(`/tasks/${input.taskGid}`, { method: "PUT", body, signal });
    });
  }

  async addComment(
    taskGid: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("comment"), this.secrets(), async () => {
      assertAllowedId(allowedAsanaTasks(this.loaded.profile), taskGid, "Asana task");
      await this.assertTaskInWorkspace(taskGid, signal);
      return this.request<Record<string, unknown>>(`/tasks/${taskGid}/stories`, {
        method: "POST",
        body: { text },
        signal,
      });
    });
  }
}

export function createAsanaConnector(loaded: LoadedClient, fetchImpl: FetchLike = fetch): AsanaConnector {
  if (loaded.profile.asana.mode === "disabled") {
    throw new Error("Asana is disabled for this client.");
  }
  if (loaded.profile.asana.mode === "mcp") {
    throw new Error("Asana MCP is not enabled in this runtime. Select rest or disabled for this client.");
  }
  return new AsanaConnector(credentialFor(loaded.secrets, "asana"), loaded, fetchImpl);
}
