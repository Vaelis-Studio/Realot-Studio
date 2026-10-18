/**
 * bridge-config.js — the ONE setting the engine's builder fills in.
 *
 * Deploy the relay (see relay/README.md) once, then paste its address here:
 *   export const DEFAULT_RELAY_URL = "https://realot-bridge.yourname.workers.dev";
 *
 * With this set, every user of your hosted engine just presses
 * Claude → Connect and adds ONE link to Claude. They never see Cloudflare,
 * never deploy anything, and each user gets their own private secret link.
 * Leave it empty and the Claude panel shows the full builder setup instead.
 */
export const DEFAULT_RELAY_URL = "";
