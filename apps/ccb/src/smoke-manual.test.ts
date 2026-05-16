import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "@ccb/mcp-channel";

// Verifies the manual smoke wiring without spawning real claude: spawn the
// `ccb serve` CLI, dial it with a ControlClient as the channel server would,
// and assert a bridge_reply tool call surfaces as an agent.reply line on the
// serve process's stdout.

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;
const TEST_UUID = "00000000-0000-4000-8000-000000000077";

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-smoke-manual-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

async function pickPort(): Promise<number> {
  // Use Bun's listen + immediate close to grab an ephemeral port.
  const { createServer } = await import("node:net");
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const addr = s.address();
  if (!addr || typeof addr === "string") {
    s.close();
    throw new Error("could not pick a port");
  }
  const port = addr.port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

test(
  "ccb serve accepts a ControlClient and forwards bridge_reply as agent.reply on stdout",
  async () => {
    const port = await pickPort();
    const endpoint = `127.0.0.1:${port}`;

    const child = Bun.spawn({
      cmd: [
        "bun",
        CLI_PATH,
        "serve",
        "--endpoint",
        endpoint,
        "--session-id",
        TEST_UUID,
        "--store-dir",
        storeDir,
        "--format",
        "json",
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const decoder = new TextDecoder();
    const readUntil = async (
      stream: ReadableStream<Uint8Array>,
      predicate: (line: string) => boolean,
    ): Promise<string> => {
      // biome-ignore lint/suspicious/noExplicitAny: bun's reader type narrows on getReader()
      const reader = (stream as any).getReader() as {
        read(): Promise<{ value?: Uint8Array; done: boolean }>;
        releaseLock(): void;
      };
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          if (value) buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trimEnd();
            buf = buf.slice(nl + 1);
            if (predicate(line)) return line;
            nl = buf.indexOf("\n");
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    };

    try {
      await readUntil(child.stderr, (line) => line.includes("listening on"));

      const client = new ControlClient({
        endpoint,
        sessionId: TEST_UUID,
        onDeliver: () => undefined,
      });
      await client.connect();

      await client.sendTool("bridge_reply", {
        content: "smoke ok",
        final: true,
        messageId: "m1",
      });

      const replyLine = await readUntil(child.stdout, (line) => {
        if (line.length === 0) return false;
        try {
          const ev = JSON.parse(line) as { type?: string };
          return ev.type === "agent.reply";
        } catch {
          return false;
        }
      });

      const ev = JSON.parse(replyLine) as {
        type: string;
        content: string;
        final: boolean;
        messageId?: string;
      };
      expect(ev.type).toBe("agent.reply");
      expect(ev.content).toBe("smoke ok");
      expect(ev.final).toBe(true);
      expect(ev.messageId).toBe("m1");

      await client.close();
    } finally {
      child.kill("SIGINT");
      await child.exited;
    }
  },
  { timeout: 20_000 },
);
