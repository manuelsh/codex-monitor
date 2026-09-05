import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const script = path.resolve("scripts/start-codex-monitor.sh");

describe.skipIf(process.platform === "win32")("POSIX monitor launcher", () => {
  let server: Server;
  let port: number;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function listen(body: string) {
    server = createServer((_req, res) => { res.end(body); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  }
  it("reuses an already healthy monitor", async () => {
    await listen('{"ok":true}');
    const result = await exec("/bin/sh", [script, "--no-browser"], {
      env: { ...process.env, PORT: String(port) }, timeout: 10000
    });
    expect(result.stdout).toContain(`Codex Monitor is running at http://127.0.0.1:${port}`);
  });
  it("fails instead of reporting success on an unrelated occupied port", async () => {
    await listen("unrelated service");
    await expect(exec("/bin/sh", [script, "--no-browser"], {
      env: { ...process.env, PORT: String(port) }, timeout: 10000
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("already in use") });
  });
});
