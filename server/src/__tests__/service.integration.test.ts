import { EventEmitter } from "node:events";
import { MonitorService } from "../service";

class FakeCodexClient extends EventEmitter {
  public async ensureStarted() {
    return;
  }

  public async request(method: string) {
    if (method === "thread/list") {
      return {
        data: [
          {
            id: "thr_history",
            name: "VS Code thread",
            preview: "Track my history",
            source: "vscode",
            status: { type: "notLoaded" },
            createdAt: 1775820937,
            updatedAt: 1775821082,
            cwd: "C:/repo",
            modelProvider: "openai",
            ephemeral: false
          }
        ],
        nextCursor: null
      };
    }

    throw new Error(`Unexpected request: ${method}`);
  }

  public async respond() {
    return;
  }
}

describe("MonitorService integration", () => {
  it("maps history entries that use the current app-server source field", async () => {
    const client = new FakeCodexClient();
    const service = new MonitorService(client as never);

    const history = await service.listHistoryThreads({
      sourceKinds: ["vscode"]
    });

    expect(history.data).toHaveLength(1);
    expect(history.data[0].sourceKind).toBe("vscode");
    expect(history.data[0].name).toBe("VS Code thread");
  });
});
