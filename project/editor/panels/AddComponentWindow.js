/**
 * editor/panels/AddComponentWindow.js
 *
 * Modal popup listing every component type not yet attached to the
 * selected entity, with a live search box, so the user can add one.
 * Opened from the Inspector's "Add Component" button — same convention
 * as ScriptPickerWindow.js's "Load Script" popup and
 * SpritePickerWindow.js's "Choose Sprite" popup, both already modeled
 * this way (centered modal, backdrop click to close, scrollable list)
 * instead of Inspector.js's old inline absolute-positioned dropdown,
 * which had no max-height/overflow at all — with enough component
 * types available the menu grew taller than the Inspector panel and
 * ran off the bottom of the screen, making the lowest entries
 * impossible to click. A proper scrolling modal (like every other
 * picker popup already uses) fixes that regardless of how many
 * component types the list ever grows to.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { icon } from "../icons/IconLibrary.js";
import { RIGIDBODY_2D } from "../../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D } from "../../runtime/components/Collider2D.js";
import { CHARACTER_CONTROLLER } from "../../runtime/components/CharacterController.js";
import { SPRITE_ANIMATION } from "../../runtime/components/SpriteAnimation.js";
import { SPRITE_RENDERER } from "../../runtime/components/SpriteRenderer.js";
import { SHAPE_RENDERER } from "../../runtime/components/ShapeRenderer.js";
import { STROKE_PATH } from "../../runtime/components/StrokePath.js";
import { LIGHT } from "../../runtime/components/Light.js";
import { AUDIO_SOURCE } from "../../runtime/components/AudioSource.js";
import { AUDIO_LISTENER } from "../../runtime/components/AudioListener.js";
import { SHADOW_CASTER } from "../../runtime/components/ShadowCaster.js";
import { LIGHTING_SETTINGS } from "../../runtime/components/LightingSettings.js";
import { TILESET } from "../../runtime/components/Tileset.js";
import { TILEMAP } from "../../runtime/components/Tilemap.js";
import { NAV_WORLD_2D } from "../../runtime/components/NavWorld2D.js";
import { NAV_AGENT_2D } from "../../runtime/components/NavAgent2D.js";
import { TEXT_RENDERER } from "../../runtime/components/TextRenderer.js";
import { SPEECH_BUBBLE } from "../../runtime/components/SpeechBubble.js";
import { CHAT_LOG } from "../../runtime/components/ChatLog.js";
import { TEXT_INPUT } from "../../runtime/components/TextInput.js";
import { JOYSTICK } from "../../runtime/components/Joystick.js";
import { JOINT_2D } from "../../runtime/components/Joint2D.js";

/**
 * Same component-type list Inspector.js's "Add Component" button used
 * to build inline — moved here so this standalone modal (opened over
 * the WHOLE editor, not nested inside the Inspector panel's own DOM)
 * can compute it independently of Inspector's per-render locals.
 * @returns {{name:string,label:string}[]}
 */
function _computeAvailableToAdd(entity) {
  return [
    !entity.getComponent(RIGIDBODY_2D) && { name: "Rigidbody2D", label: "Rigidbody 2D" },
    !entity.getComponent(COLLIDER_2D) && { name: "Collider2D", label: "Collider 2D" },
    !entity.getComponent(JOINT_2D) && { name: "Joint2D", label: "Joint 2D" },
    !entity.getComponent(CHARACTER_CONTROLLER) && { name: "CharacterController", label: "Movement Type" },
    !entity.getComponent(SPRITE_RENDERER) && { name: "SpriteRenderer", label: "Sprite Renderer" },
    !entity.getComponent(SPRITE_ANIMATION) && { name: "SpriteAnimation", label: "Sprite Animation" },
    !entity.getComponent(SHAPE_RENDERER) && { name: "ShapeRenderer", label: "Shape Renderer" },
    !entity.getComponent(STROKE_PATH) && { name: "StrokePath", label: "Stroke Path" },
    !entity.getComponent(LIGHT) && { name: "Light", label: "Light" },
    !entity.getComponent(AUDIO_SOURCE) && { name: "AudioSource", label: "Audio Source" },
    !entity.getComponent(AUDIO_LISTENER) && { name: "AudioListener", label: "Audio Listener" },
    !entity.getComponent(SHADOW_CASTER) && { name: "ShadowCaster", label: "Shadow Caster" },
    !entity.getComponent(LIGHTING_SETTINGS) && { name: "LightingSettings", label: "Lighting Settings" },
    !entity.getComponent(TILESET) && { name: "Tileset", label: "Tileset" },
    !entity.getComponent(TILEMAP) && { name: "Tilemap", label: "Tilemap" },
    !entity.getComponent(NAV_WORLD_2D) && { name: "NavWorld2D", label: "Nav World 2D" },
    !entity.getComponent(NAV_AGENT_2D) && { name: "NavAgent2D", label: "Nav Agent 2D" },
    !entity.getComponent(TEXT_RENDERER) && { name: "TextRenderer", label: "Text" },
    !entity.getComponent(SPEECH_BUBBLE) && { name: "SpeechBubble", label: "Speech Bubble" },
    !entity.getComponent(CHAT_LOG) && { name: "ChatLog", label: "Chat Log" },
    !entity.getComponent(TEXT_INPUT) && { name: "TextInput", label: "Text Input" },
    !entity.getComponent(JOYSTICK) && { name: "Joystick", label: "Joystick" },
  ].filter(Boolean);
}

const PANEL_STYLE =
  "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
  "background:#1e2330;border:1px solid #3a4560;border-radius:8px;" +
  "width:360px;max-height:70vh;display:flex;flex-direction:column;" +
  "z-index:1000;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;";

const BACKDROP_STYLE =
  "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:999;";

const HEADER_STYLE =
  "display:flex;align-items:center;justify-content:space-between;" +
  "padding:12px 16px;border-bottom:1px solid #2e3a50;flex-shrink:0;";

const CLOSE_BTN_STYLE =
  "background:none;border:none;color:#8a93a0;cursor:pointer;font-size:16px;" +
  "line-height:1;padding:2px 6px;border-radius:3px;";

const SEARCH_WRAP_STYLE =
  "display:flex;align-items:center;gap:6px;padding:8px 16px;" +
  "border-bottom:1px solid #2e3a50;flex-shrink:0;color:#5a6480;";

const SEARCH_INPUT_STYLE =
  "flex:1;background:#12151d;border:1px solid #2e3a50;border-radius:4px;" +
  "color:#c8d0de;font-size:12px;padding:6px 8px;font-family:inherit;outline:none;";

const ROW_STYLE =
  "display:flex;align-items:center;gap:8px;padding:8px 16px;cursor:pointer;" +
  "color:#c8d0de;font-size:12px;border-bottom:1px solid #232a3a;" +
  "background:none;border:none;border-radius:0;width:100%;text-align:left;font-family:inherit;";

const EMPTY_STYLE =
  "padding:16px;color:#5a6480;font-size:12px;text-align:center;";

export function renderAddComponentWindow() {
  if (!editorState.addComponentMenuOpen) return "";

  const world = editorState.world;
  const entity = world && world.getEntity(editorState.selectedId);
  if (!entity) return "";

  const availableToAdd = _computeAvailableToAdd(entity);

  const filterText = (editorState.addComponentFilter || "").toLowerCase();
  const filtered = filterText
    ? availableToAdd.filter((c) => c.label.toLowerCase().includes(filterText))
    : availableToAdd;

  const rows = availableToAdd.length
    ? (filtered.length
        ? filtered
            .map(
              (c) =>
                '<button type="button" class="addcomp-picker-row" data-action="add-component-choice" data-component="' +
                c.name +
                '" style="' + ROW_STYLE + '" title="Add ' + _escAttr(c.label) + '">' +
                icon("plus", 12) +
                '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _escAttr(c.label) + "</span>" +
                "</button>"
            )
            .join("")
        : '<div style="' + EMPTY_STYLE + '">No components match "' + _escAttr(editorState.addComponentFilter) + '".</div>')
    : '<div style="' + EMPTY_STYLE + '">All available components added.</div>';

  return (
    '<div data-action="close-add-component" style="' + BACKDROP_STYLE + '"></div>' +
    '<div class="addcomp-picker-window" style="' + PANEL_STYLE + '">' +
      '<div style="' + HEADER_STYLE + '">' +
        '<span style="font-size:13px;font-weight:600;color:#c8d0de;">Add Component</span>' +
        '<button data-action="close-add-component" style="' + CLOSE_BTN_STYLE + '">✕</button>' +
      "</div>" +
      (availableToAdd.length
        ? '<div style="' + SEARCH_WRAP_STYLE + '">' +
            icon("search", 12) +
            '<input type="text" id="addcomp-search-input" placeholder="Search components…" value="' +
            _escAttr(editorState.addComponentFilter || "") +
            '" style="' + SEARCH_INPUT_STYLE + '" />' +
          "</div>"
        : "") +
      '<div style="overflow-y:auto;flex:1;">' + rows + "</div>" +
    "</div>"
  );
}

function _escAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
