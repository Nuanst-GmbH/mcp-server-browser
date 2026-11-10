import * as fs from "node:fs/promises";
import * as path from "node:path";

export const BROWSER_TOOL_SERVER_NAME = "browser-tool";

export interface StdioServerEntry {
  command: string;
  args: readonly [string];
}

export type ClaudeConfigEdit =
  | { status: "unchanged" }
  | { status: "added"; config: Record<string, unknown> }
  | { status: "refreshed"; config: Record<string, unknown> }
  | { status: "conflict" }
  | { status: "invalid" };

export class ClaudeConfigInvalid extends Error {
  constructor() {
    super("Claude Code user config is not valid JSON");
    this.name = "ClaudeConfigInvalid";
  }
}

export function claudeUserConfigPath(home: string): string {
  return path.join(home, ".claude.json");
}

export function nodeMajor(versionText: string): number | undefined {
  const match = /^v?(\d+)\./.exec(versionText.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : undefined;
}

export function editClaudeUserConfig(config: unknown, entry: StdioServerEntry): ClaudeConfigEdit {
  if (config !== undefined && !isRecord(config)) return { status: "invalid" };
  const root: Record<string, unknown> = config === undefined ? {} : config;
  if ("mcpServers" in root && root.mcpServers !== undefined && !isRecord(root.mcpServers)) {
    return { status: "invalid" };
  }
  const servers: Record<string, unknown> = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
  const existing = servers[BROWSER_TOOL_SERVER_NAME];
  if (existing === undefined) {
    servers[BROWSER_TOOL_SERVER_NAME] = { command: entry.command, args: [entry.args[0]] };
    return { status: "added", config: { ...root, mcpServers: servers } };
  }
  if (!isOurServer(existing)) return { status: "conflict" };
  const script = serverScript(existing);
  const commandMatches = "command" in existing && existing.command === entry.command;
  if (commandMatches && script === normalizePath(entry.args[0])) return { status: "unchanged" };
  servers[BROWSER_TOOL_SERVER_NAME] = { ...existing, command: entry.command, args: [entry.args[0]] };
  return { status: "refreshed", config: { ...root, mcpServers: servers } };
}

export async function readClaudeUserConfig(home: string): Promise<unknown> {
  const file = claudeUserConfigPath(home);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  try {
    return parseJson(text);
  } catch {
    throw new ClaudeConfigInvalid();
  }
}

export async function saveClaudeUserConfig(home: string, config: Record<string, unknown>): Promise<void> {
  const file = claudeUserConfigPath(home);
  const temporary = `${file}.browser-tool.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.copyFile(temporary, file);
  await fs.unlink(temporary).catch(() => undefined);
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function serverScript(entry: Record<string, unknown>): string | undefined {
  if (!("args" in entry) || !Array.isArray(entry.args) || entry.args.length !== 1) return undefined;
  const script = entry.args[0];
  if (typeof script !== "string") return undefined;
  return normalizePath(script);
}

function isOurServer(entry: unknown): entry is Record<string, unknown> {
  if (!isRecord(entry)) return false;
  const script = serverScript(entry);
  return script !== undefined && script.includes("mcp-server-browser") && script.endsWith("/dist/server.js");
}
