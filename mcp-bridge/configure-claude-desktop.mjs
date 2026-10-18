#!/usr/bin/env node
/** Configure Claude Desktop to launch the local Realot MCP companion. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 20) {
  console.error(`Realot MCP requires Node.js 20 or newer. Detected ${process.versions.node}.`);
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(scriptDir, "server.mjs");
if (!fs.existsSync(serverPath)) {
  console.error(`Could not find the Realot MCP server: ${serverPath}`);
  process.exit(1);
}

function defaultConfigPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

const configPath = path.resolve(process.env.REALOT_CLAUDE_CONFIG || defaultConfigPath());
let config = {};
let existed = false;
try {
  const raw = fs.readFileSync(configPath, "utf8");
  existed = true;
  config = JSON.parse(raw);
} catch (error) {
  if (error?.code !== "ENOENT") {
    console.error(`Claude's config was left unchanged because it could not be read as valid JSON: ${configPath}`);
    console.error(String(error?.message || error));
    process.exit(1);
  }
}

if (!config || typeof config !== "object" || Array.isArray(config)) {
  console.error(`Claude's config must be a JSON object. It was left unchanged: ${configPath}`);
  process.exit(1);
}
if (config.mcpServers == null) config.mcpServers = {};
if (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
  console.error(`Claude's 'mcpServers' setting must be a JSON object. It was left unchanged: ${configPath}`);
  process.exit(1);
}

config.mcpServers["realot-studio"] = {
  command: process.execPath,
  args: [serverPath],
};

try {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backupPath = `${configPath}.backup-${stamp}`;
    let suffix = 1;
    while (fs.existsSync(backupPath)) backupPath = `${configPath}.backup-${stamp}-${suffix++}`;
    fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    console.log(`Backed up the previous Claude config to: ${backupPath}`);
  }
  const tempPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, configPath);
} catch (error) {
  console.error(`Could not write Claude's config: ${configPath}`);
  console.error(String(error?.message || error));
  process.exit(1);
}

console.log("\nRealot Studio MCP entry added to Claude Desktop.");
console.log(`Config: ${configPath}`);
console.log("Existing MCP entries were preserved. Restart Claude Desktop, run Show-Token.bat (or node mcp-bridge/server.mjs --show-token), then pair the editor in its AI Bridge panel.");
