# Realot ⇄ Claude bridge (relay)

The relay is the small free Cloudflare service that links Claude to an open Realot editor.

## You (the engine's builder): set it up ONCE for everybody
1. Put the whole engine, including this `relay` folder, in your GitHub repo.
2. Open your engine → any project → press **Claude** → **Create relay on Cloudflare** → sign in → **Deploy**.
3. Copy the address Cloudflare shows (ends in `.workers.dev`).
4. Open `project/editor/bridge/bridge-config.js`, paste it as `DEFAULT_RELAY_URL`, and redeploy your site.
5. (Recommended) In Cloudflare → your worker → Settings → Variables, set `ALLOWED_ORIGINS` to your site, e.g. `https://yourname.github.io`, so only your engine can use the relay.

## Your users: nothing to install or deploy
They open a project → press **Claude** → **Connect** → **Copy link** → in Claude: *Settings → Connectors → Add custom connector* → paste → Add. Each user gets their own private link; nobody can see anybody else's project.

## Safety
* Nothing connects until the user presses **Connect**; the toolbar dot shows the state.
* The link contains a private key — anyone with it can edit that user's open project. **Make a new private link** replaces it.
* **Read-only** lets Claude look without changing anything. Every change can be undone with Ctrl+Z.
* Limits per user: 90 tool calls per minute, small requests only.

## Cost
Cloudflare's free plan covers a lot (shared across all your users). If the engine grows, the paid Workers plan is about $5/month.

## What Claude can do
get_editor_state, list_entities, get_entity, create_entity, update_component, add_component,
remove_component, delete_entities, select_entities, list_scripts, get_script, write_script,
attach_script, set_playing, get_console, screenshot, undo, redo, save_project.

## For developers
`mcp-core.js` (MCP protocol, shared) · `worker.js` (Cloudflare Worker + Durable Object) ·
`relay-node.mjs` (same relay for local testing: `npm install && npm run local`, address `http://localhost:8787`).
