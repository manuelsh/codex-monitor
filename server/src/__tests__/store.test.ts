import { MonitorStore } from "../store";

const serverState = {
  connected: true,
  initialized: true,
  lastError: null,
  stderrTail: []
};

const activeShutdown = {
  scope: null,
  runId: null,
  scheduled: false,
  command: null,
  executeAt: null,
  dryRun: true
};

describe("MonitorStore", () => {
  it("builds the thread tree from collab tool calls", () => {
    const store = new MonitorStore();
    const run = store.createRun("thr_root", {
      prompt: "Do the work",
      cwd: "C:/repo"
    });

    store.upsertThreadFromRaw(
      {
        id: "thr_root",
        name: "Root",
        status: { type: "active", activeFlags: [] }
      },
      run.id
    );

    store.applyRpcNotification({
      method: "turn/started",
      params: {
        threadId: "thr_root",
        turn: {
          id: "turn_root",
          status: "inProgress"
        }
      }
    });

    store.applyRpcNotification({
      method: "item/completed",
      params: {
        threadId: "thr_root",
        turnId: "turn_root",
        item: {
          id: "item_spawn",
          type: "collabToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["thr_child_a", "thr_child_b"],
          agentsStates: {
            thr_child_a: { status: "running" },
            thr_child_b: { status: "pendingInit" }
          }
        }
      }
    });

    const snapshot = store.getRunSnapshot(run.id, serverState, activeShutdown);
    expect(snapshot.run?.trackedThreadIds).toEqual(
      expect.arrayContaining(["thr_root", "thr_child_a", "thr_child_b"])
    );
    expect(snapshot.threads.thr_child_a.parentId).toBe("thr_root");
    expect(snapshot.threads.thr_child_b.parentId).toBe("thr_root");
    expect(snapshot.threads.thr_root.childIds).toEqual(
      expect.arrayContaining(["thr_child_a", "thr_child_b"])
    );
  });

  it("maps waiting flags and failures into thread runtime buckets", () => {
    const store = new MonitorStore();
    const run = store.createRun("thr_root", {
      prompt: "Watch statuses",
      cwd: "C:/repo"
    });

    store.upsertThreadFromRaw(
      {
        id: "thr_root",
        status: { type: "active", activeFlags: ["waitingOnApproval"] }
      },
      run.id
    );

    let snapshot = store.getRunSnapshot(run.id, serverState, activeShutdown);
    expect(snapshot.threads.thr_root.runtimeStatus.bucket).toBe("waiting_on_human");

    store.applyRpcNotification({
      method: "turn/completed",
      params: {
        threadId: "thr_root",
        turn: {
          id: "turn_root",
          status: "failed",
          error: { message: "Command failed" }
        }
      }
    });

    snapshot = store.getRunSnapshot(run.id, serverState, activeShutdown);
    expect(snapshot.threads.thr_root.runtimeStatus.bucket).toBe("error");
    expect(snapshot.run?.status).toBe("error");
  });

  it("uses the Codex root thread name as the visible run title", () => {
    const store = new MonitorStore();
    const run = store.createRun("thr_root", {
      prompt: "Original user prompt",
      cwd: "C:/repo"
    });

    store.upsertThreadFromRaw(
      {
        id: "thr_root",
        name: "Codex generated title",
        status: { type: "active", activeFlags: [] }
      },
      run.id
    );

    const snapshot = store.getRunSnapshot(run.id, serverState, activeShutdown);
    expect(snapshot.run?.prompt).toBe("Codex generated title");
    expect(snapshot.run?.settings.prompt).toBe("Original user prompt");
  });

  it("marks a run as settled when tracked threads are idle or waiting on a human", () => {
    const store = new MonitorStore();
    const run = store.createRun("thr_root", {
      prompt: "Wait if needed",
      cwd: "C:/repo"
    });

    store.upsertThreadFromRaw(
      {
        id: "thr_root",
        status: { type: "idle" }
      },
      run.id
    );

    store.applyRpcNotification({
      method: "turn/started",
      params: {
        threadId: "thr_root",
        turn: {
          id: "turn_root",
          status: "completed"
        }
      }
    });

    store.applyRpcNotification({
      method: "item/completed",
      params: {
        threadId: "thr_root",
        turnId: "turn_root",
        item: {
          id: "item_spawn",
          type: "collabToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["thr_child"]
        }
      }
    });

    store.upsertThreadFromRaw(
      {
        id: "thr_child",
        status: { type: "active", activeFlags: ["waitingOnUserInput"] }
      },
      run.id
    );

    const snapshot = store.getRunSnapshot(run.id, serverState, activeShutdown);
    expect(snapshot.run?.settled).toBe(true);
    expect(snapshot.run?.status).toBe("settled");
  });
});
