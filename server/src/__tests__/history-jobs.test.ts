import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryJobReader, parseHistorySessionFile } from "../history-jobs";
import { MonitorService } from "../service";

class FakeCodexClient extends EventEmitter {
  public constructor(private readonly threads: unknown[] | null = null) {
    super();
  }

  public async ensureStarted() {
    return;
  }

  public async request(method: string) {
    if (method === "thread/list" && this.threads) {
      return {
        data: this.threads,
        nextCursor: null
      };
    }

    throw new Error("Unexpected request");
  }

  public async respond() {
    return;
  }
}

describe("parseHistorySessionFile", () => {
  it("uses task_complete duration_ms and token_count usage", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-3784-79c3-86e7-5469e67f114b",
      updatedAt: "2026-05-12T09:00:00.000Z",
      nowMs: Date.parse("2026-05-12T09:03:00.000Z"),
      fileContent: lines([
        {
          timestamp: "2026-05-12T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e1b12-3784-79c3-86e7-5469e67f114b",
            timestamp: "2026-05-12T09:00:00.000Z",
            cwd: "C:/repo",
            source: { cli: {} },
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-05-12T09:01:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_a" }
        },
        {
          timestamp: "2026-05-12T09:01:05.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
                reasoning_output_tokens: 4,
                total_tokens: 110
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
                reasoning_output_tokens: 4,
                total_tokens: 110
              }
            }
          }
        },
        {
          timestamp: "2026-05-12T09:01:07.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn_a",
            completed_at: 1778576467,
            duration_ms: 4200
          }
        }
      ])
    });

    expect(job).toMatchObject({
      id: "019e1b12-3784-79c3-86e7-5469e67f114b",
      sourceKind: "cli",
      cwd: "C:/repo",
      modelProvider: "openai",
      runCount: 1,
      lastRunDurationMs: 4200,
      totalDurationMs: 4200,
      totalUsage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 4,
        totalTokens: 110
      }
    });
  });

  it("falls back to timestamps and totals multiple turns", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-7d46-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T09:10:00.000Z",
      nowMs: Date.parse("2026-05-12T09:20:00.000Z"),
      fileContent: lines([
        {
          timestamp: "2026-05-12T09:10:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_a" }
        },
        {
          timestamp: "2026-05-12T09:10:05.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn_a" }
        },
        {
          timestamp: "2026-05-12T09:11:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_b" }
        },
        {
          timestamp: "2026-05-12T09:11:10.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn_b" }
        }
      ])
    });

    expect(job?.runCount).toBe(2);
    expect(job?.lastRunDurationMs).toBe(10000);
    expect(job?.totalDurationMs).toBe(15000);
  });

  it("ignores malformed lines and measures active turns against now", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-ffff-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T09:10:00.000Z",
      nowMs: Date.parse("2026-05-12T09:12:00.000Z"),
      fileContent: [
        "{malformed json",
        JSON.stringify({
          timestamp: "2026-05-12T09:10:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_active" }
        })
      ].join("\n")
    });

    expect(job?.runCount).toBe(1);
    expect(job?.lastRunCompletedAt).toBeNull();
    expect(job?.lastRunDurationMs).toBe(120000);
    expect(job?.totalDurationMs).toBe(120000);
  });

  it("caps stale open turns at the last recorded activity", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-stale-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T09:10:00.000Z",
      nowMs: Date.parse("2026-05-13T09:10:00.000Z"),
      fileContent: lines([
        {
          timestamp: "2026-05-12T09:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_stale_open" }
        },
        {
          timestamp: "2026-05-12T09:03:30.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 1,
                total_tokens: 11
              },
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 1,
                total_tokens: 11
              }
            }
          }
        }
      ])
    });

    expect(job?.lastRunCompletedAt).toBeNull();
    expect(job?.lastRunDurationMs).toBe(210000);
    expect(job?.totalDurationMs).toBe(210000);
  });
});

describe("MonitorService history jobs", () => {
  let sessionsRoot: string;

  beforeEach(() => {
    sessionsRoot = mkdtempSync(path.join(os.tmpdir(), "codex-monitor-history-"));
  });

  afterEach(() => {
    rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("orders, filters, and paginates local history jobs", async () => {
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000001",
      "2026-05-12T09:00:00.000Z",
      "cli",
      "older cli work"
    );
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000002",
      "2026-05-12T10:00:00.000Z",
      "vscode",
      "newer vscode work"
    );

    const service = new MonitorService(
      new FakeCodexClient() as never,
      new HistoryJobReader(sessionsRoot)
    );

    const firstPage = await service.listHistoryJobs({ limit: 1 });
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.data[0].id).toBe("019e1b12-0000-7000-8000-000000000002");
    expect(firstPage.nextCursor).toBe("1");

    const secondPage = await service.listHistoryJobs({
      cursor: firstPage.nextCursor,
      limit: 1
    });
    expect(secondPage.data[0].id).toBe("019e1b12-0000-7000-8000-000000000001");
    expect(secondPage.total).toBe(2);
    expect(secondPage.nextCursor).toBeNull();

    const cliOnly = await service.listHistoryJobs({
      sourceKinds: ["cli"],
      searchTerm: "older"
    });
    expect(cliOnly.data).toHaveLength(1);
    expect(cliOnly.total).toBe(1);
    expect(cliOnly.data[0].sourceKind).toBe("cli");
  });

  it("sorts local history jobs by duration, tokens, and date direction", async () => {
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000011",
      "2026-05-12T09:00:00.000Z",
      "cli",
      "short work",
      { durationMs: 1000, totalTokens: 1000 }
    );
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000012",
      "2026-05-12T10:00:00.000Z",
      "cli",
      "long work",
      { durationMs: 5000, totalTokens: 500 }
    );

    const service = new MonitorService(
      new FakeCodexClient() as never,
      new HistoryJobReader(sessionsRoot)
    );

    expect(
      (
        await service.listHistoryJobs({
        sortKey: "totalDurationMs",
        sortDirection: "desc"
      })
      ).data[0].id
    ).toBe("019e1b12-0000-7000-8000-000000000012");

    expect(
      (
        await service.listHistoryJobs({
        sortKey: "totalTokens",
        sortDirection: "desc"
      })
      ).data[0].id
    ).toBe("019e1b12-0000-7000-8000-000000000011");

    expect(
      (
        await service.listHistoryJobs({
        sortKey: "updatedAt",
        sortDirection: "asc"
      })
      ).data[0].id
    ).toBe("019e1b12-0000-7000-8000-000000000011");
  });

  it("uses app-server thread metadata for history job titles and search", async () => {
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000021",
      "2026-05-12T09:00:00.000Z",
      "vscode",
      "raw prompt without the generated title"
    );

    const service = new MonitorService(
      new FakeCodexClient([
        {
          id: "019e1b12-0000-7000-8000-000000000021",
          name: "Readable generated title",
          preview: "Metadata preview",
          source: "vscode",
          createdAt: "2026-05-12T09:00:00.000Z",
          updatedAt: "2026-05-12T09:01:00.000Z",
          cwd: "C:/repo",
          modelProvider: "openai"
        }
      ]) as never,
      new HistoryJobReader(sessionsRoot)
    );

    const history = await service.listHistoryJobs({
      searchTerm: "generated title"
    });

    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({
      id: "019e1b12-0000-7000-8000-000000000021",
      name: "Readable generated title",
      preview: "Metadata preview"
    });
  });
});

function writeSessionFile(
  root: string,
  sessionId: string,
  timestamp: string,
  sourceKind: string,
  prompt: string,
  options: { durationMs?: number; totalTokens?: number } = {}
) {
  const durationMs = options.durationMs ?? 1000;
  const totalTokens = options.totalTokens ?? 100;
  const directory = path.join(root, "2026", "05", "12");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `rollout-2026-05-12T09-00-00-${sessionId}.jsonl`),
    lines([
      {
        timestamp,
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp,
          cwd: "C:/repo",
          source: sourceKind
        }
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      },
      {
        timestamp,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_a" }
      },
      {
        timestamp: new Date(Date.parse(timestamp) + 500).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: totalTokens - 10,
              cached_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 5,
              total_tokens: totalTokens
            },
            last_token_usage: {
              input_tokens: totalTokens - 10,
              cached_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 5,
              total_tokens: totalTokens
            }
          }
        }
      },
      {
        timestamp: new Date(Date.parse(timestamp) + durationMs).toISOString(),
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn_a",
          duration_ms: durationMs
        }
      }
    ])
  );
}

function lines(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}
