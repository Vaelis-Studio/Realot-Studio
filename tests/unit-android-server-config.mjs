import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class MemoryStorage {
  #items = new Map();

  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }

  setItem(key, value) {
    this.#items.set(key, String(value));
  }
}

globalThis.localStorage = new MemoryStorage();

const {
  APK_SERVICE_URL,
  ensureAndroidServerKey,
  getActiveAndroidServer,
} = await import("../project/editor/state/ServerConfig.js");

assert.equal(APK_SERVICE_URL, "https://builder--Vaelis-Server.replit.app");

let issuedKeys = 0;
globalThis.fetch = async (url, options) => {
  issuedKeys += 1;
  assert.equal(url, APK_SERVICE_URL + "/api/v1/keys");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Accept, "application/json");
  return new Response(
    JSON.stringify({
      apiKey: "test-session-key-" + issuedKeys,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    }),
    { status: 201, headers: { "Content-Type": "application/json" } }
  );
};

const defaultServer = getActiveAndroidServer();
assert.equal(defaultServer.label, "Vaelis APK Builder");
assert.equal(defaultServer.serverUrl, APK_SERVICE_URL);
assert.equal(defaultServer.apiKey, "");

const readyServer = await ensureAndroidServerKey(defaultServer);
assert.equal(readyServer.apiKey, "test-session-key-1");
assert.equal(readyServer.managedKey, true);
assert.equal(JSON.parse(localStorage.getItem("realot.androidBuildServers")).servers.length, 1);
assert.equal(issuedKeys, 1);

await ensureAndroidServerKey(getActiveAndroidServer());
assert.equal(issuedKeys, 1, "a fresh managed key should be reused");

const storageKey = "realot.androidBuildServers";
const saved = JSON.parse(localStorage.getItem(storageKey));
saved.servers[0].keyExpiresAt = new Date(Date.now() + 1000).toISOString();
localStorage.setItem(storageKey, JSON.stringify(saved));
const renewed = await ensureAndroidServerKey(getActiveAndroidServer());
assert.equal(renewed.apiKey, "test-session-key-2");
assert.equal(issuedKeys, 2, "an expiring managed key should be renewed");

const legacySettings = JSON.parse(localStorage.getItem(storageKey));
legacySettings.servers.push({
  id: "legacy-custom-server",
  label: "Old custom server",
  serverUrl: "https://custom.example",
  apiKey: "old-custom-key",
});
legacySettings.activeId = "legacy-custom-server";
localStorage.setItem(storageKey, JSON.stringify(legacySettings));

const selectedServer = getActiveAndroidServer();
assert.equal(selectedServer.id, "vaelis-apk-builder");
assert.equal(selectedServer.serverUrl, APK_SERVICE_URL);
assert.equal(selectedServer.apiKey, "test-session-key-2");
await ensureAndroidServerKey(selectedServer);
assert.equal(issuedKeys, 2, "the built-in service key should stay active despite legacy custom settings");
assert.equal(
  JSON.parse(localStorage.getItem(storageKey)).servers.find((server) => server.id === "legacy-custom-server").apiKey,
  "old-custom-key",
  "legacy custom settings are ignored but are not silently deleted"
);

const exportWindow = await readFile(new URL("../project/editor/panels/ExportWindow.js", import.meta.url), "utf8");
assert.doesNotMatch(exportWindow, /android-server-(add-open|select|edit-open|delete|form-save)/);
assert.match(exportWindow, /No server or API-key setup is needed/);

console.log("Android server config tests passed.");
