/**
 * Ambient declarations for the OpenClaw plugin SDK subpaths that `src/index.ts`
 * imports. The real modules are provided by the host OpenClaw process at plugin
 * load time; they are not installed in this monorepo, so these stubs let the
 * entry typecheck here. Only the surface the entry actually uses is declared.
 *
 * Mirrors: openclaw `src/plugin-sdk/plugin-entry.ts` (definePluginEntry,
 * OpenClawPluginApi.registerService) and `src/plugin-sdk/acp-runtime-backend.ts`
 * (registerAcpRuntimeBackend / unregisterAcpRuntimeBackend).
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginServiceContext = {
    stateDir: string;
    workspaceDir?: string;
    logger: {
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
  };
  export type OpenClawPluginService = {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  };
  export type OpenClawPluginApi = {
    registerService: (service: OpenClawPluginService) => void;
    pluginConfig?: Record<string, unknown>;
  };
  export type DefinePluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  };
  export function definePluginEntry(options: DefinePluginEntryOptions): unknown;
}

declare module "openclaw/plugin-sdk/acp-runtime-backend" {
  export type AcpRuntimeBackendRecord = {
    id: string;
    runtime: unknown;
    healthy?: () => boolean;
  };
  export function registerAcpRuntimeBackend(backend: AcpRuntimeBackendRecord): void;
  export function unregisterAcpRuntimeBackend(id: string): void;
}
