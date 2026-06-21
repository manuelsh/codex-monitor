import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_JOB_SORT_KEYS,
  SOURCE_KINDS,
  previewText,
  type HistoryJob,
  type HistoryJobListResponse,
  type HistoryJobSortKey,
  type SourceKind,
  type SortDirection,
  type TokenUsage
} from "../../shared/monitor";
import { asRecord, asString, cloneValue, toIsoDate } from "./utils";

type SessionFile = {
  path: string;
  mtimeMs: number;
  size: number;
};

type CachedHistoryJob = {
  mtimeMs: number;
  size: number;
  job: HistoryJob | null;
};

export type HistoryJobMetadata = Partial<
  Pick<
    HistoryJob,
    | "name"
    | "preview"
    | "sourceKind"
    | "createdAt"
    | "updatedAt"
    | "cwd"
    | "modelProvider"
  >
>;

type ParsedTurn = {
  id: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
};

const ACTIVE_OPEN_TURN_WINDOW_MS = 15 * 60 * 1000;

export class HistoryJobReader {
  private readonly cache = new Map<string, CachedHistoryJob>();

  public constructor(private readonly sessionsRoot = resolveCodexSessionsRoot()) {}

  public listJobs(args: {
    cursor?: string | null;
    limit?: number | null;
    sourceKinds?: string[] | null;
    searchTerm?: string | null;
    sortKey?: string | null;
    sortDirection?: string | null;
    metadataById?: Map<string, HistoryJobMetadata> | null;
    nowMs?: number;
  }): HistoryJobListResponse {
    const nowMs = args.nowMs ?? Date.now();
    const sessionFiles = listSessionFiles(this.sessionsRoot);
    const activePaths = new Set(sessionFiles.map((file) => file.path));

    for (const cachedPath of this.cache.keys()) {
      if (!activePaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
      }
    }

    const sourceKindSet =
      args.sourceKinds && args.sourceKinds.length > 0
        ? new Set(args.sourceKinds)
        : null;
    const searchTerm = args.searchTerm?.trim().toLocaleLowerCase() ?? "";
    const offset = Math.max(0, Number.parseInt(args.cursor ?? "0", 10) || 0);
    const limit = clampInteger(args.limit ?? 20, 1, 100);
    const sortKey = normalizeSortKey(args.sortKey);
    const sortDirection = normalizeSortDirection(args.sortDirection);

    const jobs = sessionFiles
      .map((file) => this.readJob(file, nowMs))
      .filter((job): job is HistoryJob => Boolean(job))
      .map((job) => applyMetadata(job, args.metadataById?.get(job.id)))
      .filter((job) => !sourceKindSet || sourceKindSet.has(job.sourceKind))
      .filter((job) => matchesSearch(job, searchTerm))
      .sort((left, right) =>
        compareHistoryJobs(left, right, sortKey, sortDirection)
      );

    return {
      data: jobs.slice(offset, offset + limit),
      total: jobs.length,
      nextCursor: offset + limit < jobs.length ? String(offset + limit) : null
    };
  }

  private readJob(file: SessionFile, nowMs: number): HistoryJob | null {
    const cached = this.cache.get(file.path);
    if (
      cached &&
      cached.mtimeMs === file.mtimeMs &&
      cached.size === file.size &&
      !hasRecentOpenTurn(cached.job, nowMs)
    ) {
      return cloneValue(cached.job);
    }

    let fileContent = "";
    try {
      fileContent = readFileSync(file.path, "utf8");
    } catch {
      this.cache.set(file.path, {
        mtimeMs: file.mtimeMs,
        size: file.size,
        job: null
      });
      return null;
    }

    const job = parseHistorySessionFile({
      sessionId: extractSessionId(file.path),
      fileContent,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      nowMs
    });

    this.cache.set(file.path, {
      mtimeMs: file.mtimeMs,
      size: file.size,
      job
    });
    return cloneValue(job);
  }
}

function applyMetadata(
  job: HistoryJob,
  metadata: HistoryJobMetadata | undefined
): HistoryJob {
  if (!metadata) {
    return job;
  }

  return {
    ...job,
    name: metadata.name ?? job.name,
    preview: metadata.preview ?? job.preview,
    sourceKind: metadata.sourceKind ?? job.sourceKind,
    createdAt: metadata.createdAt ?? job.createdAt,
    updatedAt: metadata.updatedAt ?? job.updatedAt,
    cwd: metadata.cwd ?? job.cwd,
    modelProvider: metadata.modelProvider ?? job.modelProvider
  };
}

export function parseHistorySessionFile(args: {
  sessionId: string | null;
  fileContent: string;
  updatedAt: string;
  nowMs: number;
}): HistoryJob | null {
  let sessionId = args.sessionId;
  let name: string | null = null;
  let preview: string | null = null;
  let sourceKind: SourceKind | "unknown" = "unknown";
  let createdAtMs: number | null = null;
  let fallbackUpdatedAtMs = Date.parse(args.updatedAt);
  if (!Number.isFinite(fallbackUpdatedAtMs)) {
    fallbackUpdatedAtMs = args.nowMs;
  }
  let latestRecordTimestampMs: number | null = null;
  let cwd: string | null = null;
  let modelProvider: string | null = null;
  let lastRunUsage: TokenUsage | null = null;
  let totalUsage: TokenUsage | null = null;
  let latestTurnId: string | null = null;
  const turns = new Map<string, ParsedTurn>();

  for (const rawLine of args.fileContent.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }

    const record = asRecord(parsed);
    if (!record) {
      continue;
    }

    const recordTimestampMs = parseDateMs(record.timestamp);
    if (recordTimestampMs !== null) {
      latestRecordTimestampMs =
        latestRecordTimestampMs === null
          ? recordTimestampMs
          : Math.max(latestRecordTimestampMs, recordTimestampMs);
      createdAtMs =
        createdAtMs === null
          ? recordTimestampMs
          : Math.min(createdAtMs, recordTimestampMs);
    }

    const recordType = asString(record.type);
    const payload = asRecord(record.payload);

    if (recordType === "session_meta") {
      sessionId = asString(payload?.id) ?? sessionId;
      name = asString(payload?.name) ?? name;
      cwd = asString(payload?.cwd) ?? cwd;
      modelProvider =
        asString(payload?.model_provider) ??
        asString(payload?.modelProvider) ??
        modelProvider;
      sourceKind =
        normalizeSourceKind(payload?.source) ??
        normalizeOriginator(payload?.originator) ??
        sourceKind;
      createdAtMs =
        parseDateMs(payload?.timestamp) ?? parseDateMs(record.timestamp) ?? createdAtMs;
      continue;
    }

    if (recordType === "turn_context") {
      cwd = asString(payload?.cwd) ?? cwd;
      modelProvider =
        asString(payload?.model_provider) ??
        asString(payload?.modelProvider) ??
        modelProvider;
      continue;
    }

    if (recordType === "response_item") {
      if (isUserMessage(payload)) {
        preview = extractUserPreview(payload) ?? preview;
      }
      continue;
    }

    if (recordType !== "event_msg") {
      continue;
    }

    const payloadType = asString(payload?.type);

    if (payloadType === "task_started") {
      const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
      if (!turnId) {
        continue;
      }

      const turn = ensureTurn(turns, turnId);
      turn.startedAtMs = recordTimestampMs ?? turn.startedAtMs;
      latestTurnId = turnId;
      continue;
    }

    if (payloadType === "task_complete" || payloadType === "turn_aborted") {
      const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
      if (!turnId) {
        continue;
      }

      const turn = ensureTurn(turns, turnId);
      turn.completedAtMs =
        parseDateMs(payload?.completed_at) ??
        parseDateMs(payload?.completedAt) ??
        recordTimestampMs ??
        turn.completedAtMs;
      turn.durationMs = asFiniteNumber(payload?.duration_ms) ?? turn.durationMs;
      latestTurnId = turnId;
      continue;
    }

    if (payloadType === "token_count") {
      const info = asRecord(payload?.info);
      totalUsage = normalizeTokenUsage(info?.total_token_usage) ?? totalUsage;
      lastRunUsage = normalizeTokenUsage(info?.last_token_usage) ?? lastRunUsage;
    }
  }

  if (!sessionId) {
    return null;
  }

  const sortedTurns = [...turns.values()].sort((left, right) => {
    return turnSortMs(left) - turnSortMs(right);
  });
  const latestTurn =
    (latestTurnId ? turns.get(latestTurnId) : null) ??
    sortedTurns[sortedTurns.length - 1] ??
    null;
  const activityUpdatedAtMs = latestRecordTimestampMs ?? fallbackUpdatedAtMs;
  const totalDurationMs = sortedTurns.reduce(
    (total, turn) =>
      total + (durationForTurn(turn, args.nowMs, activityUpdatedAtMs) ?? 0),
    0
  );

  return {
    id: sessionId,
    name,
    preview,
    sourceKind,
    createdAt: createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
    updatedAt: new Date(activityUpdatedAtMs).toISOString(),
    cwd,
    modelProvider,
    runCount: sortedTurns.length,
    lastRunStartedAt:
      latestTurn?.startedAtMs === null || latestTurn?.startedAtMs === undefined
        ? null
        : new Date(latestTurn.startedAtMs).toISOString(),
    lastRunCompletedAt:
      latestTurn?.completedAtMs === null || latestTurn?.completedAtMs === undefined
        ? null
        : new Date(latestTurn.completedAtMs).toISOString(),
    lastRunDurationMs: latestTurn
      ? durationForTurn(latestTurn, args.nowMs, activityUpdatedAtMs)
      : null,
    totalDurationMs,
    lastRunUsage,
    totalUsage
  };
}

export function resolveCodexSessionsRoot(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const codexHome = env.CODEX_HOME ?? path.join(homeDir, ".codex");
  return path.join(codexHome, "sessions");
}

function listSessionFiles(root: string): SessionFile[] {
  if (!existsSync(root)) {
    return [];
  }

  const results: SessionFile[] = [];
  walkDirectory(root, results);
  return results.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function walkDirectory(directory: string, results: SessionFile[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(fullPath, results);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    try {
      const stats = statSync(fullPath);
      results.push({
        path: fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size
      });
    } catch {
      continue;
    }
  }
}

function ensureTurn(turns: Map<string, ParsedTurn>, turnId: string): ParsedTurn {
  const existing = turns.get(turnId);
  if (existing) {
    return existing;
  }

  const turn: ParsedTurn = {
    id: turnId,
    startedAtMs: null,
    completedAtMs: null,
    durationMs: null
  };
  turns.set(turnId, turn);
  return turn;
}

function durationForTurn(
  turn: ParsedTurn,
  nowMs: number,
  sessionUpdatedAtMs: number
): number | null {
  if (turn.durationMs !== null) {
    return Math.max(0, turn.durationMs);
  }

  if (turn.startedAtMs === null) {
    return null;
  }

  const openTurnEndMs =
    nowMs - sessionUpdatedAtMs <= ACTIVE_OPEN_TURN_WINDOW_MS
      ? nowMs
      : sessionUpdatedAtMs;
  const endMs = turn.completedAtMs ?? openTurnEndMs;
  return Math.max(0, endMs - turn.startedAtMs);
}

function hasRecentOpenTurn(job: HistoryJob | null, nowMs: number): boolean {
  if (!job || job.lastRunCompletedAt || !job.lastRunStartedAt) {
    return false;
  }

  const updatedAtMs = Date.parse(job.updatedAt);
  return Number.isFinite(updatedAtMs)
    ? nowMs - updatedAtMs <= ACTIVE_OPEN_TURN_WINDOW_MS
    : false;
}

function turnSortMs(turn: ParsedTurn): number {
  return turn.startedAtMs ?? turn.completedAtMs ?? 0;
}

function matchesSearch(job: HistoryJob, searchTerm: string): boolean {
  if (!searchTerm) {
    return true;
  }

  return [job.name, job.preview, job.cwd, job.id, job.modelProvider]
    .filter((entry): entry is string => Boolean(entry))
    .some((entry) => entry.toLocaleLowerCase().includes(searchTerm));
}

function compareHistoryJobs(
  left: HistoryJob,
  right: HistoryJob,
  sortKey: HistoryJobSortKey,
  sortDirection: SortDirection
): number {
  const primary = compareNullableNumbers(
    sortValue(left, sortKey),
    sortValue(right, sortKey),
    sortDirection
  );

  if (primary !== 0) {
    return primary;
  }

  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }

  return left.id.localeCompare(right.id);
}

function sortValue(job: HistoryJob, sortKey: HistoryJobSortKey): number | null {
  switch (sortKey) {
    case "createdAt":
      return dateValue(job.createdAt);
    case "lastRunDurationMs":
      return job.lastRunDurationMs;
    case "totalDurationMs":
      return job.totalDurationMs;
    case "lastRunTokens":
      return job.lastRunUsage?.totalTokens ?? null;
    case "totalTokens":
      return job.totalUsage?.totalTokens ?? null;
    case "runCount":
      return job.runCount;
    case "updatedAt":
    default:
      return dateValue(job.updatedAt);
  }
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  sortDirection: SortDirection
): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return sortDirection === "asc" ? left - right : right - left;
}

function dateValue(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUserMessage(payload: Record<string, unknown> | null): boolean {
  return asString(payload?.type) === "message" && asString(payload?.role) === "user";
}

function extractUserPreview(payload: Record<string, unknown> | null): string | null {
  const content = payload?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const pieces = content
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => asString(entry.type) === "input_text")
    .map((entry) => asString(entry.text))
    .filter((entry): entry is string => Boolean(entry));

  return previewText(pieces.join("\n\n"), 240);
}

function normalizeTokenUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const inputTokens = asFiniteNumber(record.input_tokens) ?? 0;
  const cachedInputTokens = asFiniteNumber(record.cached_input_tokens) ?? 0;
  const outputTokens = asFiniteNumber(record.output_tokens) ?? 0;
  const reasoningOutputTokens = asFiniteNumber(record.reasoning_output_tokens) ?? 0;
  const totalTokens =
    asFiniteNumber(record.total_tokens) ?? inputTokens + outputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function normalizeSourceKind(value: unknown): SourceKind | "unknown" | null {
  const asKind = sourceKindFromString(asString(value));
  if (asKind) {
    return asKind;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.cli) {
    return "cli";
  }

  if (record.vscode) {
    return "vscode";
  }

  if (record.exec) {
    return "exec";
  }

  if (record.appServer || record.app_server || record.app) {
    return "appServer";
  }

  const subagent = asRecord(record.subagent) ?? asRecord(record.subAgent);
  if (subagent) {
    if (subagent.review) {
      return "subAgentReview";
    }
    if (subagent.compact) {
      return "subAgentCompact";
    }
    if (subagent.threadSpawn || subagent.thread_spawn) {
      return "subAgentThreadSpawn";
    }
    return "subAgentOther";
  }

  return null;
}

function normalizeOriginator(value: unknown): SourceKind | "unknown" | null {
  const originator = asString(value)?.toLocaleLowerCase();
  if (!originator) {
    return null;
  }

  if (originator.includes("cli")) {
    return "cli";
  }

  if (originator.includes("vscode") || originator.includes("vs code")) {
    return "vscode";
  }

  if (originator.includes("desktop")) {
    return "appServer";
  }

  return null;
}

function sourceKindFromString(value: string | null): SourceKind | "unknown" | null {
  if (!value) {
    return null;
  }

  return (SOURCE_KINDS as readonly string[]).includes(value)
    ? (value as SourceKind)
    : null;
}

function normalizeSortKey(value: string | null | undefined): HistoryJobSortKey {
  return value && (HISTORY_JOB_SORT_KEYS as readonly string[]).includes(value)
    ? (value as HistoryJobSortKey)
    : "updatedAt";
}

function normalizeSortDirection(
  value: string | null | undefined
): SortDirection {
  return value === "asc" ? "asc" : "desc";
}

function parseDateMs(value: unknown): number | null {
  const isoValue = toIsoDate(value);
  if (!isoValue) {
    return null;
  }

  const parsed = Date.parse(isoValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function extractSessionId(filePath: string): string | null {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match?.[1] ?? null;
}
