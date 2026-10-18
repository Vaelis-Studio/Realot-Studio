# Realot Studio MCP Bridge

This add-on lets an MCP-compatible client such as **Claude Desktop** work with the **currently open Realot Studio editor**. It exposes scene/entity/component/script tools and routes each operation to Realot's existing editor and runtime APIs. It does not make changes when it is disconnected.

## What is included

- `server.mjs` — local MCP server using standard newline-delimited JSON-RPC over STDIO, plus a localhost-only WebSocket link to the browser editor.
- No npm packages are required; the bridge uses Node.js built-ins.
- The editor's **AI Bridge** panel is part of `project/editor/` and appears at the lower-right of the editor.

## Requirements

- Node.js 20 or newer.
- Claude Desktop (this package uses a local STDIO MCP server). A hosted `claude.ai` custom connector URL is **not** created by a ZIP file alone; it would require a separately deployed remote service and authentication setup.
- Realot Studio opened in a normal browser tab over HTTP/HTTPS, not by double-clicking an HTML file.

## Setup on Windows

1. Extract the full Realot folder to a stable location. Do not move `mcp-bridge/server.mjs` after configuring Claude unless you run setup again.
2. Double-click `mcp-bridge\Configure-Claude-Desktop.bat`. It checks for Node.js 20+, adds the Realot entry to Claude Desktop's config, preserves other MCP entries, and backs up the previous config first. If you prefer manual setup, the config path is `%APPDATA%\Claude\claude_desktop_config.json`.
3. Double-click `mcp-bridge\Show-Token.bat` and copy the 64-character token printed in the window. This one-off command exits immediately after displaying the token; it does not start the server. You can also use `node .\mcp-bridge\server.mjs --show-token` in a terminal.
4. If using manual setup, merge the following entry into the existing `mcpServers` object (do not erase other servers):

   ```json
   {
     "mcpServers": {
       "realot-studio": {
         "command": "node",
         "args": ["C:\\PATH\\TO\\Realot\\mcp-bridge\\server.mjs"]
       }
     }
   }
   ```

   Replace the example path with the absolute path to your extracted `server.mjs`. If your config already contains `mcpServers`, add only the `realot-studio` entry inside that object.
5. Fully restart Claude Desktop so it starts the Realot MCP server.
6. Open Realot Studio, click **AI Bridge** at the lower-right of the editor, paste the token, and click **Pair**.
7. If the browser shows a local/loopback-network permission prompt, allow it for the Realot editor. In Claude, call `realot_bridge_status` or ask Claude to inspect the current Realot scene. The bridge status should report an editor connection before scene tools are used.

## Setup on macOS

1. From Terminal, go to the extracted `Realot` folder and configure Claude Desktop with:

   ```bash
   node ./mcp-bridge/configure-claude-desktop.mjs
   node ./mcp-bridge/server.mjs --show-token
   ```

   The configuration script preserves existing MCP servers and backs up the previous config before writing changes. It supports macOS and Linux config locations, plus a `REALOT_CLAUDE_CONFIG` override for custom installations.
2. If you prefer manual setup, add the server to `~/Library/Application Support/Claude/claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "realot-studio": {
         "command": "node",
         "args": ["/absolute/path/to/Realot/mcp-bridge/server.mjs"]
       }
     }
   }
   ```
3. Restart Claude Desktop, open the Realot editor, then pair via **AI Bridge** using the token printed by the second command.

## Available tools

- Inspect: `realot_bridge_status`, `realot_get_status`, `realot_list_scenes`, `realot_list_entities`, `realot_get_entity`, `realot_get_console`.
- Scene edits: `realot_create_entity`, `realot_update_entity`, `realot_delete_entity`, `realot_add_component`, `realot_update_component`, `realot_remove_component`, `realot_create_scene`, `realot_switch_scene`, `realot_rename_scene`, `realot_delete_scene`.
- Scripts: `realot_list_scripts`, `realot_get_script`, `realot_set_script`, `realot_validate_script`.
- Workflow: `realot_validate_scene`, `realot_set_play_mode`, `realot_save_project`.

Use `realot_list_entities` before editing so Claude works with actual entity ids and current component fields. Entity/component scene mutations use Realot's scene undo history where supported. Script code and scene-list edits have different history behavior, so review those changes and save a project backup before large operations.

## Security model

- The bridge server binds only to `127.0.0.1`; it is not exposed on the LAN or public internet.
- The local token is stored outside the project at `~/.realot-studio-mcp/config.json` (on Windows, under your user home directory). `--show-token` prints it again when needed.
- Browser pairing requires the token and an allowed `Origin`. Default rules support localhost development, `realot.studio`, Cloudflare Pages `*.pages.dev`, and Replit preview origins. Modern browsers may also show a local/loopback-network permission prompt when an HTTPS page connects to `127.0.0.1`; allow it to use the bridge. For a different custom domain, edit `allowedOrigins` in the local config to add its exact origin, for example `https://editor.example.com`.
- You can override allowed origins for a process with the environment variable `REALOT_ALLOWED_ORIGINS`, as a comma-separated list.
- Scene and script information is sent to Claude as tool results when Claude requests it. Realot does not send it to a Realot-hosted service through this bridge.
- Keep the pairing token private. If you think it was exposed, stop Claude Desktop, remove the `~/.realot-studio-mcp/config.json` file, run `--show-token` again to generate a new token, and update the editor pairing.

## Troubleshooting

- **AI Bridge cannot connect:** make sure Claude Desktop is running with the `realot-studio` server enabled. `realot_bridge_status` should show the local process as listening. Allow the browser's local/loopback-network permission prompt if it appears, then re-pair in the editor.
- **Origin blocked:** add your exact editor origin to `allowedOrigins` in the config file, then restart Claude Desktop.
- **Port already in use:** close duplicate Realot MCP server processes. If you change `REALOT_MCP_PORT`, also change `BRIDGE_PORT` in `project/editor/mcp/EditorBridge.js` to the same port, then restart the editor and Claude Desktop.
- **Project changes aren't stored:** call `realot_save_project`. If the result says there is no launcher autosave target, choose **File → Save Project** inside the editor to download a `.zip` backup.
- **Nothing is paired:** the server can appear in Claude while the browser is disconnected. The editor's AI Bridge panel must say **Connected** before scene/script tools can operate.


## Hosted website mode (no terminal for end users)

The editor now includes a hosted-relay mode in the **AI Bridge** panel. It creates a session, connects the open editor over secure WebSocket, and displays the remote MCP URL and bearer token for Claude. This is the mode intended to feel like a hosted integration: ordinary users do not run Node.js or terminal commands.

The relay must first be deployed by the Realot operator. See [`HOSTED-RELAY.md`](./HOSTED-RELAY.md) and [`cloudflare-worker.js`](./cloudflare-worker.js). The ZIP contains deployment source, not a live hosted service. The user still needs to add/authorize the custom remote MCP connector in Claude's settings. Hosted mode only works while the paired editor is open; it does not upload a cloud project or provide offline access.
