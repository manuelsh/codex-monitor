import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

type RequestId = string | number;

type JsonRpcRequest = {
  id: RequestId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: RequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type PendingResolver = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

const CODEX_OVERRIDE_ENV_KEYS = [
  "CODEX_MONITOR_CODEX_PATH",
  "CODEX_BIN"
] as const;

export interface ProcessHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): void;
}

export class CodexAppServerClient extends EventEmitter<{
  notification: [JsonRpcNotification];
  serverRequest: [JsonRpcRequest];
  stderr: [string];
  close: [number | null];
  initialized: [];
}> {
  private process: ProcessHandle | null = null;
  private stdoutReader: readline.Interface | null = null;
  private stderrReader: readline.Interface | null = null;
  private initializingPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pendingRequests = new Map<RequestId, PendingResolver>();

  public constructor(
    private readonly spawnProcess: () => ProcessHandle = defaultSpawnProcess
  ) {
    super();
  }

  public async ensureStarted(): Promise<void> {
    if (this.process) {
      return;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.initializingPromise = this.startInternal();
    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  public async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted();
    return (await this.sendRequest<T>(method, params)) as T;
  }

  public async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  public async respond(id: RequestId, result: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeMessage({ id, result });
  }

  public shutdown(): void {
    this.process?.kill();
  }

  private async startInternal(): Promise<void> {
    this.process = this.spawnProcess();

    this.stdoutReader = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    this.stderrReader = readline.createInterface({
      input: this.process.stderr,
      crlfDelay: Infinity
    });

    this.stdoutReader.on("line", (line) => this.handleLine(line));
    this.stderrReader.on("line", (line) => this.emit("stderr", line));

    if ("on" in this.process && typeof this.process.on === "function") {
      (this.process as unknown as NodeJS.EventEmitter).on("close", (code) => {
        this.handleProcessClose(typeof code === "number" ? code : null);
      });
      (this.process as unknown as NodeJS.EventEmitter).on("error", (error) => {
        this.handleProcessClose(null, error);
      });
    }

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "codex-monitor",
        title: "Codex Monitor",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.writeMessage({ method: "initialized" });
    this.emit("initialized");
  }

  private async sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;

    return await new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeMessage(params === undefined ? { id, method } : { id, method, params });
    });
  }

  private writeMessage(message: unknown): void {
    if (!this.process) {
      throw new Error("Codex app-server is not running.");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emit(
        "stderr",
        `Failed to parse app-server output: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    const message = parsed as {
      id?: RequestId;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string };
      params?: unknown;
    };

    if ("id" in message && !("method" in message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if ("id" in message && "method" in message) {
      this.emit("serverRequest", message as JsonRpcRequest);
      return;
    }

    if ("method" in message) {
      this.emit("notification", message as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);

    if (message.error) {
      pending.reject(new Error(`[${message.error.code}] ${message.error.message}`));
      return;
    }

    pending.resolve(message.result);
  }

  private handleProcessClose(code: number | null, error?: unknown): void {
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = null;
    this.stderrReader = null;
    this.process = null;

    for (const [, pending] of this.pendingRequests) {
      pending.reject(
        error ??
          new Error(
            `Codex app-server exited${code === null ? "" : ` with code ${code}`}.`
          )
      );
    }

    this.pendingRequests.clear();
    this.emit("close", code);
  }
}

function defaultSpawnProcess(): ProcessHandle {
  const executable = resolveCodexExecutable();
  let child;
  try {
    child = spawn(executable, ["app-server"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env
    });
  } catch (error) {
    throw createCodexAppServerSpawnError(error, executable);
  }

  return child as unknown as ProcessHandle;
}

export function createCodexAppServerSpawnError(
  error: unknown,
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  const command = `${executable} app-server`;

  if (platform === "win32" && (code === "EPERM" || /spawn EPERM/i.test(message))) {
    const sandboxHint =
      env.CODEX_SHELL || env.CODEX_THREAD_ID || env.CODEX_SANDBOX_NETWORK_DISABLED
        ? " Codex Monitor appears to be running inside a Codex sandbox; start it from a normal PowerShell/cmd prompt or the desktop launcher instead."
        : "";

    return new Error(
      `Unable to start Codex app-server (${command}): permission denied (${message}).${sandboxHint}`
    );
  }

  return new Error(`Unable to start Codex app-server (${command}): ${message}`);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

export function resolveCodexExecutable(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const platform = options?.platform ?? process.platform;

  for (const key of CODEX_OVERRIDE_ENV_KEYS) {
    const configured = env[key];
    if (configured && existsSync(configured)) {
      return configured;
    }
  }

  for (const candidate of getPathCandidates(env, platform)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const candidate of getBundledCandidates(homeDir, platform)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return platform === "win32" ? "codex.exe" : "codex";
}

function getPathCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const rawPath = env.PATH ?? env.Path ?? "";
  const binaryNames =
    platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
      : ["codex"];

  return rawPath
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .flatMap((entry) => binaryNames.map((binary) => path.join(entry, binary)));
}

function getBundledCandidates(
  homeDir: string,
  platform: NodeJS.Platform
): string[] {
  const relativeBinaryPaths = bundledBinaryRelativePaths(platform);
  return bundledExtensionRoots(homeDir).flatMap((root) =>
    getExtensionDirectories(root).flatMap((directory) =>
      relativeBinaryPaths.map((relativePath) => path.join(directory, relativePath))
    )
  );
}

function bundledExtensionRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, ".vscode", "extensions"),
    path.join(homeDir, ".vscode-insiders", "extensions")
  ];
}

function getExtensionDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && /^openai\.chatgpt-/i.test(entry.name)
      )
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => {
        const leftTime = safeModifiedTime(left);
        const rightTime = safeModifiedTime(right);
        return rightTime - leftTime;
      });
  } catch {
    return [];
  }
}

function safeModifiedTime(directory: string): number {
  try {
    return statSync(directory).mtimeMs;
  } catch {
    return 0;
  }
}

function bundledBinaryRelativePaths(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case "win32":
      return [path.join("bin", "windows-x86_64", "codex.exe")];
    case "darwin":
      return [
        path.join("bin", "darwin-aarch64", "codex"),
        path.join("bin", "darwin-x86_64", "codex")
      ];
    default:
      return [path.join("bin", "linux-x86_64", "codex")];
  }
}
