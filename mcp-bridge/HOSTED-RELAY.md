# Realot Studio Hosted MCP Relay

This Worker is the hosted transport for Realot's **currently open browser editor**. It is not a project-hosting service. The browser editor holds the live scene and script state; the relay forwards authenticated MCP requests to that editor while its WebSocket is connected. When the editor disconnects, tool calls fail closed.

## Deployment status

The source is included and ready for deployment, but it is **not deployed by this ZIP**. A Realot operator must deploy it to a Cloudflare account and configure the resulting HTTPS Worker URL in the Realot website (for example, by setting `window.REALOT_MCP_RELAY_URL` before the editor bundle loads). Do not publish a made-up `workers.dev` URL: the actual hostname is assigned by Cloudflare.

## Deploy from Cloudflare's dashboard

1. In Cloudflare, create a Worker named `realot-mcp-relay` and use the source in `cloudflare-worker.js` as its module worker code.
2. Enable the Durable Objects binding named `REALOT_SESSIONS`, class `RealotSession`, and create the SQLite-backed class migration shown in `wrangler.toml`. If the dashboard editor does not support importing `cloudflare:workers` or defining the migration, deploy this Worker from a local development environment using Wrangler and the included config; that is a one-time operator action, not something end users do.
3. Deploy, note the real HTTPS Worker URL, and set that URL as `window.REALOT_MCP_RELAY_URL` in the editor page (or paste it into the AI Bridge panel).
4. Verify `GET /health` returns `{ "service": "realot-mcp-relay", "status": "ok", "version": "1.0.0" }`.
5. Test with a disposable project before recommending the connector to users.

## End-user flow

1. Open a Realot project in the browser and open **AI Bridge**.
2. Confirm the deployed HTTPS relay URL is filled in, then choose **Create session & connect**.
3. Copy the generated MCP URL and bearer token into a custom remote MCP connector in Claude. Use the token as a Bearer `Authorization` credential if Claude's connector setup offers request headers. The user may need to add the connector in Claude's settings; Realot cannot silently add a connector to a user's Claude account.
4. Keep the project editor open while Claude uses the tools. Disconnect in Realot when finished. If the editor closes or disconnects, tool calls fail closed.

## Security and privacy notes

- Each session has a random UUID and 256-bit random bearer token. The Worker stores a SHA-256 token hash in that session's Durable Object.
- The editor authenticates its WebSocket using the token in a first message rather than placing the token in the WebSocket URL.
- MCP calls require the bearer token and an authenticated live editor connection.
- The Worker routes tool requests and responses only; it does not save a project archive or scene/script database. Requests and results necessarily transit the relay and are also shared with Claude when its tools are used.
- This implementation has no user accounts, billing, OAuth authorization-code flow, or organization management. The bearer token is the authorization secret; anyone who obtains it can control the paired open project. Do not share it publicly.
- Review and test authorization, rate limiting, abuse controls, error handling, and lifecycle behavior before a public production launch. The included code has not been deployed to a live Cloudflare account or tested against a real Claude connector in this environment.
