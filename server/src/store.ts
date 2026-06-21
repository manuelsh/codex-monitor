import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTOMATION_POLICY,
  derivePendingRequestKind,
  deriveThreadRuntimeStatus,
  emptyThreadRuntimeStatus,
  type ActiveSession,
  type ActiveShutdownState,
  type GlobalAutomation,
  type MonitorItem,
  type MonitorSnapshot,
  type PendingRequest,
  type RawThreadStatus,
  type Run,
  type RunAutomationPolicy,
  type RunAutomationState,
  type RunSettings,
  type RunSnapshot,
  type ServerConnectionState,
  type ThreadNode,
  type TurnPlanStep,
  type TurnSummary
} from "../../shared/monitor";
import {
  asBoolean,
  asRecord,
  asString,
  asStringArray,
  cloneValue,
  describePendingRequest,
  getNestedString,
  isoNow,
  previewText,
  stableId,
  toIsoDate
} from "./utils";

export class MonitorStore {
  private readonly runs = new Map<string, Run>();
  private readonly threads = new Map<string, ThreadNode>();
  private readonly turns = new Map<string, TurnSummary>();
  private readonly items = new Map<string, MonitorItem>();
  private readonly pendingRequests = new Map<string, PendingRequest>();

  public createRun(rootThreadId: string, request: RunSettings): Run {
    const now = isoNow();
    const run: Run = {
      id: randomUUID(),
      prompt: request.prompt,
      rootThreadId,
      trackedThreadIds: [rootThreadId],
      createdAt: now,
      updatedAt: now,
      status: "running",
      settled: false,
      waitingOnHuman: false,
      settings: cloneValue(request),
      automationPolicy: cloneValue(DEFAULT_AUTOMATION_POLICY),
      automationState: {
        status: "disabled",
        armedAt: null,
        settlesAt: null,
        shutdownAt: null,
        lastAction: null
      }
    };

    this.runs.set(run.id, run);
    const thread = this.ensureThread(rootThreadId);
    thread.runId = run.id;
    thread.parentId = null;
    this.recomputeRun(run.id);
    return cloneValue(run);
  }

  public upsertThreadFromRaw(rawThread: unknown, preferredRunId?: string | null): void {
    const record = asRecord(rawThread);
    const threadId = asString(record?.id);
    if (!threadId) {
      return;
    }

    const thread = this.ensureThread(threadId);
    thread.name = asString(record?.name) ?? thread.name;
    thread.preview = asString(record?.preview) ?? thread.preview;
    thread.sourceKind =
      (asString(record?.sourceKind) as ThreadNode["sourceKind"]) ?? thread.sourceKind;
    thread.cwd = asString(record?.cwd) ?? thread.cwd;
    thread.modelProvider = asString(record?.modelProvider) ?? thread.modelProvider;
    thread.createdAt = toIsoDate(record?.createdAt) ?? thread.createdAt;
    thread.updatedAt = toIsoDate(record?.updatedAt) ?? isoNow();
    thread.ephemeral = asBoolean(record?.ephemeral) ?? thread.ephemeral;
    thread.rawStatus = normalizeRawStatus(record?.status) ?? thread.rawStatus;
    thread.runtimeStatus = deriveThreadRuntimeStatus(
      thread.rawStatus,
      thread.latestTurnStatus,
      thread.latestTurnError
    );
    thread.lastActivityAt = isoNow();

    if (preferredRunId) {
      this.attachThreadToRun(preferredRunId, threadId, thread.parentId);
    } else if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  public applyRpcNotification(message: {
    method: string;
    params?: unknown;
  }): void {
    switch (message.method) {
      case "thread/started":
        this.upsertThreadFromRaw(asRecord(message.params)?.thread);
        break;
      case "thread/status/changed":
        this.applyThreadStatusChanged(
          asString(asRecord(message.params)?.threadId),
          asRecord(message.params)?.status
        );
        break;
      case "thread/closed":
        this.markThreadClosed(asString(asRecord(message.params)?.threadId));
        break;
      case "turn/started":
        this.applyTurnStarted(
          asString(asRecord(message.params)?.threadId),
          asRecord(asRecord(message.params)?.turn)
        );
        break;
      case "turn/completed":
        this.applyTurnCompleted(
          asString(asRecord(message.params)?.threadId),
          asRecord(asRecord(message.params)?.turn)
        );
        break;
      case "turn/diff/updated":
        this.applyTurnDiffUpdated(
          asString(asRecord(message.params)?.threadId),
          asString(asRecord(message.params)?.turnId),
          asString(asRecord(message.params)?.diff)
        );
        break;
      case "turn/plan/updated":
        this.applyTurnPlanUpdated(asRecord(message.params));
        break;
      case "item/started":
        this.applyItemSnapshot(
          asString(asRecord(message.params)?.threadId),
          asString(asRecord(message.params)?.turnId),
          asRecord(message.params)?.item,
          false
        );
        break;
      case "item/completed":
        this.applyItemSnapshot(
          asString(asRecord(message.params)?.threadId),
          asString(asRecord(message.params)?.turnId),
          asRecord(message.params)?.item,
          true
        );
        break;
      case "item/agentMessage/delta":
        this.applyAgentMessageDelta(asRecord(message.params));
        break;
      case "item/commandExecution/outputDelta":
        this.applyCommandOutputDelta(asRecord(message.params));
        break;
      case "serverRequest/resolved":
        this.resolvePendingRequest(resolveRequestId(message.params));
        break;
      default:
        break;
    }
  }

  public applyServerRequest(message: {
    id: string | number;
    method: string;
    params?: unknown;
  }): void {
    const params = asRecord(message.params);
    const requestId = stableId(message.id);
    const threadId = asString(params?.threadId) ?? "unknown";
    const turnId = asString(params?.turnId) ?? "unknown";
    const itemId = asString(params?.itemId);

    const pending: PendingRequest = {
      id: requestId,
      threadId,
      turnId,
      itemId,
      method: message.method,
      kind: derivePendingRequestKind(message.method),
      summary: describePendingRequest(message.method),
      createdAt: isoNow(),
      raw: cloneValue(message.params),
      status: "pending"
    };

    this.pendingRequests.set(requestId, pending);
    const thread = this.ensureThread(threadId);
    if (!thread.pendingRequestIds.includes(requestId)) {
      thread.pendingRequestIds.push(requestId);
    }
    thread.lastActivityAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  public resolvePendingRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    pending.status = "resolved";
    const thread = this.threads.get(pending.threadId);
    if (thread) {
      thread.pendingRequestIds = thread.pendingRequestIds.filter(
        (entry) => entry !== requestId
      );
      thread.lastActivityAt = isoNow();
      if (thread.runId) {
        this.recomputeRun(thread.runId);
      }
    }
  }

  public setRunAutomationPolicy(
    runId: string,
    policyPatch: Partial<RunAutomationPolicy>
  ): Run | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    run.automationPolicy = {
      ...run.automationPolicy,
      ...policyPatch
    };
    run.updatedAt = isoNow();
    return cloneValue(run);
  }

  public setRunAutomationState(
    runId: string,
    statePatch: Partial<RunAutomationState>
  ): Run | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    run.automationState = {
      ...run.automationState,
      ...statePatch
    };
    run.updatedAt = isoNow();
    return cloneValue(run);
  }

  public listRuns(): Run[] {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((run) => cloneValue(run));
  }

  public getRun(runId: string): Run | null {
    return cloneValue(this.runs.get(runId) ?? null);
  }

  public getSnapshot(
    server: ServerConnectionState,
    activeShutdown: ActiveShutdownState,
    activeSessions: ActiveSession[],
    globalAutomation: GlobalAutomation
  ): Omit<MonitorSnapshot, "codexUsage"> {
    return {
      generatedAt: isoNow(),
      runs: this.listRuns(),
      activeSessions: cloneValue(activeSessions),
      threads: exportRecord(this.threads),
      turns: exportRecord(this.turns),
      items: exportRecord(this.items),
      pendingRequests: exportRecord(this.pendingRequests),
      server: cloneValue(server),
      activeShutdown: cloneValue(activeShutdown),
      globalAutomation: cloneValue(globalAutomation)
    };
  }

  public getRunSnapshot(
    runId: string,
    server: ServerConnectionState,
    activeShutdown: ActiveShutdownState
  ): RunSnapshot {
    const run = this.runs.get(runId) ?? null;
    if (!run) {
      return {
        generatedAt: isoNow(),
        run: null,
        threads: {},
        turns: {},
        items: {},
        pendingRequests: {},
        server: cloneValue(server),
        activeShutdown: cloneValue(activeShutdown)
      };
    }

    const trackedThreadIds = new Set(run.trackedThreadIds);
    const threads = [...this.threads.values()].filter((thread) =>
      trackedThreadIds.has(thread.id)
    );
    const turns = [...this.turns.values()].filter((turn) =>
      trackedThreadIds.has(turn.threadId)
    );
    const items = [...this.items.values()].filter((item) =>
      trackedThreadIds.has(item.threadId)
    );
    const pendingRequests = [...this.pendingRequests.values()].filter((request) =>
      trackedThreadIds.has(request.threadId)
    );

    return {
      generatedAt: isoNow(),
      run: cloneValue(run),
      threads: toRecordById(threads),
      turns: toRecordById(turns),
      items: toRecordById(items),
      pendingRequests: toRecordById(pendingRequests),
      server: cloneValue(server),
      activeShutdown: cloneValue(activeShutdown)
    };
  }

  public ensureThread(threadId: string): ThreadNode {
    const existing = this.threads.get(threadId);
    if (existing) {
      return existing;
    }

    const thread: ThreadNode = {
      id: threadId,
      runId: null,
      parentId: null,
      childIds: [],
      turnIds: [],
      name: null,
      preview: null,
      sourceKind: "unknown",
      rawStatus: { type: "notLoaded", activeFlags: [] },
      runtimeStatus: emptyThreadRuntimeStatus(),
      latestTurnId: null,
      latestTurnStatus: null,
      latestTurnError: null,
      lastActivityAt: isoNow(),
      createdAt: null,
      updatedAt: null,
      cwd: null,
      modelProvider: null,
      ephemeral: false,
      lastCommandSummary: null,
      latestMessagePreview: null,
      pendingRequestIds: [],
      isClosed: false
    };

    this.threads.set(threadId, thread);
    return thread;
  }

  private applyThreadStatusChanged(threadId: string | null, status: unknown): void {
    if (!threadId) {
      return;
    }

    const thread = this.ensureThread(threadId);
    thread.rawStatus = normalizeRawStatus(status) ?? thread.rawStatus;
    thread.runtimeStatus = deriveThreadRuntimeStatus(
      thread.rawStatus,
      thread.latestTurnStatus,
      thread.latestTurnError
    );
    thread.updatedAt = isoNow();
    thread.lastActivityAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private markThreadClosed(threadId: string | null): void {
    if (!threadId) {
      return;
    }

    const thread = this.ensureThread(threadId);
    thread.isClosed = true;
    thread.updatedAt = isoNow();
    thread.lastActivityAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private applyTurnStarted(
    threadId: string | null,
    turnRaw: Record<string, unknown> | null
  ): void {
    if (!threadId || !turnRaw) {
      return;
    }

    const turnId = asString(turnRaw.id);
    if (!turnId) {
      return;
    }

    const turn = this.ensureTurn(threadId, turnId);
    turn.status = asString(turnRaw.status) ?? "inProgress";
    turn.errorMessage = null;
    turn.completedAt = null;
    applyTurnItems(this, threadId, turnId, turnRaw.items);

    const thread = this.ensureThread(threadId);
    thread.latestTurnId = turnId;
    thread.latestTurnStatus = turn.status;
    thread.latestTurnError = null;
    thread.runtimeStatus = deriveThreadRuntimeStatus(
      thread.rawStatus,
      thread.latestTurnStatus,
      thread.latestTurnError
    );
    thread.lastActivityAt = isoNow();
    thread.updatedAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private applyTurnCompleted(
    threadId: string | null,
    turnRaw: Record<string, unknown> | null
  ): void {
    if (!threadId || !turnRaw) {
      return;
    }

    const turnId = asString(turnRaw.id);
    if (!turnId) {
      return;
    }

    const turn = this.ensureTurn(threadId, turnId);
    turn.status = asString(turnRaw.status) ?? turn.status;
    turn.completedAt = isoNow();
    turn.errorMessage =
      getNestedString(turnRaw, "error", "message") ?? turn.errorMessage;
    applyTurnItems(this, threadId, turnId, turnRaw.items);

    const thread = this.ensureThread(threadId);
    thread.latestTurnId = turnId;
    thread.latestTurnStatus = turn.status;
    thread.latestTurnError = turn.errorMessage;
    thread.runtimeStatus = deriveThreadRuntimeStatus(
      thread.rawStatus,
      thread.latestTurnStatus,
      thread.latestTurnError
    );
    thread.lastActivityAt = isoNow();
    thread.updatedAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private applyTurnDiffUpdated(
    threadId: string | null,
    turnId: string | null,
    diff: string | null
  ): void {
    if (!threadId || !turnId) {
      return;
    }

    const turn = this.ensureTurn(threadId, turnId);
    turn.diff = diff;
    const thread = this.ensureThread(threadId);
    thread.lastActivityAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private applyTurnPlanUpdated(params: Record<string, unknown> | null): void {
    const threadId = asString(params?.threadId);
    const turnId = asString(params?.turnId);
    if (!threadId || !turnId) {
      return;
    }

    const turn = this.ensureTurn(threadId, turnId);
    turn.plan = Array.isArray(params?.plan)
      ? params.plan
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map(
            (entry): TurnPlanStep => ({
              step: asString(entry.step) ?? "Unnamed step",
              status:
                (asString(entry.status) as TurnPlanStep["status"]) ?? "pending"
            })
          )
      : [];
    turn.planExplanation = asString(params?.explanation);

    const thread = this.ensureThread(threadId);
    thread.lastActivityAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private applyItemSnapshot(
    threadId: string | null,
    turnId: string | null,
    itemRaw: unknown,
    completed: boolean
  ): void {
    if (!threadId || !turnId) {
      return;
    }

    const itemRecord = asRecord(itemRaw);
    const itemId = asString(itemRecord?.id);
    if (!itemId) {
      return;
    }

    const type = asString(itemRecord?.type) ?? "unknown";
    const item = this.ensureItem(threadId, turnId, itemId, type);
    item.type = type;
    item.status = asString(itemRecord?.status) ?? item.status;
    item.raw = cloneValue(itemRaw);
    if (completed) {
      item.completedAt = isoNow();
    }

    applyItemDetails(item, itemRecord ?? {});

    const thread = this.ensureThread(threadId);
    if (item.type === "agentMessage") {
      thread.latestMessagePreview = previewText(item.text);
    }
    if (item.type === "commandExecution") {
      thread.lastCommandSummary = previewText(item.command ?? item.title, 100);
    }
    if (item.type === "collabToolCall") {
      const receiverThreadIds = asStringArray(itemRecord?.receiverThreadIds);
      for (const receiverThreadId of receiverThreadIds) {
        this.attachThreadToRun(thread.runId, receiverThreadId, thread.id);
      }
    }

    thread.lastActivityAt = isoNow();
    thread.updatedAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private applyAgentMessageDelta(params: Record<string, unknown> | null): void {
    const threadId = asString(params?.threadId);
    const turnId = asString(params?.turnId);
    const itemId = asString(params?.itemId);
    const delta = asString(params?.delta);
    if (!threadId || !turnId || !itemId || delta === null) {
      return;
    }

    const item = this.ensureItem(threadId, turnId, itemId, "agentMessage");
    item.title = "Agent message";
    item.text = `${item.text ?? ""}${delta}`;
    item.raw = item.raw ?? {};

    const thread = this.ensureThread(threadId);
    thread.latestMessagePreview = previewText(item.text);
    thread.lastActivityAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private applyCommandOutputDelta(params: Record<string, unknown> | null): void {
    const threadId = asString(params?.threadId);
    const turnId = asString(params?.turnId);
    const itemId = asString(params?.itemId);
    const delta = asString(params?.delta);
    if (!threadId || !turnId || !itemId || delta === null) {
      return;
    }

    const item = this.ensureItem(threadId, turnId, itemId, "commandExecution");
    item.title = item.title || "Command execution";
    item.output = `${item.output ?? ""}${delta}`;

    const thread = this.ensureThread(threadId);
    thread.lastActivityAt = isoNow();
    if (thread.runId) {
      this.recomputeRun(thread.runId);
    }
  }

  private ensureTurn(threadId: string, turnId: string): TurnSummary {
    const existing = this.turns.get(turnId);
    if (existing) {
      return existing;
    }

    const turn: TurnSummary = {
      id: turnId,
      threadId,
      status: "inProgress",
      startedAt: isoNow(),
      completedAt: null,
      diff: null,
      plan: [],
      planExplanation: null,
      itemIds: [],
      errorMessage: null
    };
    this.turns.set(turnId, turn);

    const thread = this.ensureThread(threadId);
    if (!thread.turnIds.includes(turnId)) {
      thread.turnIds.push(turnId);
    }

    return turn;
  }

  private ensureItem(
    threadId: string,
    turnId: string,
    itemId: string,
    type: string
  ): MonitorItem {
    const existing = this.items.get(itemId);
    if (existing) {
      return existing;
    }

    const item: MonitorItem = {
      id: itemId,
      threadId,
      turnId,
      type,
      status: null,
      title: friendlyItemTitle(type),
      text: null,
      output: null,
      command: null,
      cwd: null,
      toolName: null,
      startedAt: isoNow(),
      completedAt: null,
      raw: null
    };
    this.items.set(itemId, item);

    const turn = this.ensureTurn(threadId, turnId);
    if (!turn.itemIds.includes(itemId)) {
      turn.itemIds.push(itemId);
    }

    return item;
  }

  private attachThreadToRun(
    runId: string | null | undefined,
    threadId: string,
    parentId?: string | null
  ): void {
    if (!runId) {
      return;
    }

    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    const thread = this.ensureThread(threadId);
    thread.runId = runId;
    if (parentId) {
      thread.parentId = parentId;
      const parent = this.ensureThread(parentId);
      if (!parent.childIds.includes(threadId)) {
        parent.childIds.push(threadId);
      }
    }

    if (!run.trackedThreadIds.includes(threadId)) {
      run.trackedThreadIds.push(threadId);
    }

    run.updatedAt = isoNow();
    this.recomputeRun(runId);
  }

  private recomputeRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    const trackedThreads = run.trackedThreadIds
      .map((threadId) => this.threads.get(threadId))
      .filter((thread): thread is ThreadNode => Boolean(thread));
    const rootThread = this.threads.get(run.rootThreadId);

    const hasError = trackedThreads.some(
      (thread) => thread.runtimeStatus.bucket === "error"
    );
    const hasInProgressTurn = trackedThreads.some(
      (thread) => thread.latestTurnStatus === "inProgress"
    );
    const allSettled =
      trackedThreads.length > 0 &&
      trackedThreads.every((thread) =>
        ["idle", "waiting_on_human"].includes(thread.runtimeStatus.bucket)
      ) &&
      !hasInProgressTurn;

    run.waitingOnHuman = trackedThreads.some(
      (thread) => thread.runtimeStatus.bucket === "waiting_on_human"
    );
    run.settled = allSettled;
    run.status = hasError ? "error" : allSettled ? "settled" : "running";
    run.prompt = rootThread?.name ?? run.settings.prompt;
    run.updatedAt = isoNow();
  }
}

function normalizeRawStatus(status: unknown): RawThreadStatus | null {
  const record = asRecord(status);
  if (!record) {
    return null;
  }

  return {
    type: asString(record.type) ?? "notLoaded",
    activeFlags: asStringArray(record.activeFlags)
  };
}

function exportRecord<T extends { id: string }>(map: Map<string, T>): Record<string, T> {
  const entries = [...map.entries()].map(([key, value]) => [key, cloneValue(value)]);
  return Object.fromEntries(entries);
}

function toRecordById<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, cloneValue(item)]));
}

function applyTurnItems(
  store: MonitorStore,
  threadId: string,
  turnId: string,
  value: unknown
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    store["applyItemSnapshot"](threadId, turnId, item, false);
  }
}

function applyItemDetails(item: MonitorItem, record: Record<string, unknown>): void {
  item.title = friendlyItemTitle(item.type);
  item.command = asString(record.command) ?? item.command;
  item.cwd = asString(record.cwd) ?? item.cwd;
  item.toolName = asString(record.tool) ?? item.toolName;

  switch (item.type) {
    case "userMessage":
      item.text = extractUserMessage(record);
      break;
    case "agentMessage":
      item.text = asString(record.text) ?? item.text;
      break;
    case "commandExecution":
      item.output = asString(record.aggregatedOutput) ?? item.output;
      item.command = asString(record.command) ?? item.command;
      item.cwd = asString(record.cwd) ?? item.cwd;
      break;
    case "collabToolCall":
      item.text = describeCollabToolCall(record);
      item.toolName = asString(record.tool) ?? item.toolName;
      break;
    case "mcpToolCall":
      item.text = asString(record.result) ?? asString(record.error) ?? item.text;
      item.toolName = asString(record.tool) ?? item.toolName;
      break;
    case "webSearch":
      item.text = asString(record.query) ?? item.text;
      break;
    case "fileChange":
      item.text = previewText(asString(record.diff));
      break;
    default:
      item.text = item.text ?? previewText(JSON.stringify(record));
      break;
  }
}

function extractUserMessage(record: Record<string, unknown>): string | null {
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const pieces = content
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => asString(entry.text))
    .filter((entry): entry is string => Boolean(entry));

  return pieces.join("\n\n") || null;
}

function describeCollabToolCall(record: Record<string, unknown>): string | null {
  const tool = asString(record.tool) ?? "unknown collaboration call";
  const receivers = asStringArray(record.receiverThreadIds);
  const statuses = asRecord(record.agentsStates);

  const statusSummary = statuses
    ? Object.entries(statuses)
        .map(([threadId, value]) => {
          const status = asString(asRecord(value)?.status) ?? "unknown";
          return `${threadId}: ${status}`;
        })
        .join(", ")
    : null;

  return previewText(
    [
      `${tool}${receivers.length > 0 ? ` -> ${receivers.join(", ")}` : ""}`,
      statusSummary,
      asString(record.prompt)
    ]
      .filter(Boolean)
      .join(" | "),
    220
  );
}

function friendlyItemTitle(type: string): string {
  switch (type) {
    case "userMessage":
      return "User input";
    case "agentMessage":
      return "Agent message";
    case "commandExecution":
      return "Command execution";
    case "collabToolCall":
      return "Agent collaboration";
    case "mcpToolCall":
      return "MCP tool call";
    case "webSearch":
      return "Web search";
    case "fileChange":
      return "File change";
    default:
      return type;
  }
}

function resolveRequestId(params: unknown): string {
  const requestId = asRecord(params)?.requestId;
  if (typeof requestId === "string" || typeof requestId === "number") {
    return stableId(requestId);
  }

  return "unknown";
}
