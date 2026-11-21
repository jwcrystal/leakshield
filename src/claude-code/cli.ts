import { loadConfig } from "../config/loader.js";
import type { GuardConfig } from "../types.js";
import { DEFAULT_PROXY_PORT, DEFAULT_UPSTREAM, startClaudeCodeProxy } from "./proxy.js";

export interface ClaudeCodeProxyArgs {
  port: number;
  upstream: string;
  configPath?: string;
  attachments: "block" | "allow";
}

export function parseClaudeCodeProxyArgs(args: readonly string[]): ClaudeCodeProxyArgs | { error: string } {
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
  };
  const rawPort = valueOf("--port");
  const port = rawPort === undefined ? DEFAULT_PROXY_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: "--port must be an integer from 0 to 65535" };
  const attachments = valueOf("--attachments") ?? "block";
  if (attachments !== "block" && attachments !== "allow") return { error: '--attachments must be "block" or "allow"' };
  return { port, upstream: valueOf("--upstream") ?? DEFAULT_UPSTREAM, configPath: valueOf("--config"), attachments };
}

// Same forced setting as the OpenCode plugin entry, so both hosts detect the
// same encoded values.
function withEncodingDetection(config: GuardConfig): GuardConfig {
  return { ...config, settings: { ...config.settings, encoding_detection: true } };
}

export async function runClaudeCodeProxy(args: readonly string[]): Promise<number> {
  const parsed = parseClaudeCodeProxyArgs(args);
  if ("error" in parsed) {
    console.error(`leakshield: ${parsed.error}`);
    return 2;
  }
  let running;
  try {
    const config = withEncodingDetection(loadConfig(parsed.configPath, process.cwd()));
    running = await startClaudeCodeProxy({
      config,
      port: parsed.port,
      upstream: parsed.upstream,
      attachments: parsed.attachments,
    });
  } catch (error) {
    console.error(`leakshield: could not start the Claude Code proxy: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(`LeakShield Claude Code proxy listening on ${running.url} -> ${parsed.upstream}`);
  console.log(`Point Claude Code at it: export ANTHROPIC_BASE_URL=${running.url}`);
  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<never>(() => {});
  return 0;
}
