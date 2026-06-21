import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCodexAppServerSpawnError,
  resolveCodexExecutable
} from "../codex-client";

describe("resolveCodexExecutable", () => {
  it("finds the VS Code-bundled Codex binary when PATH does not include it", () => {
    const tempRoot = path.join(
      os.tmpdir(),
      `codex-monitor-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const executablePath = path.join(
      tempRoot,
      ".vscode",
      "extensions",
      "openai.chatgpt-26.406.31014-win32-x64",
      "bin",
      "windows-x86_64",
      "codex.exe"
    );

    mkdirSync(path.dirname(executablePath), { recursive: true });
    writeFileSync(executablePath, "");

    try {
      expect(
        resolveCodexExecutable({
          env: { PATH: "" },
          homeDir: tempRoot,
          platform: "win32"
        })
      ).toBe(executablePath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("createCodexAppServerSpawnError", () => {
  it("explains Windows EPERM failures from Codex sandboxed shells", () => {
    const error = Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    const result = createCodexAppServerSpawnError(
      error,
      "C:\\Codex\\codex.exe",
      { CODEX_SHELL: "1" },
      "win32"
    );

    expect(result.message).toContain("permission denied");
    expect(result.message).toContain("inside a Codex sandbox");
    expect(result.message).toContain("C:\\Codex\\codex.exe app-server");
  });

  it("keeps the original message for other spawn failures", () => {
    const result = createCodexAppServerSpawnError(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      "codex",
      {},
      "linux"
    );

    expect(result.message).toBe(
      "Unable to start Codex app-server (codex app-server): spawn ENOENT"
    );
  });
});
