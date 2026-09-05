import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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


describe("macOS desktop executable discovery", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "codex-desktop-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function binary(relative: string) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return file;
  }

  function resolve(env: NodeJS.ProcessEnv = { PATH: "" }) {
    return resolveCodexExecutable({
      env, platform: "darwin", homeDir: path.join(root, "home"),
      applicationsDir: path.join(root, "Applications")
    });
  }

  it.each(["Codex.app", "ChatGPT.app"])("finds the binary bundled in %s", (app) => {
    const file = binary(`Applications/${app}/Contents/Resources/codex`);
    expect(resolve()).toBe(file);
  });

  it("finds a user-local desktop installation", () => {
    const file = binary("home/Applications/Codex.app/Contents/Resources/codex");
    expect(resolve()).toBe(file);
  });

  it("preserves explicit override and PATH precedence", () => {
    binary("Applications/Codex.app/Contents/Resources/codex");
    const inPath = binary("bin/codex");
    const override = binary("custom/codex");
    expect(resolveCodexExecutable({ env: { PATH: path.dirname(inPath) }, platform: process.platform, homeDir: root })).toBe(inPath);
    expect(resolve({ PATH: path.dirname(inPath), CODEX_BIN: override })).toBe(override);
    expect(resolve({ PATH: "", CODEX_MONITOR_CODEX_PATH: override })).toBe(override);
  });

  it("ignores directories named codex", () => {
    mkdirSync(path.join(root, "bin/codex"), { recursive: true });
    const file = binary("Applications/ChatGPT.app/Contents/Resources/codex");
    expect(resolve({ PATH: path.join(root, "bin") })).toBe(file);
  });

  it("retains the VS Code fallback without desktop apps", () => {
    const file = binary("home/.vscode/extensions/openai.chatgpt-test/bin/darwin-aarch64/codex");
    expect(resolve()).toBe(file);
  });

  it("retains Windows PATH discovery", () => {
    const file = binary("windows/codex.exe");
    expect(resolveCodexExecutable({ env: { Path: path.dirname(file) }, platform: "win32", homeDir: root })).toBe(file);
  });
});
