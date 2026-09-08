import { ActiveSessionTracker, parseActiveSessionFile } from "../active-sessions";
import { mkdtempSync, writeFileSync, appendFileSync, statSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("parseActiveSessionFile", () => {
  it("returns an active session when the latest turn started and has not finished", () => {
    const session = parseActiveSessionFile({
      sessionId: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      updatedAt: "2026-04-10T11:54:20.000Z",
      nowMs: Date.parse("2026-04-10T11:55:00.000Z"),
      activeWindowMs: 15 * 60 * 1000,
      fileContent: [
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.500Z",
          type: "session_meta",
          payload: {
            name: "Codex monitor title",
            cwd: "C:\\work\\from-meta"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.572Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn_active"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.579Z",
          type: "turn_context",
          payload: {
            cwd: "C:\\work\\codex-monitor"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.580Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "monitor only the live work" }]
          }
        })
      ].join("\n")
    });

    expect(session).toEqual({
      id: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      name: "Codex monitor title",
      preview: "monitor only the live work",
      cwd: "C:\\work\\codex-monitor",
      createdAt: null,
      updatedAt: "2026-04-10T11:53:18.580Z",
      lastTurnStartedAt: "2026-04-10T11:53:18.572Z"
    });
  });

  it("ignores sessions whose latest turn has already completed", () => {
    const session = parseActiveSessionFile({
      sessionId: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      updatedAt: "2026-04-10T11:54:20.000Z",
      nowMs: Date.parse("2026-04-10T11:55:00.000Z"),
      activeWindowMs: 15 * 60 * 1000,
      fileContent: [
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.572Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn_done"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:58.572Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn_done"
          }
        })
      ].join("\n")
    });

    expect(session).toBeNull();
  });

  it("ignores stale sessions even if the latest turn never wrote a terminal event", () => {
    const session = parseActiveSessionFile({
      sessionId: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      updatedAt: "2026-04-10T08:00:00.000Z",
      nowMs: Date.parse("2026-04-10T11:55:00.000Z"),
      activeWindowMs: 15 * 60 * 1000,
      fileContent: [
        JSON.stringify({
          timestamp: "2026-04-10T07:59:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn_stale"
          }
        })
      ].join("\n")
    });

    expect(session).toBeNull();
  });
});

describe("ActiveSessionTracker cache", () => {
  it("expires unchanged sessions and detects completion even when mtime does not change", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "monitor-active-"));
    try {
      const file = path.join(root, "rollout-019d773d-49eb-7ae0-9327-ff3b0b39c7a7.jsonl");
      const now = Date.now();
      writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "t" } }) + "\n");
      const tracker = new ActiveSessionTracker(root, 1000);
      expect(tracker.listActiveSessions(now)).toHaveLength(1);
      expect(tracker.listActiveSessions(now + 1001)).toHaveLength(0);
      const stat = statSync(file);
      appendFileSync(file, JSON.stringify({ timestamp: new Date(now + 500).toISOString(), type: "event_msg", payload: { type: "task_complete", turn_id: "t" } }) + "\n");
      utimesSync(file, stat.atime, stat.mtime);
      expect(tracker.listActiveSessions(now + 500)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("excludes internal subagents from top-level activity", () => {
    expect(parseActiveSessionFile({ sessionId: "review", updatedAt: new Date().toISOString(), nowMs: Date.now(), activeWindowMs: 900000,
      fileContent: [JSON.stringify({ type: "session_meta", payload: { source: { subagent: { other: "guardian" } } } }), JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t" } })].join("\n")
    })).toBeNull();
  });
});
