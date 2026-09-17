import type { ClientScopedConnector, ConnectorResult } from "../../types/index.ts";
import { errorMessage, logCall, withRetry } from "../../utils/index.ts";

const ASANA_API = "https://app.asana.com/api/1.0";

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

export class AsanaConnector implements ClientScopedConnector {
  constructor(
    private token: string,
    private defaultWorkspaceGid: string | null = null,
  ) {}

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<ConnectorResult<T>> {
    try {
      const result = await withRetry(async () => {
        const response = await fetch(`${ASANA_API}${path}`, {
          method: options.method ?? "GET",
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
          throw new Error(json.errors?.[0]?.message ?? `Asana HTTP ${response.status}`);
        }
        return json.data as T;
      });
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async health(signal?: AbortSignal): Promise<ConnectorResult<{ status: string; user?: string }>> {
    const result = await this.request<{ gid?: string; name?: string; email?: string }>("/users/me", {
      signal,
    });
    if (!result.ok) {
      logCall("asana", "health", { ok: false, error: result.error });
      return result;
    }
    const user = result.data.name ?? result.data.email ?? result.data.gid;
    logCall("asana", "health", { ok: true, user });
    return { ok: true, data: { status: "ok", user } };
  }

  async find(
    input: AsanaFindInput,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>> {
    const resourceType = input.resourceType ?? "task";
    const workspaceGid = this.defaultWorkspaceGid;
    if (!workspaceGid) {
      return { ok: false, error: "Asana workspaceGid is not set on the client profile." };
    }

    if (/^\d+$/.test(input.query)) {
      const path = resourceType === "project" ? `/projects/${input.query}` : `/tasks/${input.query}`;
      const found = await this.request<Record<string, unknown>>(path, { signal });
      if (!found.ok) {
        logCall("asana", "find", { query: input.query, error: found.error });
        return found;
      }
      logCall("asana", "find", { query: input.query, count: 1 });
      return { ok: true, data: [found.data] };
    }

    const params = new URLSearchParams({
      resource_type: resourceType,
      query: input.query,
      count: "10",
    });
    const result = await this.request<Array<Record<string, unknown>>>(
      `/workspaces/${workspaceGid}/typeahead?${params.toString()}`,
      { signal },
    );
    if (!result.ok) {
      logCall("asana", "find", { query: input.query, error: result.error });
      return result;
    }
    logCall("asana", "find", { query: input.query, count: result.data.length });
    return result;
  }

  async createTask(
    input: AsanaCreateTaskInput,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    const workspaceGid = input.workspaceGid ?? this.defaultWorkspaceGid;
    if (!workspaceGid && !input.projectGid) {
      return { ok: false, error: "asana_create_task needs a projectGid or workspaceGid." };
    }

    const body: Record<string, unknown> = { name: input.name };
    if (input.notes) body.notes = input.notes;
    if (input.assignee) body.assignee = input.assignee;
    if (input.dueOn) body.due_on = input.dueOn;
    if (input.projectGid) body.projects = [input.projectGid];
    if (workspaceGid) body.workspace = workspaceGid;

    const result = await this.request<Record<string, unknown>>("/tasks", {
      method: "POST",
      body,
      signal,
    });
    logCall("asana", "create_task", {
      name: input.name,
      ok: result.ok,
      gid: result.ok ? result.data.gid : undefined,
      error: result.ok ? undefined : result.error,
    });
    return result;
  }

  async updateTask(
    input: AsanaUpdateTaskInput,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.notes !== undefined) body.notes = input.notes;
    if (input.completed !== undefined) body.completed = input.completed;
    if (input.assignee !== undefined) body.assignee = input.assignee;
    if (input.dueOn !== undefined) body.due_on = input.dueOn;

    const result = await this.request<Record<string, unknown>>(`/tasks/${input.taskGid}`, {
      method: "PUT",
      body,
      signal,
    });
    logCall("asana", "update_task", {
      taskGid: input.taskGid,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });
    return result;
  }

  async addComment(
    taskGid: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    const result = await this.request<Record<string, unknown>>(`/tasks/${taskGid}/stories`, {
      method: "POST",
      body: { text },
      signal,
    });
    logCall("asana", "comment", {
      taskGid,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });
    return result;
  }
}

export function createAsanaConnector(
  token = process.env.ASANA_ACCESS_TOKEN,
  workspaceGid: string | null = null,
): AsanaConnector {
  if (!token) {
    throw new Error("ASANA_ACCESS_TOKEN is not set. Add it to clients/<slug>/.env");
  }
  return new AsanaConnector(token, workspaceGid);
}
