import { claudeCodeSupervisorFactory, mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge, type SupervisorFactory } from "@ccb/core";
import { SessionPool, startApiServer } from "@ccb/http";

export interface ApiOptions {
  readonly host: string;
  readonly port: number;
  readonly poolSize: number;
  readonly turnTimeoutMs: number;
  readonly supervisor: "mock" | "claude";
  readonly storeDir: string;
  readonly apiKey?: string;
}

export interface ApiHandle {
  readonly url: string;
  stop(): Promise<void>;
}

function selectFactory(choice: "mock" | "claude"): SupervisorFactory {
  if (choice === "claude") {
    return claudeCodeSupervisorFactory({
      channels: "dev-flag",
      cleanSession: true,
      rawModel: true,
    });
  }
  return mockSupervisorFactory();
}

export async function runApi(options: ApiOptions): Promise<ApiHandle> {
  const bridge = new Bridge({
    storeDir: options.storeDir,
    supervisorFactory: selectFactory(options.supervisor),
    // Clean cold boots of a real claude can take tens of seconds.
    startTimeoutMs: 90_000,
  });
  const pool = new SessionPool({ bridge, size: options.poolSize });
  await pool.start();
  const server = await startApiServer({
    pool,
    host: options.host,
    port: options.port,
    turnTimeoutMs: options.turnTimeoutMs,
    apiKey: options.apiKey,
  });
  return {
    url: server.url,
    async stop() {
      await server.stop();
      await pool.close();
    },
  };
}
