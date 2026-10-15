import { PolicyError } from "./errors.ts";

export type Sensitivity = "standard" | "sensitive" | "highly_sensitive" | "unknown";

const CLASSIFIED: Record<string, Exclude<Sensitivity, "unknown">> = {
  company: "standard",
  email: "standard",
  firstname: "standard",
  hs_object_id: "standard",
  lastname: "standard",
  name: "standard",
  phone: "standard",
  hs_ssn: "highly_sensitive",
  ssn: "sensitive",
};

export function classifyProperty(name: string): Sensitivity {
  return CLASSIFIED[name] ?? "unknown";
}

export function objectNameFromPath(path: string): string | null {
  const match = path.match(/\/(?:crm\/)?objects\/(?:[^/]+\/)?([a-z0-9_]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function propertyAllowed(input: {
  property: string;
  objectName: string | null;
  effect: "read" | "mutate";
  grantedScopes: readonly string[];
}): boolean {
  const level = classifyProperty(input.property);
  if (level === "standard") return true;
  if (level === "unknown" || !input.objectName) return false;
  const suffix = level === "highly_sensitive" ? "highly_sensitive" : "sensitive";
  const access = input.effect === "mutate" ? "write" : "read";
  return input.grantedScopes.includes(`crm.objects.${input.objectName}.${suffix}.${access}`);
}

export function filterPropertyList(names: string[], input: Omit<Parameters<typeof propertyAllowed>[0], "property">): string[] {
  return names.filter((property) => propertyAllowed({ ...input, property }));
}

export function filterPropertyBag(
  value: unknown,
  input: Omit<Parameters<typeof propertyAllowed>[0], "property">,
): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => filterPropertyBag(item, input));
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      const bag: Record<string, unknown> = {};
      for (const [property, propertyValue] of Object.entries(child as Record<string, unknown>)) {
        if (propertyAllowed({ ...input, property })) bag[property] = propertyValue;
      }
      output[key] = bag;
      continue;
    }
    output[key] = filterPropertyBag(child, input);
  }
  return output;
}

export function assertRequestedProperties(body: unknown, input: Omit<Parameters<typeof propertyAllowed>[0], "property">): void {
  const rejected = [...new Set(requestedPropertyNames(body))].filter((property) => !propertyAllowed({ ...input, property }));
  if (rejected.length > 0) {
    throw new PolicyError(`Properties are not granted for this object: ${rejected.join(", ")}.`, "scope");
  }
}

export function assertWritableProperties(body: unknown, input: Omit<Parameters<typeof propertyAllowed>[0], "property">): void {
  const rejected: string[] = [];
  walk(body, (property) => {
    if (!propertyAllowed({ ...input, property })) rejected.push(property);
  });
  if (rejected.length > 0) {
    throw new PolicyError(`Properties are not granted for this object: ${rejected.join(", ")}.`, "scope");
  }
}

function requestedPropertyNames(value: unknown): string[] {
  const names: string[] = [];
  walkRequested(value, names);
  return names;
}

function walkRequested(value: unknown, names: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkRequested(item, names);
    return;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.properties)) {
    for (const item of record.properties) {
      if (typeof item === "string") names.push(item);
    }
  }
  if (typeof record.propertyName === "string") names.push(record.propertyName);
  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && !Array.isArray(child)) continue;
    walkRequested(child, names);
  }
}

function walk(value: unknown, visit: (property: string) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const property of Object.keys(record.properties as Record<string, unknown>)) visit(property);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key !== "properties") walk(child, visit);
  }
}
