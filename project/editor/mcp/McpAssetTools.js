import {
  deleteAudioAsset,
  deleteSpriteAsset,
  getAllAudioAssets,
  getAllFrameAssets,
  getAllSpriteAssets,
  getAudioAsset,
  getSpriteAsset,
  importAudioFiles,
  importSpriteFiles,
  registerSpriteAsset,
  renameAudioAsset,
  renameSpriteAsset,
} from "../../runtime/assets/AssetRegistry.js";
import { TILE_ROLE_ORDER } from "../../runtime/components/Tileset.js";
import { getAllPrefabs } from "../../runtime/prefabs/PrefabRegistry.js";
import { getAllScenesData, saveActiveScene } from "../../runtime/scene/SceneManager.js";
import { importGifFrames, importStandaloneImageFrames, importSpriteSheetFrames, importZipImageFrames } from "../animation/AnimationImport.js";
import { loadSingleTileImage, sliceTilesetImageIntoRoles } from "../tileset/TilesetImport.js";
import { editorState, markDirty, pushLog } from "../state/EditorState.js";

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 180 * 1024;
const MAX_UPLOADS = 3;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const uploads = new Map();

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function activeWorld() {
  if (!editorState.world) throw new Error("Open a Realot project in the editor first.");
  return editorState.world;
}

function changed(message) {
  markDirty();
  pushLog("log", "MCP: " + message);
  if (typeof editorState.renderFn === "function") editorState.renderFn();
}

function getUpload(id) {
  if (typeof id !== "string" || !uploads.has(id)) throw new Error("Upload not found or expired. Start a new asset upload.");
  const upload = uploads.get(id);
  if (Date.now() - upload.touchedAt > UPLOAD_TTL_MS) {
    uploads.delete(id);
    throw new Error("Upload expired after 10 minutes. Start a new asset upload.");
  }
  return upload;
}

function cleanExpiredUploads() {
  const now = Date.now();
  for (const [id, upload] of uploads) {
    if (now - upload.touchedAt > UPLOAD_TTL_MS) uploads.delete(id);
  }
}

function safeFilename(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 240) {
    throw new Error("file_name must be a non-empty filename of at most 240 characters.");
  }
  const base = name.trim().split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!base || base === "." || base === "..") throw new Error("file_name is not a valid filename.");
  return base;
}

function validateUploadPurpose(params) {
  const purposes = new Set([
    "sprite", "audio", "animation-image", "animation-zip", "animation-gif",
    "animation-sheet", "tileset-sheet", "tileset-tile", "project-zip",
  ]);
  if (!purposes.has(params.purpose)) throw new Error("Unsupported asset upload purpose.");
  const name = safeFilename(params.file_name);
  const mime = typeof params.mime_type === "string" ? params.mime_type.trim().toLowerCase() : "";
  if (params.purpose === "audio") {
    if (!mime.startsWith("audio/")) throw new Error("Audio uploads need an audio/* MIME type.");
  } else if (params.purpose === "project-zip") {
    if (!/\.(realot|zip)$/i.test(name)) throw new Error("project-zip requires a .realot or .zip project file.");
    if (!["application/zip", "application/x-zip-compressed", "application/octet-stream", "application/x-realot-project"].includes(mime)) {
      throw new Error("project-zip needs an application/zip or application/octet-stream MIME type.");
    }
  } else if (params.purpose === "animation-zip") {
    if (!/\.zip$/i.test(name)) throw new Error("animation-zip requires a .zip file.");
    if (!["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(mime)) {
      throw new Error("animation-zip needs an application/zip MIME type.");
    }
  } else {
    if (!mime.startsWith("image/")) throw new Error("This upload purpose needs an image/* MIME type.");
    if (params.purpose === "animation-gif" && mime !== "image/gif" && !/\.gif$/i.test(name)) {
      throw new Error("animation-gif requires a GIF image.");
    }
  }
  if (params.purpose.startsWith("animation-")) {
    const world = activeWorld();
    const entity = world.getEntity(params.entity_id);
    const animation = entity && entity.getComponent("SpriteAnimation");
    if (!entity || !animation) throw new Error("entity_id must identify an entity with a SpriteAnimation component.");
    if (!animation.clips.some((clip) => clip.id === params.clip_id)) {
      throw new Error("clip_id must identify an animation clip on that entity.");
    }
  }
  if (params.purpose === "tileset-sheet" || params.purpose === "tileset-tile") {
    const entity = activeWorld().getEntity(params.tileset_entity_id);
    if (!entity || !entity.getComponent("Tileset")) {
      throw new Error("tileset_entity_id must identify an entity with a Tileset component.");
    }
    if (params.purpose === "tileset-tile" && !TILE_ROLE_ORDER.includes(params.role)) {
      throw new Error("role must be one of the 16 tile roles returned by list_tilesets.");
    }
  }
  if (params.purpose === "animation-sheet") {
    const hasCols = params.grid_cols !== undefined;
    const hasRows = params.grid_rows !== undefined;
    if (hasCols !== hasRows) throw new Error("Provide both grid_cols and grid_rows, or omit both for auto-detection.");
    if (hasCols && (!Number.isInteger(params.grid_cols) || !Number.isInteger(params.grid_rows) ||
      params.grid_cols < 1 || params.grid_cols > 64 || params.grid_rows < 1 || params.grid_rows > 64 ||
      params.grid_cols * params.grid_rows > 512)) {
      throw new Error("Sprite-sheet grid dimensions must be positive and contain no more than 512 cells.");
    }
  }
  return { name, mime };
}

function beginUpload(params) {
  cleanExpiredUploads();
  if (uploads.size >= MAX_UPLOADS) throw new Error("There are already 3 active uploads. Complete, cancel, or wait for one to expire.");
  const size = params.size_bytes;
  if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    throw new Error("size_bytes must be between 1 byte and 12 MiB. Import larger files in the editor's Project panel.");
  }
  const { name, mime } = validateUploadPurpose(params);
  const id = crypto.randomUUID();
  uploads.set(id, {
    id,
    fileName: name,
    mimeType: mime,
    sizeBytes: size,
    purpose: params.purpose,
    entityId: params.entity_id || null,
    clipId: params.clip_id || null,
    tilesetEntityId: params.tileset_entity_id || null,
    role: params.role || null,
    gridCols: params.grid_cols,
    gridRows: params.grid_rows,
    chunks: [],
    receivedBytes: 0,
    touchedAt: Date.now(),
  });
  return text({
    upload_id: id,
    chunk_size_bytes: UPLOAD_CHUNK_BYTES,
    max_size_bytes: MAX_UPLOAD_BYTES,
    next_chunk_index: 0,
    instructions: "Send append_asset_upload_chunk calls with sequential chunk_index values starting at 0. Encode each chunk independently as base64. Use exactly chunk_size_bytes until the final chunk.",
  });
}

function appendUploadChunk(params) {
  const upload = getUpload(params.upload_id);
  const index = params.chunk_index;
  const data = params.chunk_base64;
  if (!Number.isInteger(index) || index < 0) throw new Error("chunk_index must be a non-negative integer.");
  if (typeof data !== "string" || !data || data.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4) {
    throw new Error("chunk_base64 must contain one base64-encoded chunk of at most 180 KiB.");
  }
  let binary;
  try { binary = atob(data); } catch (_) { throw new Error("chunk_base64 is not valid base64."); }
  if (!binary.length || binary.length > UPLOAD_CHUNK_BYTES) throw new Error("Decoded chunk size must be between 1 byte and 180 KiB.");
  if (index < upload.chunks.length) {
    if (upload.chunks[index] !== data) throw new Error("This chunk index was already received with different data.");
    upload.touchedAt = Date.now();
    return text({ accepted: true, duplicate: true, next_chunk_index: upload.chunks.length, received_bytes: upload.receivedBytes });
  }
  if (index !== upload.chunks.length) throw new Error("Chunks must arrive in order. Expected chunk_index " + upload.chunks.length + ".");
  if (upload.receivedBytes + binary.length > upload.sizeBytes) throw new Error("Chunk would exceed the declared size_bytes.");
  const finalChunk = upload.receivedBytes + binary.length === upload.sizeBytes;
  if (!finalChunk && binary.length !== UPLOAD_CHUNK_BYTES) {
    throw new Error("Non-final chunks must be exactly 180 KiB. The final chunk must bring the received byte count to size_bytes.");
  }
  upload.chunks.push(data);
  upload.receivedBytes += binary.length;
  upload.touchedAt = Date.now();
  return text({
    accepted: true,
    next_chunk_index: upload.chunks.length,
    received_bytes: upload.receivedBytes,
    remaining_bytes: upload.sizeBytes - upload.receivedBytes,
  });
}

function buildFile(upload) {
  if (upload.receivedBytes !== upload.sizeBytes) {
    throw new Error("Upload is incomplete: received " + upload.receivedBytes + " of " + upload.sizeBytes + " bytes.");
  }
  const binary = atob(upload.chunks.join(""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], upload.fileName, { type: upload.mimeType });
}

function targetClip(upload) {
  const entity = activeWorld().getEntity(upload.entityId);
  const animation = entity && entity.getComponent("SpriteAnimation");
  const clip = animation && animation.clips.find((item) => item.id === upload.clipId);
  if (!entity || !animation || !clip) throw new Error("The target animation or clip no longer exists. The uploaded file was kept; cancel or restart the upload after selecting a valid clip.");
  return { entity, animation, clip };
}

async function importUpload(upload) {
  const file = buildFile(upload);
  switch (upload.purpose) {
    case "project-zip": {
      // Replaces the WHOLE project. The editor shows its own confirmation prompts
      // (replace-everything, and a trust prompt when the project contains scripts),
      // so the person at the editor must approve; a decline aborts the import.
      const { loadProjectFromFile } = await import("../state/EditorEvents.js");
      const loaded = await loadProjectFromFile(file);
      if (!loaded) throw new Error("The project was not loaded: it was declined in the editor or is not a valid Realot project. Check the editor console.");
      return { kind: "project", fileName: upload.fileName, projectName: editorState.projectName || null };
    }
    case "sprite": {
      if (upload.mimeType === "image/gif" || /\.gif$/i.test(upload.fileName)) {
        const { frames, fps } = await importGifFrames(file);
        if (!frames.length) throw new Error("The GIF did not contain any readable frames.");
        const first = frames[0];
        const record = {
          key: first.spriteKey,
          name: upload.fileName.replace(/\.[^.]+$/, ""),
          dataUrl: first.dataUrl,
          width: first.width,
          height: first.height,
          gifFrames: frames.map((frame) => frame.spriteKey),
          gifFps: fps,
        };
        registerSpriteAsset(record);
        return { kind: "sprite", ...record, frameCount: frames.length };
      }
      const imported = await importSpriteFiles([file]);
      if (!imported.length) throw new Error("The editor could not import this image format.");
      return { kind: "sprite", ...imported[0] };
    }
    case "audio": {
      const imported = await importAudioFiles([file]);
      if (!imported.length) throw new Error("The editor could not import this audio format.");
      return { kind: "audio", ...imported[0] };
    }
    case "animation-image":
    case "animation-zip":
    case "animation-gif":
    case "animation-sheet": {
      const { entity, clip } = targetClip(upload);
      let frames;
      let fps = null;
      if (upload.purpose === "animation-zip") {
        frames = await importZipImageFrames(file);
      } else if (upload.purpose === "animation-gif") {
        const result = await importGifFrames(file);
        frames = result.frames;
        fps = result.fps;
      } else if (upload.purpose === "animation-sheet") {
        const grid = upload.gridCols
          ? { cols: upload.gridCols, rows: upload.gridRows }
          : undefined;
        frames = await importSpriteSheetFrames(file, grid);
      } else {
        frames = await importStandaloneImageFrames([file]);
      }
      if (!frames.length) throw new Error("No animation frames were imported from this file.");
      clip.frames.push(...frames);
      if (fps) clip.fps = fps;
      editorState.selectedId = entity.id;
      editorState.selectedIds = [entity.id];
      editorState.animOpen = true;
      editorState.anim.editingClipId = clip.id;
      editorState.anim.previewFrameIndex = Math.max(0, clip.frames.length - frames.length);
      editorState.anim.previewPlaying = false;
      return { kind: "animation", entityId: entity.id, clipId: clip.id, clipName: clip.name, framesAdded: frames.length, totalFrames: clip.frames.length, fps: fps || clip.fps };
    }
    case "tileset-sheet":
    case "tileset-tile": {
      const world = activeWorld();
      const entity = world.getEntity(upload.tilesetEntityId);
      const tileset = entity && entity.getComponent("Tileset");
      if (!tileset) throw new Error("The target Tileset no longer exists.");
      const added = [];
      if (upload.purpose === "tileset-sheet") {
        const roleMap = await sliceTilesetImageIntoRoles(file);
        for (const role of TILE_ROLE_ORDER) {
          const produced = roleMap[role];
          if (!produced) continue;
          tileset.slots[role] = produced.spriteKey;
          registerSpriteAsset({
            key: produced.spriteKey,
            name: tileset.name + "_" + role,
            dataUrl: produced.dataUrl,
            width: tileset.tileWidth,
            height: tileset.tileHeight,
          });
          added.push({ role, spriteKey: produced.spriteKey });
        }
      } else {
        const produced = await loadSingleTileImage(file);
        tileset.slots[upload.role] = produced.spriteKey;
        registerSpriteAsset({
          key: produced.spriteKey,
          name: tileset.name + "_" + upload.role,
          dataUrl: produced.dataUrl,
          width: tileset.tileWidth,
          height: tileset.tileHeight,
        });
        added.push({ role: upload.role, spriteKey: produced.spriteKey });
      }
      editorState.tilesetPanel.open = true;
      editorState.tilesetPanel.entityId = entity.id;
      editorState.selectedId = entity.id;
      editorState.selectedIds = [entity.id];
      return { kind: "tileset", entityId: entity.id, tileset: tileset.name, slotsUpdated: added };
    }
    default:
      throw new Error("Unsupported upload purpose.");
  }
}

function mimeFromDataUrl(dataUrl) {
  return typeof dataUrl === "string" ? (dataUrl.match(/^data:([^;,]+)/i) || [])[1] || null : null;
}

function assetSummary(asset, kind, frame = false) {
  return {
    key: asset.key,
    name: asset.name,
    kind,
    ...(frame ? { animationFrame: true } : {}),
    mimeType: mimeFromDataUrl(asset.dataUrl),
    ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
    ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
    ...(Number.isFinite(asset.duration) ? { duration: asset.duration } : {}),
    ...(Array.isArray(asset.gifFrames) ? { gifFrameCount: asset.gifFrames.length, gifFps: asset.gifFps || null } : {}),
  };
}

function assetReferences(key, kind) {
  const refs = [];
  const referenceFields = kind === "audio" ? new Set(["audioKey"]) : new Set(["spriteKey", "textureKey"]);
  const scan = (value, path = "", parentKey = "", depth = 0) => {
    if (depth > 24 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (value === key && (referenceFields.has(parentKey) || /\.slots\./.test(path))) refs.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, path + "[" + index + "]", parentKey, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    for (const [field, child] of Object.entries(value)) {
      scan(child, path ? path + "." + field : field, field, depth + 1);
    }
  };
  try {
    saveActiveScene(activeWorld());
    for (const scene of getAllScenesData() || []) scan(scene, "scene:" + (scene.name || scene.id || "unknown"));
  } catch (_) {
    // The active scene is scanned below even if the scene manager is not initialized.
  }
  for (const target of activeWorld().getAllEntities()) {
    const components = target.components instanceof Map ? Object.fromEntries(target.components.entries()) : target.components;
    scan(components, "active-scene:" + (target.name || target.id || "entity"));
  }
  try {
    for (const prefab of getAllPrefabs() || []) scan(prefab, "prefab:" + (prefab.name || prefab.id || "unknown"));
  } catch (_) { /* older projects may not have prefab data loaded */ }
  return [...new Set(refs)].slice(0, 100);
}

export async function runMcpAssetTool(name, params = {}) {
  switch (name) {
    case "list_assets": {
      const kind = params.kind || "all";
      if (!["all", "sprite", "audio", "frame"].includes(kind)) throw new Error("kind must be all, sprite, audio, or frame.");
      const assets = [
        ...(kind === "all" || kind === "sprite" ? getAllSpriteAssets().map((asset) => assetSummary(asset, "sprite")) : []),
        ...(kind === "all" || kind === "frame" ? getAllFrameAssets().map((asset) => assetSummary(asset, "frame", true)) : []),
        ...(kind === "all" || kind === "audio" ? getAllAudioAssets().map((asset) => assetSummary(asset, "audio")) : []),
      ];
      const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
      const filtered = query ? assets.filter((asset) => (asset.name + " " + asset.key).toLowerCase().includes(query)) : assets;
      const limit = Number.isInteger(params.limit) ? Math.max(1, Math.min(params.limit, 500)) : 200;
      return text({ total: filtered.length, assets: filtered.slice(0, limit), truncated: filtered.length > limit });
    }
    case "begin_asset_upload":
      return beginUpload(params);
    case "append_asset_upload_chunk":
      return appendUploadChunk(params);
    case "cancel_asset_upload": {
      const upload = getUpload(params.upload_id);
      uploads.delete(upload.id);
      return text({ cancelled: true, upload_id: upload.id, discarded_bytes: upload.receivedBytes });
    }
    case "complete_asset_upload": {
      const upload = getUpload(params.upload_id);
      const imported = await importUpload(upload);
      uploads.delete(upload.id);
      changed("imported " + upload.fileName + " as " + imported.kind);
      return text({ imported, upload_id: upload.id });
    }
    case "rename_asset": {
      if (typeof params.key !== "string" || !params.key.trim()) throw new Error("key is required.");
      if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 160) throw new Error("name must be between 1 and 160 characters.");
      const renamed = params.kind === "audio"
        ? renameAudioAsset(params.key, params.name.trim())
        : (params.kind === "sprite" || params.kind === "frame") && renameSpriteAsset(params.key, params.name.trim());
      if (!renamed) throw new Error("Asset not found or unsupported kind.");
      changed("renamed asset " + params.key);
      return text({ renamed: true, asset: assetSummary(params.kind === "audio" ? getAudioAsset(params.key) : getSpriteAsset(params.key), params.kind, params.kind === "frame") });
    }
    case "delete_asset": {
      const kind = params.kind;
      const asset = kind === "audio" ? getAudioAsset(params.key) : (kind === "sprite" || kind === "frame") ? getSpriteAsset(params.key) : null;
      if (!asset) throw new Error("Asset not found. Use list_assets to see current keys.");
      const references = assetReferences(params.key, kind);
      if (references.length && params.confirm !== true) {
        return text({ deleted: false, confirmation_required: true, asset: assetSummary(asset, kind, kind === "frame"), references, note: "Set confirm=true only after deciding to leave these references unresolved." });
      }
      const deleted = kind === "audio" ? deleteAudioAsset(params.key) : deleteSpriteAsset(params.key);
      if (!deleted) throw new Error("Asset could not be deleted.");
      changed("deleted " + kind + " asset " + params.key);
      return text({ deleted: true, key: params.key, kind, danglingReferences: references });
    }
    default:
      return null;
  }
}
