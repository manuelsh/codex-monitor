import {
  describePendingRequest,
  isoNow,
  previewText,
  toIsoDate
} from "../../shared/monitor";

export { describePendingRequest, isoNow, previewText, toIsoDate };

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function getNestedString(
  source: Record<string, unknown> | null,
  ...path: string[]
): string | null {
  let current: unknown = source;
  for (const segment of path) {
    current = asRecord(current)?.[segment];
  }

  return asString(current);
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function stableId(value: string | number): string {
  return String(value);
}
