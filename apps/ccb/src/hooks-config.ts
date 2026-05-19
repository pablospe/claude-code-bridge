import { generateHooksSettings, type HookEvent } from "@ccb/claude-code";

export interface HooksConfigCliOptions {
  readonly events: ReadonlyArray<HookEvent>;
  readonly out?: string;
}

export async function runHooksConfig(opts: HooksConfigCliOptions): Promise<string> {
  const settings = generateHooksSettings({ events: opts.events });
  const json = JSON.stringify(settings, null, 2);
  if (opts.out) {
    await Bun.write(opts.out, json);
    return opts.out;
  }
  return json;
}
