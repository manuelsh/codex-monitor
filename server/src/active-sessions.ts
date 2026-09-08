import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ActiveSession } from "../../shared/monitor";
import { asRecord, asString } from "./utils";
import { userPreview } from "../../shared/session-preview";

const DEFAULT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

type CachedSessionState = {
  mtimeMs: number;
  size: number;
  session: ActiveSession | null;
};

export class ActiveSessionTracker {
  private readonly cache = new Map<string, CachedSessionState>();

  public constructor(
    private readonly sessionsRoot = resolveCodexSessionsRoot(),
    private readonly activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS
  ) {}

  public listActiveSessions(nowMs = Date.now()): ActiveSession[] {
    const sessionFiles = listSessionFiles(this.sessionsRoot);
    const activePaths = new Set(sessionFiles.map((file) => file.path));

    for (const cachedPath of this.cache.keys()) {
      if (!activePaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
      }
    }

    return sessionFiles
      .map((file) => this.readActiveSession(file.path, file.mtimeMs, file.size, nowMs))
      .filter((session): session is ActiveSession => Boolean(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private readActiveSession(
    filePath: string,
    mtimeMs: number,
    size: number,
    nowMs: number
  ): ActiveSession | null {
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.session && nowMs - Date.parse(cached.session.updatedAt) <= this.activeWindowMs
        ? cached.session : null;
    }

    const sessionId = extractSessionId(filePath);
    if (!sessionId) {
      this.cache.set(filePath, { mtimeMs, size, session: null });
      return null;
    }

    let fileContent = "";
    try {
      fileContent = readFileSync(filePath, "utf8");
    } catch {
      this.cache.set(filePath, { mtimeMs, size, session: null });
      return null;
    }

    const session = parseActiveSessionFile({
      sessionId,
      fileContent,
      updatedAt: new Date(mtimeMs).toISOString(),
      nowMs,
      activeWindowMs: this.activeWindowMs
    });

    this.cache.set(filePath, { mtimeMs, size, session });
    return session;
  }
}

export function parseActiveSessionFile(args: {
  sessionId: string;
  fileContent: string;
  updatedAt: string;
  nowMs: number;
  activeWindowMs: number;
}): ActiveSession | null {
  let latestTurnId: string | null = null;
  let latestTurnStartedAt: string | null = null;
  const terminalTurnIds = new Set<string>();
  let name: string | null = null;
  let cwd: string | null = null;
  let latestUserInput: string | null = null;
  let latestTimestamp: string | null = null;

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

    const recordType = asString(record.type);
    const payload = asRecord(record.payload);
    const timestamp = asString(record.timestamp);
    if (timestamp && Number.isFinite(Date.parse(timestamp)) &&
        (!latestTimestamp || Date.parse(timestamp) > Date.parse(latestTimestamp))) latestTimestamp = timestamp;

    if (recordType === "session_meta") {
      if (asRecord(payload?.source)?.subagent || asRecord(payload?.source)?.subAgent ||
          asString(payload?.source)?.startsWith("subAgent")) return null;
      name = asString(payload?.name) ?? name;
      cwd = asString(payload?.cwd) ?? cwd;
      continue;
    }

    if (recordType === "turn_context") {
      cwd = asString(payload?.cwd) ?? cwd;
      continue;
    }

    if (recordType === "response_item") {
      const payloadType = asString(payload?.type);
      const role = asString(payload?.role);
      if (payloadType === "message" && role === "user") {
        const nextPreview = payload ? extractUserPreview(payload) : null;
        if (nextPreview) {
          latestUserInput = nextPreview;
        }
      }
      continue;
    }

    if (recordType !== "event_msg") {
      continue;
    }

    const payloadType = asString(payload?.type);
    if (payloadType === "user_message") latestUserInput = userPreview(asString(payload?.message)) ?? latestUserInput;
    const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
    if (payloadType === "task_started" && turnId) {
      latestTurnId = turnId;
      latestTurnStartedAt = asString(record.timestamp) ?? latestTurnStartedAt;
      continue;
    }

    if (
      (payloadType === "task_complete" || payloadType === "turn_aborted") &&
      turnId
    ) {
      terminalTurnIds.add(turnId);
    }
  }

  if (!latestTurnId || terminalTurnIds.has(latestTurnId)) {
    return null;
  }

  const updatedAt = latestTimestamp ?? args.updatedAt;
  const updatedAtMs = Date.parse(updatedAt);
  if (
    Number.isFinite(updatedAtMs) &&
    args.nowMs - updatedAtMs > args.activeWindowMs
  ) {
    return null;
  }

  return {
    id: args.sessionId,
    name,
    preview: latestUserInput,
    cwd,
    createdAt: null,
    updatedAt,
    lastTurnStartedAt: latestTurnStartedAt
  };
}

function extractUserPreview(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const pieces = content
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => asString(entry.type) === "input_text")
    .map((entry) => asString(entry.text))
    .filter((entry): entry is string => Boolean(entry));

  return userPreview(pieces.join("\n\n"));
}

function resolveCodexSessionsRoot(): string {
  const codexHome =
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function listSessionFiles(root: string): Array<{ path: string; mtimeMs: number; size: number }> {
  if (!existsSync(root)) {
    return [];
  }

  const results: Array<{ path: string; mtimeMs: number; size: number }> = [];
  walkDirectory(root, results);
  return results.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function walkDirectory(
  directory: string,
  results: Array<{ path: string; mtimeMs: number; size: number }>
): void {
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
      const stat = statSync(fullPath);
      results.push({
        path: fullPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      });
    } catch {
      continue;
    }
  }
}

function extractSessionId(filePath: string): string | null {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match?.[1] ?? null;
}
