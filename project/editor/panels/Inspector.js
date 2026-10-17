/**
 * editor/panels/Inspector.js
 *
 * Component inspector for the currently selected entity. Reads real
 * component data from the entity (via editorState.world) and renders
 * editable fields wired with data-field/data-axis attributes that
 * EditorEvents.js uses to write values back onto the live component.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn, row, numInput, vec3Input, vec2Input, dropdownInput, section } from "./UIComponents.js";

/**
 * Escapes project data (entity / asset / script names, ids...) before it is
 * placed into HTML built by string concatenation. Project files can come from
 * other people, so never insert these raw.
 */
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
import { editorState } from "../state/EditorState.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { CAMERA, CameraAspectMode, ScalingMode } from "../../runtime/components/Camera.js";
import { SPRITE_RENDERER } from "../../runtime/components/SpriteRenderer.js";
import { SHAPE_RENDERER, ShapeType } from "../../runtime/components/ShapeRenderer.js";
import { STROKE_PATH, StrokePathTextureMode, StrokePathJointMode, StrokePathCapMode } from "../../runtime/components/StrokePath.js";
import { TEXT_RENDERER } from "../../runtime/components/TextRenderer.js";
import { SPEECH_BUBBLE } from "../../runtime/components/SpeechBubble.js";
import { CHAT_LOG } from "../../runtime/components/ChatLog.js";
import { TEXT_INPUT } from "../../runtime/components/TextInput.js";
import { JOYSTICK, JoystickPositionMode } from "../../runtime/components/Joystick.js";
import { RIGIDBODY_2D, BodyType } from "../../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { JOINT_2D, JointType2D } from "../../runtime/components/Joint2D.js";
import { getNamedLayers } from "../state/PhysicsLayers.js";
import { CHARACTER_CONTROLLER, ControllerType, PatrolMode, PatrolAxis } from "../../runtime/components/CharacterController.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";
import { SHADOW_CASTER } from "../../runtime/components/ShadowCaster.js";
import { LIGHTING_SETTINGS } from "../../runtime/components/LightingSettings.js";
import { SPRITE_ANIMATION } from "../../runtime/components/SpriteAnimation.js";
import { AUDIO_SOURCE } from "../../runtime/components/AudioSource.js";
import { AUDIO_LISTENER } from "../../runtime/components/AudioListener.js";
import { TILESET } from "../../runtime/components/Tileset.js";
import { TILEMAP } from "../../runtime/components/Tilemap.js";
import { NAV_WORLD_2D } from "../../runtime/components/NavWorld2D.js";
import { NAV_AGENT_2D } from "../../runtime/components/NavAgent2D.js";
import { getNamedNavAreas } from "../state/NavAreas.js";
import { SCRIPT } from "../../runtime/components/Script.js";
import { ShadowMode } from "../../runtime/systems/LightingQuality.js";
import { getCameraResolution } from "../../runtime/core/CameraUtils.js";
import { getSpriteAsset, getAudioAsset, getAllAudioAssets } from "../../runtime/assets/AssetRegistry.js";
import { getPrefab } from "../../runtime/prefabs/PrefabRegistry.js";

import { getTagNames } from "../state/Tags.js";

// Tags that ship with every project and cannot be deleted.
// Only "Untagged" is truly protected — every entity needs a valid
// fallback tag, and Tags.js's deleteTag() refuses to remove it for the
// same reason. "Player"/"Enemy" are just pre-seeded starting tags, not
// special, so they get the same delete button any custom tag does.
const BUILTIN_TAGS = new Set(["Untagged"]);

export function renderInspector() {
  const world = editorState.world;
  const entity = world ? world.getEntity(editorState.selectedId) : null;

  if (!entity) {
    return (
      '<div class="inspector-panel">' +
      '<div class="tabbar">' +
      tabBtn(true, "Inspector", "info") +
      "</div>" +
      '<div class="inspector-empty">No object selected</div>' +
      "</div>"
    );
  }

  let body = "";

  const transform = entity.getComponent(TRANSFORM);
  if (transform) {
    body += section(
      editorState.sectionsOpen,
      "transform",
      "Transform",
      "move",
      row("Position", vec3Input(transform.x, transform.y, transform.z, "Transform.position")) +
        row("Rotation", numInput("°", transform.rotation, "Transform.rotation")) +
        row("Scale", vec2Input(transform.scaleX, transform.scaleY, "Transform.scale"))
    );
  }

  const camera = entity.getComponent(CAMERA);
  if (camera) {
    const resolution = getCameraResolution(camera);

    let resolutionFieldsHtml = "";
    if (camera.aspectMode === CameraAspectMode.LANDSCAPE) {
      resolutionFieldsHtml = row(
        "Resolution",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("W", camera.landscapeWidth, "Camera.landscapeWidth") +
          numInput("H", camera.landscapeHeight, "Camera.landscapeHeight") +
          "</div>"
      );
    } else if (camera.aspectMode === CameraAspectMode.PORTRAIT) {
      resolutionFieldsHtml = row(
        "Resolution",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("W", camera.portraitWidth, "Camera.portraitWidth") +
          numInput("H", camera.portraitHeight, "Camera.portraitHeight") +
          "</div>"
      );
    } else if (camera.aspectMode === CameraAspectMode.SQUARE) {
      resolutionFieldsHtml = row("Size (px)", numInput("", camera.squareSize, "Camera.squareSize"));
    } else {
      resolutionFieldsHtml = row(
        "Resolution",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("W", camera.customWidth, "Camera.customWidth") +
          numInput("H", camera.customHeight, "Camera.customHeight") +
          "</div>"
      );
    }

    body += section(
      editorState.sectionsOpen,
      "camera",
      "Camera",
      "camera",
      row(
        "Background",
        '<input type="color" class="color-swatch-input" value="' +
          camera.backgroundColor +
          '" data-field="Camera.backgroundColor" />'
      ) +
        row("Zoom", numInput("", camera.size, "Camera.size")) +
        row(
          "Orientation",
          dropdownInput(
            [CameraAspectMode.LANDSCAPE, CameraAspectMode.PORTRAIT, CameraAspectMode.SQUARE, CameraAspectMode.CUSTOM],
            camera.aspectMode,
            "Camera.aspectMode"
          )
        ) +
        resolutionFieldsHtml +
        '<div class="row"><span class="row-label">Export Size</span><div class="row-content"><span class="export-size-readout">' +
        resolution.width + " x " + resolution.height + " px</span></div></div>" +
        row(
          "Pseudo 3D (Z Scale)",
          '<input type="checkbox" data-field="Camera.enablePseudo3D" style="accent-color:#2C5D87;margin:0;"' +
            (camera.enablePseudo3D ? " checked" : "") +
            "/>"
        ) +
        '<div class="static-body-note" style="border-top:1px solid #2e3a50;margin:8px 0;padding-top:8px;color:#8a93a0;font-size:10px;">SCREEN SCALING — how the reference resolution above fits any device screen</div>' +
        row(
          "Scaling Mode",
          dropdownInput([ScalingMode.EXPAND, ScalingMode.FIT, ScalingMode.FILL, ScalingMode.STRETCH], camera.scalingMode, "Camera.scalingMode")
        ) +
        // Each control below only appears for the ONE scaling mode it
        // actually affects (see computeScreenFit() in CameraUtils.js) —
        // shown/hidden by camera.scalingMode rather than always-visible,
        // so there's never a checkbox sitting there ticked "on" while
        // silently doing nothing because a different mode is selected.
        (camera.scalingMode === ScalingMode.EXPAND
          ? row(
              "Keep Height",
              '<input type="checkbox" data-field="Camera.keepHeight" style="accent-color:#2C5D87;margin:0;"' +
                (camera.keepHeight ? " checked" : "") +
                '/> <span class="inspector-note-inline" style="color:#8a94a6;font-size:10px;margin-left:6px;">Checked keeps height exact (width expands/contracts); unchecked keeps width exact</span>'
            ) +
            row(
              "Aspect Ratio Lock",
              '<input type="checkbox" data-field="Camera.aspectRatioLock" style="accent-color:#2C5D87;margin:0;"' +
                (camera.aspectRatioLock ? " checked" : "") +
                '/> <span class="inspector-note-inline" style="color:#8a94a6;font-size:10px;margin-left:6px;">On: behaves like Fit instead (aspect ratio never drifts). Off: lets Expand show more/less world per device</span>'
            )
          : "") +
        (camera.scalingMode === ScalingMode.STRETCH
          ? row(
              "Allow Stretching",
              '<input type="checkbox" data-field="Camera.allowStretching" style="accent-color:#2C5D87;margin:0;"' +
                (camera.allowStretching ? " checked" : "") +
                '/> <span class="inspector-note-inline" style="color:#8a94a6;font-size:10px;margin-left:6px;">On: real distorting stretch to fill exactly. Off: behaves like Fit instead (safe default)</span>'
            )
          : "") +
        row(
          "Integer Scaling",
          '<input type="checkbox" data-field="Camera.integerScaling" style="accent-color:#2C5D87;margin:0;"' +
            (camera.integerScaling ? " checked" : "") +
            (camera.scalingMode === ScalingMode.STRETCH && camera.allowStretching ? " disabled" : "") +
            '/> <span class="inspector-note-inline" style="color:#8a94a6;font-size:10px;margin-left:6px;">' +
            (camera.scalingMode === ScalingMode.STRETCH && camera.allowStretching
              ? "No effect on a real Stretch — that mode always fills exactly, by definition"
              : "Rounds the scale to whole numbers — crisp pixel art, no blurry fractional scaling") +
            "</span>"
        ) +
        row(
          "Letterboxing",
          dropdownInput(["Auto", "On", "Off"], camera.letterboxing, "Camera.letterboxing") +
            (camera.scalingMode !== ScalingMode.FIT
              ? '<div class="static-body-note" style="color:#8a94a6;font-size:10px;margin-top:3px;">Auto only paints in Fit — set to "On" to force bars in ' + camera.scalingMode + " too</div>"
              : "")
        ) +
        row(
          "Pillarboxing",
          dropdownInput(["Auto", "On", "Off"], camera.pillarboxing, "Camera.pillarboxing") +
            (camera.scalingMode !== ScalingMode.FIT
              ? '<div class="static-body-note" style="color:#8a94a6;font-size:10px;margin-top:3px;">Auto only paints in Fit — set to "On" to force bars in ' + camera.scalingMode + " too</div>"
              : "")
        ) +
        row(
          "Bar Color",
          '<input type="color" class="color-swatch-input" value="' + camera.barColor +
            '" data-field="Camera.barColor" />'
        )
    );
  }

  const spriteRenderer = entity.getComponent(SPRITE_RENDERER);
  if (spriteRenderer) {
    const spriteAsset = spriteRenderer.spriteKey ? getSpriteAsset(spriteRenderer.spriteKey) : null;
    const spriteDisplayName = spriteAsset ? spriteAsset.name : spriteRenderer.spriteKey || "None";
    body += section(
      editorState.sectionsOpen,
      "sprite",
      "Sprite Renderer",
      "layers",
      row(
        "Sprite",
        '<div class="sprite-row"><div class="sprite-box">' +
          spriteDisplayName +
          '</div><button class="sprite-pick" data-action="open-sprite-picker" title="Choose a different sprite"><span></span></button></div>'
      ) +
        row(
          "Color",
          '<input type="color" class="color-swatch-input" value="' +
            spriteRenderer.color +
            '" data-field="SpriteRenderer.color" />'
        ) +
        row(
          "Opacity",
          numInput("", spriteRenderer.opacity != null ? spriteRenderer.opacity : 1, "SpriteRenderer.opacity")
        ) +
        row(
          "Flip",
          '<div class="flip-row"><label><input type="checkbox" data-field="SpriteRenderer.flipX"' +
            (spriteRenderer.flipX ? " checked" : "") +
            "/> X</label><label><input type=\"checkbox\" data-field=\"SpriteRenderer.flipY\"" +
            (spriteRenderer.flipY ? " checked" : "") +
            "/> Y</label></div>"
        ) +
        '<button class="removecomp-btn" data-action="remove-component" data-component="SpriteRenderer" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const shapeRenderer = entity.getComponent(SHAPE_RENDERER);
  if (shapeRenderer) {
    const shapeFieldsHtml =
      shapeRenderer.shapeType === ShapeType.CIRCLE
        ? row("Radius", numInput("", shapeRenderer.radius, "ShapeRenderer.radius"))
        : shapeRenderer.shapeType === ShapeType.CAPSULE
        ? row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("Half H", shapeRenderer.capsuleHalfHeight, "ShapeRenderer.capsuleHalfHeight") +
              numInput("Radius", shapeRenderer.capsuleRadius, "ShapeRenderer.capsuleRadius") +
              "</div>"
          )
        : shapeRenderer.shapeType === ShapeType.TRIANGLE
        ? row(
            "Points",
            '<div class="static-body-note" style="color:#888;font-size:11px;line-height:1.4;">Drag the 3 yellow handles ' +
              "directly in the Scene view to reshape.</div>"
          )
        : row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("W", shapeRenderer.width, "ShapeRenderer.width") +
              numInput("H", shapeRenderer.height, "ShapeRenderer.height") +
              "</div>"
          );

    body += section(
      editorState.sectionsOpen,
      "shaperenderer",
      "Shape Renderer",
      "layers",
      row("Shape", dropdownInput(Object.values(ShapeType), shapeRenderer.shapeType, "ShapeRenderer.shapeType")) +
        shapeFieldsHtml +
        row(
          "Fill Color",
          '<input type="color" class="color-swatch-input" value="' +
            shapeRenderer.fillColor +
            '" data-field="ShapeRenderer.fillColor" />'
        ) +
        row(
          "Opacity",
          numInput("", shapeRenderer.opacity != null ? shapeRenderer.opacity : 1, "ShapeRenderer.opacity")
        ) +
        row(
          "Outline",
          '<input type="checkbox" data-field="ShapeRenderer.outlineEnabled" style="accent-color:#2C5D87;margin:0;"' +
            (shapeRenderer.outlineEnabled ? " checked" : "") +
            "/>"
        ) +
        (shapeRenderer.outlineEnabled
          ? row(
              "Outline Color",
              '<input type="color" class="color-swatch-input" value="' +
                shapeRenderer.outlineColor +
                '" data-field="ShapeRenderer.outlineColor" />'
            ) +
            row("Outline Width", numInput("", shapeRenderer.outlineWidth, "ShapeRenderer.outlineWidth"))
          : "") +
        '<button class="removecomp-btn" data-action="remove-component" data-component="ShapeRenderer" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const strokePath = entity.getComponent(STROKE_PATH);
  if (strokePath) {
    const textureAsset = strokePath.textureKey ? getSpriteAsset(strokePath.textureKey) : null;
    const textureDisplayName = textureAsset ? textureAsset.name : strokePath.textureKey || "None";

    body += section(
      editorState.sectionsOpen,
      "strokepath",
      "Stroke Path",
      "waypoints",
      '<div class="static-body-note" style="color:#888;font-size:11px;line-height:1.4;margin-bottom:6px;">Use the Path tool (P) in the toolbar to click and add points, drag any point to adjust it, or click a segment to insert one. Alt+click a point to remove it.</div>' +
        row("Thickness", numInput("", strokePath.thickness, "StrokePath.thickness")) +
        row(
          "Opacity",
          numInput("", strokePath.opacity != null ? strokePath.opacity : 1, "StrokePath.opacity")
        ) +
        row(
          "Joints",
          dropdownInput(
            [
              { value: StrokePathJointMode.SHARP, label: "Sharp" },
              { value: StrokePathJointMode.BEVEL, label: "Bevel" },
              { value: StrokePathJointMode.ROUND, label: "Round" },
            ],
            strokePath.jointMode,
            "StrokePath.jointMode"
          )
        ) +
        row(
          "End Caps",
          dropdownInput(
            [
              { value: StrokePathCapMode.NONE, label: "None" },
              { value: StrokePathCapMode.BOX, label: "Box" },
              { value: StrokePathCapMode.ROUND, label: "Round" },
            ],
            strokePath.capMode,
            "StrokePath.capMode"
          )
        ) +
        row(
          "Smoothing",
          numInput("", strokePath.smoothing != null ? strokePath.smoothing : 0, "StrokePath.smoothing")
        ) +
        '<div class="static-body-note" style="color:#888;font-size:10px;margin:-4px 0 6px;">0 = straight segments between points (as drawn). Raise toward 1 to turn the path into a smooth spline curve through the same points — fixes pinched/warped texture on sharp turns. Try 0.4-0.7 for a road/river; 1 for a fully rounded curve.</div>' +
        row(
          "Use Texture",
          '<input type="checkbox" data-field="StrokePath.useTexture" style="accent-color:#2C5D87;margin:0;"' +
            (strokePath.useTexture ? " checked" : "") +
            "/>"
        ) +
        (strokePath.useTexture
          ? row(
              "Texture",
              '<div class="sprite-row"><div class="sprite-box">' +
                textureDisplayName +
                '</div><button class="sprite-pick" data-action="open-sprite-picker" data-target="StrokePath" title="Choose a texture"><span></span></button></div>'
            ) +
              row(
                "Texture Mode",
                dropdownInput(
                  [
                    { value: StrokePathTextureMode.STRETCH, label: "Stretch" },
                    { value: StrokePathTextureMode.TILE, label: "Tile (no stretch)" },
                  ],
                  strokePath.textureMode,
                  "StrokePath.textureMode"
                ) +
                  (strokePath.textureMode === StrokePathTextureMode.STRETCH
                  ? '<div class="static-body-note" style="color:#888;font-size:10px;margin-top:3px;">Fits the whole image to the path — image warps if the path\'s length changes.</div>'
                  : '<div class="static-body-note" style="color:#888;font-size:10px;margin-top:3px;">Repeats the image at its own size — never stretches, however long the path is.</div>')
              ) +
              (strokePath.textureMode === StrokePathTextureMode.TILE
                ? row(
                    "Tile Length",
                    numInput("", strokePath.textureTiling, "StrokePath.textureTiling")
                  )
                : "") +
              row(
                "Tile Across",
                numInput("", strokePath.textureScale, "StrokePath.textureScale")
              ) +
              row(
                "Texture Offset",
                numInput("", strokePath.textureOffset, "StrokePath.textureOffset")
              ) +
              row(
                "Flip Texture",
                '<input type="checkbox" data-field="StrokePath.textureFlip" style="accent-color:#2C5D87;margin:0;"' +
                  (strokePath.textureFlip ? " checked" : "") +
                  "/>"
              ) +
              row(
                "Texture Rotation",
                numInput("", strokePath.textureRotation, "StrokePath.textureRotation")
              )
          : row(
              "Color",
              '<input type="color" class="color-swatch-input" value="' +
                strokePath.color +
                '" data-field="StrokePath.color" />'
            )) +
        '<button class="removecomp-btn" data-action="remove-component" data-component="StrokePath" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const textRenderer = entity.getComponent(TEXT_RENDERER);
  if (textRenderer) {
    body += section(
      editorState.sectionsOpen,
      "textrenderer",
      "Text",
      "layers",
      row(
        "Text",
        '<input type="text" data-field="TextRenderer.value" value="' + textRenderer.value +
          '" style="width:100%;box-sizing:border-box;background:#2a2a2a;border:1px solid #3a3a3a;color:#dcdcdc;padding:3px 6px;border-radius:3px;font-size:11px;"/>'
      ) +
        row(
          "Color",
          '<input type="color" class="color-swatch-input" value="' + textRenderer.color +
            '" data-field="TextRenderer.color" />'
        ) +
        row("Font Size", numInput("", textRenderer.fontSize, "TextRenderer.fontSize")) +
        row(
          "Font",
          dropdownInput(
            ["Arial", "Verdana", "Georgia", "Courier New", "Comic Sans MS", "Impact"],
            textRenderer.fontFamily,
            "TextRenderer.fontFamily"
          )
        ) +
        row(
          "Style",
          '<div class="flip-row"><label><input type="checkbox" data-field="TextRenderer.bold"' +
            (textRenderer.bold ? " checked" : "") +
            '/> Bold</label><label><input type="checkbox" data-field="TextRenderer.italic"' +
            (textRenderer.italic ? " checked" : "") +
            "/> Italic</label></div>"
        ) +
        row(
          "Align",
          dropdownInput(["left", "center", "right"], textRenderer.align, "TextRenderer.align")
        ) +
        row("Opacity", numInput("", textRenderer.opacity != null ? textRenderer.opacity : 1, "TextRenderer.opacity")) +
        row("Anchor X", numInput("", textRenderer.anchorX, "TextRenderer.anchorX")) +
        row("Anchor Y", numInput("", textRenderer.anchorY, "TextRenderer.anchorY")) +
        row(
          "Screen Space (UI)",
          '<input type="checkbox" data-field="TextRenderer.screenSpace" style="accent-color:#2C5D87;margin:0;"' +
            (textRenderer.screenSpace ? " checked" : "") +
            '/> <span class="inspector-note-inline" style="color:#8a94a6;font-size:10px;margin-left:6px;">' +
            (textRenderer.screenSpace ? "fixed to screen, ignores camera" : "moves with the world/camera") +
            "</span>"
        ) +
        row(
          "Word Wrap",
          '<input type="checkbox" data-field="TextRenderer.wordWrap" style="accent-color:#2C5D87;margin:0;"' +
            (textRenderer.wordWrap ? " checked" : "") +
            "/>"
        ) +
        row("Wrap Width", numInput("", textRenderer.wrapWidth, "TextRenderer.wrapWidth")) +
        '<button class="removecomp-btn" data-action="remove-component" data-component="TextRenderer" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const speechBubble = entity.getComponent(SPEECH_BUBBLE);
  if (speechBubble) {
    body += section(
      editorState.sectionsOpen,
      "speechbubble",
      "Speech Bubble",
      "layers",
      row(
        "Text",
        '<input type="text" data-field="SpeechBubble.text" value="' + speechBubble.text +
          '" style="width:100%;box-sizing:border-box;background:#2a2a2a;border:1px solid #3a3a3a;color:#dcdcdc;padding:3px 6px;border-radius:3px;font-size:11px;"/>'
      ) +
        row(
          "Visible",
          '<input type="checkbox" data-field="SpeechBubble.visible" style="accent-color:#2C5D87;margin:0;"' +
            (speechBubble.visible ? " checked" : "") +
            "/>"
        ) +
        row(
          "Background",
          '<input type="color" class="color-swatch-input" value="' + speechBubble.backgroundColor +
            '" data-field="SpeechBubble.backgroundColor" />'
        ) +
        row(
          "Text Color",
          '<input type="color" class="color-swatch-input" value="' + speechBubble.textColor +
            '" data-field="SpeechBubble.textColor" />'
        ) +
        row(
          "Border",
          '<input type="color" class="color-swatch-input" value="' + speechBubble.borderColor +
            '" data-field="SpeechBubble.borderColor" />'
        ) +
        row("Border Width", numInput("", speechBubble.borderWidth, "SpeechBubble.borderWidth")) +
        row("Font Size", numInput("", speechBubble.fontSize, "SpeechBubble.fontSize")) +
        row(
          "Font",
          dropdownInput(
            ["Arial", "Verdana", "Georgia", "Courier New", "Comic Sans MS", "Impact"],
            speechBubble.fontFamily,
            "SpeechBubble.fontFamily"
          )
        ) +
        row("Padding", numInput("", speechBubble.padding, "SpeechBubble.padding")) +
        row("Corner Radius", numInput("", speechBubble.cornerRadius, "SpeechBubble.cornerRadius")) +
        row("Max Width", numInput("", speechBubble.maxWidth, "SpeechBubble.maxWidth")) +
        row("Offset X", numInput("", speechBubble.offsetX, "SpeechBubble.offsetX")) +
        row("Offset Y", numInput("", speechBubble.offsetY, "SpeechBubble.offsetY")) +
        row(
          "Tail Direction",
          dropdownInput(["down", "up", "left", "right", "none"], speechBubble.tailDirection, "SpeechBubble.tailDirection")
        ) +
        row("Tail Size", numInput("", speechBubble.tailSize, "SpeechBubble.tailSize")) +
        '<button class="removecomp-btn" data-action="remove-component" data-component="SpeechBubble" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const chatLog = entity.getComponent(CHAT_LOG);
  if (chatLog) {
    body += section(
      editorState.sectionsOpen,
      "chatlog",
      "Chat Log",
      "layers",
      row(
        "Visible",
        '<input type="checkbox" data-field="ChatLog.visible" style="accent-color:#2C5D87;margin:0;"' +
          (chatLog.visible ? " checked" : "") +
          "/>"
      ) +
        row(
          "Show Sender",
          '<input type="checkbox" data-field="ChatLog.showSender" style="accent-color:#2C5D87;margin:0;"' +
            (chatLog.showSender ? " checked" : "") +
            "/>"
        ) +
        row("Visible Messages", numInput("", chatLog.visibleCount, "ChatLog.visibleCount")) +
        row("Max History", numInput("", chatLog.maxMessages, "ChatLog.maxMessages")) +
        row("Width", numInput("", chatLog.width, "ChatLog.width")) +
        row("Line Height", numInput("", chatLog.lineHeight, "ChatLog.lineHeight")) +
        row("Font Size", numInput("", chatLog.fontSize, "ChatLog.fontSize")) +
        row(
          "Font",
          dropdownInput(
            ["Arial", "Verdana", "Georgia", "Courier New", "Comic Sans MS", "Impact"],
            chatLog.fontFamily,
            "ChatLog.fontFamily"
          )
        ) +
        row(
          "Message Color",
          '<input type="color" class="color-swatch-input" value="' + chatLog.messageColor +
            '" data-field="ChatLog.messageColor" />'
        ) +
        row(
          "Sender Color",
          '<input type="color" class="color-swatch-input" value="' + chatLog.senderColor +
            '" data-field="ChatLog.senderColor" />'
        ) +
        row(
          "Background",
          '<input type="color" class="color-swatch-input" value="' + chatLog.backgroundColor +
            '" data-field="ChatLog.backgroundColor" />'
        ) +
        row("Background Opacity", numInput("", chatLog.backgroundOpacity, "ChatLog.backgroundOpacity")) +
        row("Padding", numInput("", chatLog.padding, "ChatLog.padding")) +
        row(
          "Screen Space (UI)",
          '<input type="checkbox" data-field="ChatLog.screenSpace" style="accent-color:#2C5D87;margin:0;"' +
            (chatLog.screenSpace ? " checked" : "") +
            '/> <span style="color:#8a94a6;font-size:10px;margin-left:6px;">' +
            (chatLog.screenSpace ? "fixed to screen, ignores camera" : "moves with the world/camera") +
            "</span>"
        ) +
        '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin-top:4px;">' +
          chatLog.messages.length + " message(s) in history. Use this.chat.send(sender, text) from a script to add more." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="ChatLog" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const textInput = entity.getComponent(TEXT_INPUT);
  if (textInput) {
    body += section(
      editorState.sectionsOpen,
      "textinput",
      "Text Input",
      "layers",
      row(
        "Placeholder",
        '<input type="text" data-field="TextInput.placeholder" value="' + textInput.placeholder +
          '" style="width:100%;box-sizing:border-box;background:#2a2a2a;border:1px solid #3a3a3a;color:#dcdcdc;padding:3px 6px;border-radius:3px;font-size:11px;"/>'
      ) +
        row("Max Length", numInput("", textInput.maxLength, "TextInput.maxLength")) +
        row("Width", numInput("", textInput.width, "TextInput.width")) +
        row("Height", numInput("", textInput.height, "TextInput.height")) +
        row("Font Size", numInput("", textInput.fontSize, "TextInput.fontSize")) +
        row(
          "Font",
          dropdownInput(
            ["Arial", "Verdana", "Georgia", "Courier New", "Comic Sans MS", "Impact"],
            textInput.fontFamily,
            "TextInput.fontFamily"
          )
        ) +
        row(
          "Text Color",
          '<input type="color" class="color-swatch-input" value="' + textInput.textColor +
            '" data-field="TextInput.textColor" />'
        ) +
        row(
          "Placeholder Color",
          '<input type="color" class="color-swatch-input" value="' + textInput.placeholderColor +
            '" data-field="TextInput.placeholderColor" />'
        ) +
        row(
          "Background",
          '<input type="color" class="color-swatch-input" value="' + textInput.backgroundColor +
            '" data-field="TextInput.backgroundColor" />'
        ) +
        row(
          "Border",
          '<input type="color" class="color-swatch-input" value="' + textInput.borderColor +
            '" data-field="TextInput.borderColor" />'
        ) +
        row("Border Width", numInput("", textInput.borderWidth, "TextInput.borderWidth")) +
        row("Corner Radius", numInput("", textInput.cornerRadius, "TextInput.cornerRadius")) +
        row("Padding", numInput("", textInput.padding, "TextInput.padding")) +
        row(
          "Clear On Submit",
          '<input type="checkbox" data-field="TextInput.clearOnSubmit" style="accent-color:#2C5D87;margin:0;"' +
            (textInput.clearOnSubmit ? " checked" : "") +
            "/>"
        ) +
        '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin-top:4px;">' +
          "Read what the player typed with this.textInput.justSubmitted / this.textInput.value in a script." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="TextInput" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const joystick = entity.getComponent(JOYSTICK);
  if (joystick) {
    const isDynamic = joystick.positionMode === JoystickPositionMode.DYNAMIC;
    body += section(
      editorState.sectionsOpen,
      "joystick",
      "Joystick",
      "move",
      row(
        "Position",
        dropdownInput(
          [JoystickPositionMode.FIXED, JoystickPositionMode.DYNAMIC],
          joystick.positionMode,
          "Joystick.positionMode"
        )
      ) +
        '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin:-2px 0 4px;">' +
        (isDynamic
          ? "Appears centered wherever the player first presses down inside the Touch Region below."
          : "Always drawn at this object's Transform position. Press anywhere on the base to start dragging.") +
        "</div>" +
        (isDynamic
          ? row(
              "Touch Region",
              '<div style="display:flex;flex-direction:column;gap:4px;width:100%;">' +
                '<div style="display:flex;gap:4px;">' +
                numInput("X", joystick.regionX, "Joystick.regionX") +
                numInput("Y", joystick.regionY, "Joystick.regionY") +
                "</div>" +
                '<div style="display:flex;gap:4px;">' +
                numInput("W", joystick.regionWidth, "Joystick.regionWidth") +
                numInput("H", joystick.regionHeight, "Joystick.regionHeight") +
                "</div>" +
                "</div>"
            )
          : "") +
        row("Base Radius", numInput("", joystick.baseRadius, "Joystick.baseRadius")) +
        row("Knob Radius", numInput("", joystick.knobRadius, "Joystick.knobRadius")) +
        row(
          "Base Color",
          '<input type="color" class="color-swatch-input" value="' + joystick.baseColor +
            '" data-field="Joystick.baseColor" />'
        ) +
        row("Base Opacity", numInput("", joystick.baseOpacity, "Joystick.baseOpacity")) +
        row(
          "Knob Color",
          '<input type="color" class="color-swatch-input" value="' + joystick.knobColor +
            '" data-field="Joystick.knobColor" />'
        ) +
        row("Knob Opacity", numInput("", joystick.knobOpacity, "Joystick.knobOpacity")) +
        row(
          "Outline Color",
          '<input type="color" class="color-swatch-input" value="' + joystick.outlineColor +
            '" data-field="Joystick.outlineColor" />'
        ) +
        row("Outline Width", numInput("", joystick.outlineWidth, "Joystick.outlineWidth")) +
        row("Dead Zone", numInput("", joystick.deadZone, "Joystick.deadZone")) +
        row(
          "Return To Center",
          '<input type="checkbox" data-field="Joystick.returnToCenter" style="accent-color:#2C5D87;margin:0;"' +
            (joystick.returnToCenter ? " checked" : "") +
            "/>"
        ) +
        row(
          "Hide When Idle",
          '<input type="checkbox" data-field="Joystick.hideWhenIdle" style="accent-color:#2C5D87;margin:0;"' +
            (joystick.hideWhenIdle ? " checked" : "") +
            '/> <span class="inspector-note-inline" style="color:#8a94a6;font-size:10px;margin-left:6px;">' +
            (joystick.hideWhenIdle ? "invisible until pressed" : "always visible") +
            "</span>"
        ) +
        (!joystick.hideWhenIdle
          ? row("Idle Opacity ×", numInput("", joystick.idleOpacityMultiplier, "Joystick.idleOpacityMultiplier"))
          : "") +
        '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin-top:4px;">' +
          "Read this.joystick.x / .y (-1..1) and .magnitude / .angle / .active in a script. " +
          "Drive movement with this.controller.simulateMove(this.joystick.x, this.joystick.y). " +
          (joystick.active ? "Currently active." : "Not currently pressed.") +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Joystick" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const light = entity.getComponent(LIGHT);
  if (light) {
    let typeSpecificHtml = "";
    if (light.type === LightType.POINT) {
      typeSpecificHtml = row("Radius", numInput("", light.radius, "Light.radius"));
    } else if (light.type === LightType.SPOT) {
      typeSpecificHtml =
        row("Radius", numInput("", light.radius, "Light.radius")) +
        row("Spot Angle", numInput("", light.angle, "Light.angle")) +
        row(
          "Direction",
          '<div class="static-body-note" style="padding:2px 0;color:#8a93a0;font-size:10px;">Aimed using this object\'s Transform &gt; Rotation.</div>'
        );
    } else if (light.type === LightType.AREA) {
      typeSpecificHtml =
        row(
          "Size",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("W", light.width, "Light.width") +
            numInput("H", light.height, "Light.height") +
            "</div>"
        ) + row("Falloff Radius", numInput("", light.radius, "Light.radius"));
    } else if (light.type === LightType.GOD_RAYS) {
      typeSpecificHtml =
        row("Radius", numInput("", light.radius, "Light.radius")) +
        row("Beam Angle", numInput("", light.angle, "Light.angle")) +
        row(
          "Direction",
          '<div class="static-body-note" style="padding:2px 0;color:#8a93a0;font-size:10px;">Aimed using this object\'s Transform &gt; Rotation.</div>'
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "God Rays cast bright, streaked shafts of light through the beam — like sunlight breaking through clouds or a window — instead of a flat cone." +
        "</div>";
    } else if (light.type === LightType.FREEFORM) {
      const pointCount = light.points ? light.points.length : 0;
      typeSpecificHtml =
        row("Edge Feather", numInput("", light.radius, "Light.radius")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Shape drawn by dragging points directly in the Scene view (" + pointCount + " points). " +
        "Click a line between two points to add a point; right-click (or Alt-click) a point to remove it." +
        "</div>";
    } else {
      // Directional: no position/radius dependency for its GLOW — it
      // uniformly lights the whole scene — but its rotation still
      // matters for shadow direction when Cast Shadows is on below (see
      // "just like the sun" note there), so this stays informational
      // rather than implying rotation is irrelevant.
      typeSpecificHtml =
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Directional lights ignore position and reach for lighting — they light the entire scene evenly, like sunlight. Rotation still controls shadow direction if Cast Shadows is on." +
        "</div>";
    }

    const shadowFields = light.castShadows
      ? row(
          "Shadow Color",
          '<input type="color" class="color-swatch-input" value="' +
            light.shadowColor +
            '" data-field="Light.shadowColor" />'
        ) +
        row("Shadow Strength", numInput("", light.shadowStrength, "Light.shadowStrength")) +
        (light.type === LightType.DIRECTIONAL
          ? '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
            "Parallel shadows, like the sun: every Shadow Caster's shadow points the same way, set ONLY by this light's rotation — moving this light does nothing to its shadows." +
            "</div>"
          : '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
            "Casts real-time shadows from every object with a Shadow Caster component (see below)." +
            "</div>")
      : "";

    body += section(
      editorState.sectionsOpen,
      "light",
      "Light",
      "lightbulb",
      row("Type", dropdownInput(Object.values(LightType), light.type, "Light.type")) +
        row(
          "Color",
          '<input type="color" class="color-swatch-input" value="' +
            light.color +
            '" data-field="Light.color" />'
        ) +
        row("Intensity", numInput("", light.intensity, "Light.intensity")) +
        row("Core Size", numInput("", light.coreSize, "Light.coreSize")) +
        row(
          "Core Visible",
          '<input type="checkbox" data-field="Light.coreVisible" style="accent-color:#2C5D87;margin:0;"' +
            (light.coreVisible !== false ? " checked" : "") +
            '/>'
        ) +
        row(
          "Flicker",
          '<input type="checkbox" data-field="Light.flicker" style="accent-color:#2C5D87;margin:0;"' +
            (light.flicker ? " checked" : "") +
            "/>"
        ) +
        (light.flicker
          ? row("Flicker Speed", numInput("", light.flickerSpeed, "Light.flickerSpeed")) +
            row("Flicker Duration", numInput("", light.flickerDuration, "Light.flickerDuration")) +
            '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
              "Speed is cycles per second. Duration is seconds; 0 means forever." +
            "</div>"
          : "") +
        typeSpecificHtml +
        row(
          "Affects World",
          '<input type="checkbox" data-field="Light.castsOnWorld" style="accent-color:#2C5D87;margin:0;"' +
            (light.castsOnWorld ? " checked" : "") +
            "/>"
        ) +
        row(
          "Cast Shadows",
          '<input type="checkbox" data-field="Light.castShadows" style="accent-color:#2C5D87;margin:0;"' +
            (light.castShadows ? " checked" : "") +
            "/>"
        ) +
        shadowFields +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Light" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const audioSource = entity.getComponent(AUDIO_SOURCE);
  if (audioSource) {
    const audioAsset = audioSource.audioKey ? getAudioAsset(audioSource.audioKey) : null;
    const allAudioAssets = getAllAudioAssets();
    // Every imported Audio asset becomes a selectable option here, keyed
    // by its stable asset key (option value) but labeled with its
    // friendly name (option text) — a plain dropdownInput() can't do
    // that split (it renders the same string as both value and label),
    // so this builds the <select> markup directly. Falls back to a
    // disabled placeholder option when the current audioKey doesn't
    // match any imported asset (e.g. it was deleted from the project),
    // so the picker still shows something meaningful instead of quietly
    // snapping to the first asset in the list.
    const audioOptionsHtml =
      (audioSource.audioKey && !audioAsset
        ? '<option value="' + esc(audioSource.audioKey) + '" selected disabled>' +
          "Missing: " + esc(audioSource.audioKey) +
          "</option>"
        : !audioSource.audioKey
          ? '<option value="" selected disabled>None</option>'
          : "") +
      allAudioAssets
        .map(
          (a) =>
            '<option value="' + esc(a.key) + '"' + (a.key === audioSource.audioKey ? " selected" : "") + ">" +
            esc(a.name) +
            "</option>"
        )
        .join("");
    const audioClipPickerHtml = allAudioAssets.length
      ? '<div class="dropdown-input"><select data-field="AudioSource.audioKey">' +
        audioOptionsHtml +
        "</select>" +
        icon("chevrondown", 10, "chev") +
        "</div>"
      : '<div class="sprite-row"><div class="sprite-box">No audio imported</div></div>';

    const distanceFieldsHtml = audioSource.is3D
      ? row("Min Distance", numInput("", audioSource.minDistance, "AudioSource.minDistance")) +
        row("Max Distance", numInput("", audioSource.maxDistance, "AudioSource.maxDistance")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Full volume within Min Distance of the camera, fading out linearly to silent by Max Distance — shown as the two circles around this object in the Scene view." +
        "</div>"
      : '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "2D audio plays at a constant volume everywhere in the scene, regardless of this object's position — use it for background music or UI sounds." +
        "</div>";

    body += section(
      editorState.sectionsOpen,
      "audiosource",
      "Audio Source",
      "music",
      row("Clip", audioClipPickerHtml) +
        row("Mode", dropdownInput(["2D", "3D"], audioSource.is3D ? "3D" : "2D", "AudioSource.is3DLabel")) +
        row("Volume", numInput("", audioSource.volume, "AudioSource.volume")) +
        row("Pitch", numInput("", audioSource.pitch != null ? audioSource.pitch : 1, "AudioSource.pitch")) +
        row(
          "Loop",
          '<input type="checkbox" data-field="AudioSource.loop" style="accent-color:#2C5D87;margin:0;"' +
            (audioSource.loop ? " checked" : "") +
            "/>"
        ) +
        row(
          "Play On Awake",
          '<input type="checkbox" data-field="AudioSource.autoplay" style="accent-color:#2C5D87;margin:0;"' +
            (audioSource.autoplay ? " checked" : "") +
            "/>"
        ) +
        distanceFieldsHtml +
        '<button class="removecomp-btn" data-action="remove-component" data-component="AudioSource" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const audioListener = entity.getComponent(AUDIO_LISTENER);
  if (audioListener) {
    body += section(
      editorState.sectionsOpen,
      "audiolistener",
      "Audio Listener",
      "music",
      row("Radius", numInput("", audioListener.radius, "AudioListener.radius")) +
        row(
          "Enabled",
          '<input type="checkbox" data-field="AudioListener.enabled" style="accent-color:#2C5D87;margin:0;"' +
            (audioListener.enabled ? " checked" : "") +
            "/>"
        ) +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Detects 3D Audio Sources within this radius, shown as a circle around this object in the Scene view. In scripts, use this.ear.sourcesInRange, this.ear.canHear(name), or the onHearSound(source)/onLoseSound(source) lifecycle functions. 2D audio is never detected." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="AudioListener" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const tileset = entity.getComponent(TILESET);
  if (tileset) {
    const filledCount = Object.values(tileset.slots).filter(Boolean).length;
    body += section(
      editorState.sectionsOpen,
      "tileset",
      "Tileset",
      "grid",
      row("Name", '<input type="text" data-field="Tileset.name" value="' + esc(tileset.name) + '" style="width:100%;background:#2a2a2a;border:1px solid #3a3a3a;color:#dcdcdc;padding:3px 6px;border-radius:3px;font-size:11px;"/>') +
        row("Tile Size", numInput("W", tileset.tileWidth, "Tileset.tileWidth") + numInput("H", tileset.tileHeight, "Tileset.tileHeight")) +
        row("Slots Filled", '<span style="color:#8a93a0;font-size:11px;">' + filledCount + " / 16</span>") +
        '<button class="animwin-btn" data-action="open-tileset-editor" data-entity="' + entity.id + '" style="width:100%;margin-top:4px;">' +
        icon("grid", 12) +
        " Open Tileset Editor</button>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Tileset" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const tilemap = entity.getComponent(TILEMAP);
  if (tilemap) {
    // Every OTHER entity in the scene that carries a Tileset is a valid
    // assignment target — Tilemap references a Tileset by entity id
    // (not by copying its data), matching Light/ShadowCaster's existing
    // reference-by-id convention elsewhere in this codebase (see
    // Tilemap.js's file header for why).
    const tilesetEntities = world ? world.getAllEntities().filter((e) => e.hasComponent(TILESET)) : [];
    const cellCount = Object.keys(tilemap.cells).length;
    const tilesetOptionsHtml =
      (!tilemap.tilesetEntityId ? '<option value="" selected disabled>None</option>' : "") +
      tilesetEntities
        .map(
          (e) =>
            '<option value="' + esc(e.id) + '"' + (e.id === tilemap.tilesetEntityId ? " selected" : "") + ">" +
            esc(e.name) +
            "</option>"
        )
        .join("");
    const tilesetPickerHtml = tilesetEntities.length
      ? '<div class="dropdown-input"><select data-field="Tilemap.tilesetEntityId">' +
        tilesetOptionsHtml +
        "</select>" +
        icon("chevrondown", 10, "chev") +
        "</div>"
      : '<div class="sprite-row"><div class="sprite-box">No Tileset in scene — add one to an object first</div></div>';

    body += section(
      editorState.sectionsOpen,
      "tilemap",
      "Tilemap",
      "grid",
      row("Tileset", tilesetPickerHtml) +
        row("Painted Cells", '<span style="color:#8a93a0;font-size:11px;">' + cellCount + "</span>") +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        'Select the Tile tool (T) in the toolbar, then click or drag in the Scene view to paint. The tile shown at each cell auto-updates from its neighbors, like Unity\'s Rule Tile.' +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Tilemap" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const navWorld = entity.getComponent(NAV_WORLD_2D);
  if (navWorld) {
    const navCellCount = Object.keys(navWorld.cells).length;
    const navWalkableCount = Object.values(navWorld.cells).filter((v) => v === true).length;
    const navBlockedCount = navCellCount - navWalkableCount;
    const navPaintCount = Object.keys(navWorld.paintOverrides || {}).length;
    const namedNavAreasForCosts = getNamedNavAreas();

    body += section(
      editorState.sectionsOpen,
      "navworld2d",
      "Nav World 2D",
      "route",
      row(
        "Bounds",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("X", navWorld.boundsX, "NavWorld2D.boundsX") +
          numInput("Y", navWorld.boundsY, "NavWorld2D.boundsY") +
          "</div>"
      ) +
        row(
          "Size",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("W", navWorld.boundsWidth, "NavWorld2D.boundsWidth") +
            numInput("H", navWorld.boundsHeight, "NavWorld2D.boundsHeight") +
            "</div>"
        ) +
        row("Cell Size", numInput("", navWorld.cellSize, "NavWorld2D.cellSize")) +
        row("Manual Paint", '<span style="color:#8a93a0;font-size:11px;">' + navPaintCount + ' overridden cells</span>') +
        row(
          "Area Costs",
          '<div style="display:flex;flex-direction:column;gap:3px;width:100%;">' +
            (namedNavAreasForCosts.length
              ? namedNavAreasForCosts
                  .map(
                    ({ index, name }) =>
                      '<div style="display:flex;align-items:center;gap:6px;">' +
                      '<span style="flex:1;font-size:11px;color:#c8d0de;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</span>' +
                      '<input type="number" step="0.1" min="0.01" value="' + navWorld.areaCosts[index] +
                      '" data-field="NavWorld2D.areaCost" data-area-index="' + index +
                      '" style="width:56px;background:#1a2030;color:#c8d0de;border:1px solid #2e3a50;border-radius:4px;padding:2px 4px;font-size:11px;"/>' +
                      "</div>"
                  )
                  .join("")
              : '<span style="color:#8a93a0;font-size:11px;">No named areas — name slots via Edit \u2192 Nav Areas\u2026</span>') +
            "</div>"
        ) +
        '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
        "1.0 = no preference. Higher costs make an agent detour around that area when a similarly-short alternative exists, without making it impassable — for a hard block, use a Nav Agent 2D's Area Mask instead." +
        "</div>" +
        row(
          "Allow Diagonal",
          '<input type="checkbox" data-field="NavWorld2D.allowDiagonal" style="accent-color:#2C5D87;margin:0;"' +
            (navWorld.allowDiagonal ? " checked" : "") +
            "/>"
        ) +
        row(
          "Dynamic",
          '<input type="checkbox" data-field="NavWorld2D.dynamic" style="accent-color:#2C5D87;margin:0;"' +
            (navWorld.dynamic ? " checked" : "") +
            "/>"
        ) +
        (navWorld.dynamic
          ? '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
            "Auto re-bakes at runtime whenever a Collider2D is added, removed, or moved. " +
            "Checks every frame for changes (cheap) but only re-bakes when something actually changed (same cost as a manual bake). " +
            "Leave off for static levels — a one-time bake is free after that." +
            "</div>"
          : "") +
        row("Min Obstacle Footprint", numInput("", navWorld.minObstacleFootprint, "NavWorld2D.minObstacleFootprint")) +
        '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
        'Colliders narrower than this on both axes never block a cell during Bake — use it to stop small decorative props (grass, pebbles) from making walkable ground register as blocked. 0 = every collider blocks, no matter how small. Re-bake after changing.' +
        '</div>' +
        row(
          "Baked Cells",
          '<span style="color:#8a93a0;font-size:11px;">' +
            navCellCount +
            ' total <span style="color:#4ade80;">(' + navWalkableCount + ' walkable)</span> ' +
            '<span style="color:#ff3b30;">(' + navBlockedCount + ' blocked)</span></span>'
        ) +
        '<button class="animwin-btn" data-action="bake-navworld" data-entity="' + entity.id + '" style="width:100%;margin-top:4px;">' +
        icon("route", 12) +
        " Bake Nav World</button>" +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        'Bake fills the bounds above from every Collider2D in the scene — raw geometry only, NOT padded by any agent radius. ' +
        'Each Nav Agent 2D applies its own Radius on top of this shared bake (see that component), so the same Nav World 2D supports agents of different sizes. ' +
        'Use the Nav tool (U) in the toolbar to hand-paint individual cells afterward — click to force walkable, Alt+click (or the Erase tool) to force blocked. ' +
        'Toggle cell visibility with the "Show Nav World Cells" button in the toolbar.' +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="NavWorld2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const navAgent = entity.getComponent(NAV_AGENT_2D);
  if (navAgent) {
    const namedNavAreas = getNamedNavAreas();
    const isPreviewing = editorState.navAgentPreviewEntityId === entity.id;
    // Cross-entity lookup: NavAgent2D and NavWorld2D live on different
    // entities (one shared NavWorld2D, many NavAgent2D — see that
    // component's header), so unlike navWorld above (this entity's OWN
    // component), the world whose default costs we show placeholders
    // for has to be found by scanning the scene, same pattern
    // tilesetEntities above uses for Tilemap's cross-entity picker.
    const sceneNavWorldEntity = world ? world.getAllEntities().find((e) => e.hasComponent(NAV_WORLD_2D)) : null;
    const sceneNavWorld = sceneNavWorldEntity ? sceneNavWorldEntity.getComponent(NAV_WORLD_2D) : null;
    const agentCosts = navAgent.areaCosts; // null, or a 16-length array with per-slot overrides/nulls

    body += section(
      editorState.sectionsOpen,
      "navagent2d",
      "Nav Agent 2D",
      "route",
      // Agent
      '<div class="inspector-subhead" style="padding:2px 4px;color:#7f8a99;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">Agent</div>' +
        row("Radius", numInput("", navAgent.radius, "NavAgent2D.radius")) +
        (entity.hasComponent(COLLIDER_2D)
          ? '<button class="animwin-btn" data-action="match-navagent-radius" data-entity="' + entity.id + '" style="width:100%;margin:2px 0 6px;">' +
            icon("route", 12) + " Match Collider</button>" +
            '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
            "Sets Radius from this entity's own Collider2D size (world units, after Scale) instead of a guess — e.g. a 100\u00d7100 box collider needs roughly 60-80 to keep this agent clear of a same-sized obstacle standing next to it." +
            "</div>"
          : '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
            "Add a Collider2D to this entity to auto-fill Radius from its actual size via \u201cMatch Collider.\u201d" +
            "</div>") +
        // Movement
        '<div class="inspector-subhead" style="padding:6px 4px 2px;color:#7f8a99;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">Movement</div>' +
        row("Speed", numInput("", navAgent.speed, "NavAgent2D.speed")) +
        row("Acceleration", numInput("", navAgent.acceleration, "NavAgent2D.acceleration")) +
        row("Deceleration", numInput("", navAgent.deceleration, "NavAgent2D.deceleration")) +
        row("Stopping Distance", numInput("", navAgent.stoppingDistance, "NavAgent2D.stoppingDistance")) +
        // Pathfinding
        '<div class="inspector-subhead" style="padding:6px 4px 2px;color:#7f8a99;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">Pathfinding</div>' +
        row(
          "Auto Repath",
          '<input type="checkbox" data-field="NavAgent2D.autoRepath" style="accent-color:#2C5D87;margin:0;"' +
            (navAgent.autoRepath ? " checked" : "") +
            "/>"
        ) +
        row("Repath Interval", numInput("", navAgent.repathInterval, "NavAgent2D.repathInterval")) +
        row("Repath Distance", numInput("", navAgent.repathDistance, "NavAgent2D.repathDistance")) +
        // Avoidance
        '<div class="inspector-subhead" style="padding:6px 4px 2px;color:#7f8a99;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">Avoidance</div>' +
        row(
          "Enabled",
          '<input type="checkbox" data-field="NavAgent2D.avoidanceEnabled" style="accent-color:#2C5D87;margin:0;"' +
            (navAgent.avoidanceEnabled ? " checked" : "") +
            "/>"
        ) +
        row("Priority", numInput("", navAgent.avoidancePriority, "NavAgent2D.avoidancePriority")) +
        // Collaboration
        '<div class="inspector-subhead" style="padding:6px 4px 2px;color:#7f8a99;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">Collaboration</div>' +
        row(
          "Enabled",
          '<input type="checkbox" data-field="NavAgent2D.collabEnabled" style="accent-color:#2C5D87;margin:0;"' +
            (navAgent.collabEnabled ? " checked" : "") +
            "/>"
        ) +
        row("Group Radius", numInput("", navAgent.collabGroupRadius, "NavAgent2D.collabGroupRadius")) +
        '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
        "When Enabled, this agent joins \u201csmart NPC\u201d group-surround behavior: if another Collaboration-enabled agent's this.navMoveToward() target is within Group Radius of this one's, both are redirected to their own slot on a ring around the shared target instead of pathing to the identical point and jamming into each other. Useful for guards converging on an intruder or a pack surrounding prey. Off by default \u2014 existing scenes and scripts are unaffected until you turn it on." +
        "</div>" +
        // Navigation
        '<div class="inspector-subhead" style="padding:6px 4px 2px;color:#7f8a99;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">Navigation</div>' +
        row(
          "Area Mask",
          '<div style="display:flex;flex-direction:column;gap:2px;width:100%;">' +
            (namedNavAreas.length
              ? namedNavAreas
                  .map(
                    ({ index, name }) =>
                      '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#c8d0de;">' +
                      '<input type="checkbox" data-field="NavAgent2D.area" data-bit="' + index + '"' +
                      ((navAgent.area & (1 << index)) !== 0 ? " checked" : "") +
                      ' style="accent-color:#2C5D87;margin:0;"/>' +
                      name +
                      "</label>"
                  )
                  .join("")
              : '<span style="color:#8a93a0;font-size:11px;">No named areas — name slots via Edit \u2192 Nav Areas\u2026</span>') +
            "</div>"
        ) +
        '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
        "Which areas this agent may path through at all — unchecking an area makes it impassable for this agent, same as Unity's NavMeshAgent.areaMask. To make an area merely SLOWER to cross instead of forbidden (e.g. mud), use this agent's own Area Costs below, or the Nav World 2D's Area Costs to affect every agent — see Edit \u2192 Nav Areas\u2026 for naming." +
        "</div>" +
        row(
          "Area Costs",
          '<div style="display:flex;flex-direction:column;gap:3px;width:100%;">' +
            (namedNavAreas.length
              ? namedNavAreas
                  .map(({ index, name }) => {
                    const overrideValue = Array.isArray(agentCosts) ? agentCosts[index] : null;
                    const hasOverride = typeof overrideValue === "number" && overrideValue > 0;
                    const worldDefault = sceneNavWorld ? sceneNavWorld.areaCosts[index] : 1;
                    return (
                      '<div style="display:flex;align-items:center;gap:6px;">' +
                      '<input type="checkbox" data-field="NavAgent2D.areaCostOverrideEnabled" data-area-index="' + index + '"' +
                      (hasOverride ? " checked" : "") +
                      ' style="accent-color:#2C5D87;margin:0;" title="Override this area\u2019s cost for this agent only"/>' +
                      '<span style="flex:1;font-size:11px;color:#c8d0de;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</span>' +
                      '<input type="number" step="0.1" min="0.01" value="' + (hasOverride ? overrideValue : worldDefault) +
                      '" data-field="NavAgent2D.areaCost" data-area-index="' + index +
                      '"' + (hasOverride ? "" : " disabled") +
                      ' style="width:56px;background:#1a2030;color:#c8d0de;border:1px solid #2e3a50;border-radius:4px;padding:2px 4px;font-size:11px;' +
                      (hasOverride ? "" : "opacity:0.5;") + '"/>' +
                      "</div>"
                    );
                  })
                  .join("")
              : '<span style="color:#8a93a0;font-size:11px;">No named areas — name slots via Edit \u2192 Nav Areas\u2026</span>') +
            "</div>"
        ) +
        '<div class="static-body-note" style="padding:0 4px 6px;color:#8a93a0;font-size:11px;">' +
        "Check a box to give THIS agent its own cost for that area instead of the Nav World 2D's shared default (shown grayed out when unchecked). Useful when different agents should treat the same area differently — e.g. a heavy truck avoids Mud while a light scout ignores it." +
        "</div>" +
        '<button class="animwin-btn' + (isPreviewing ? " active" : "") + '" data-action="toggle-nav-agent-preview" data-entity="' + entity.id + '" style="width:100%;margin-top:6px;">' +
        icon("route", 12) +
        (isPreviewing ? " Hide Agent Navigation" : " Show Agent Navigation") + "</button>" +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Shows which cells of the scene's Nav World 2D this agent can actually use at its current Radius and Area Mask — cells blocked only because of this agent's size or area restrictions (not by a real obstacle) are highlighted separately in the Scene view." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="NavAgent2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const shadowCaster = entity.getComponent(SHADOW_CASTER);
  if (shadowCaster) {
    body += section(
      editorState.sectionsOpen,
      "shadowcaster",
      "Shadow Caster",
      "box",
      row(
        "Cast Shadow",
        '<input type="checkbox" data-field="ShadowCaster.enabled" style="accent-color:#2C5D87;margin:0;"' +
          (shadowCaster.enabled ? " checked" : "") +
          "/>"
      ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "When enabled, this object blocks light and casts a dynamic shadow for every nearby light that has Cast Shadows on. By default the shadow's shape matches this object's own sprite." +
        "</div>" +
        row(
          "Size Override",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("W", shadowCaster.width == null ? "" : shadowCaster.width, "ShadowCaster.width") +
            numInput("H", shadowCaster.height == null ? "" : shadowCaster.height, "ShadowCaster.height") +
            "</div>"
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Leave blank to use this object's real sprite size." +
        "</div>" +
        row(
          "Offset",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("X", shadowCaster.offsetX, "ShadowCaster.offsetX") +
            numInput("Y", shadowCaster.offsetY, "ShadowCaster.offsetY") +
            "</div>"
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Shifts where the shadow shape is centered relative to this object (rotates together with it) — e.g. anchor a shadow to a character's feet instead of its middle." +
        "</div>" +
        row("Opacity", numInput("", shadowCaster.opacity, "ShadowCaster.opacity")) +
        row("Length", numInput("", shadowCaster.length, "ShadowCaster.length")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Length is a multiplier on how far this object's shadow reaches: 1 = matches the light's own reach, 0.5 = a short shadow, 2+ = a long, late-day-sun-style shadow." +
        "</div>" +
        row("Softness", numInput("", shadowCaster.softness, "ShadowCaster.softness")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "0 = crisp hard-edged shadow. Higher values add a soft, blurred edge (penumbra) for a more realistic look." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="ShadowCaster" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const lightingSettings = entity.getComponent(LIGHTING_SETTINGS);
  if (lightingSettings) {
    body += section(
      editorState.sectionsOpen,
      "lightingsettings",
      "Lighting Settings",
      "settings",
      '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Scene-wide realism settings for every light and shadow in this scene — not tied to any one Light." +
        "</div>" +
        row("Shadow Mode", dropdownInput(Object.values(ShadowMode), lightingSettings.shadowMode, "LightingSettings.shadowMode")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Quad: cheap analytic shadows, best for lower-end machines. Raymarch: true per-pixel shadows with realistic soft edges, costs more GPU time." +
        "</div>" +
        (lightingSettings.shadowMode === ShadowMode.RAYMARCH
          ? row("Raymarch Steps", '<input type="number" min="1" max="200" step="1" value="' + Math.max(1, Math.min(200, Number(lightingSettings.raymarchSteps) || 24)) + '" data-field="LightingSettings.raymarchSteps" />') +
            '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
            "Higher = smoother, more accurate shadow edges (fewer thin shadows 'leaking' light through), at a higher GPU cost. 24 is a good starting point; up to 200 is available for very high-quality shadows, but higher values cost significantly more GPU time." +
            "</div>"
          : "") +
        row("Ambient Darkness", numInput("", lightingSettings.ambientDarkness, "LightingSettings.ambientDarkness")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "How dark areas with no light get, from 0 (no darkening, full brightness everywhere) to 1 (pitch black outside any light's reach). This is the biggest single dial for how moody/realistic the scene's lighting feels." +
        "</div>" +
        row("Glow Strength", numInput("", lightingSettings.glowStrength, "LightingSettings.glowStrength")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "How visibly lights glow in open air — over empty background, not just where they land on a sprite. 0 = lights are only visible through what they light up; 1 = a normal visible glow; higher = a brighter, hotter-looking light source." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="LightingSettings" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const spriteAnimation = entity.getComponent(SPRITE_ANIMATION);
  if (spriteAnimation) {
    const currentClip = spriteAnimation.clips.find((c) => c.id === spriteAnimation.currentClipId) || null;
    const clipOptions = spriteAnimation.clips.map((c) => c.name);

    let overrideHtml = "";
    if (currentClip) {
      const ov = currentClip.colliderOverride;
      overrideHtml =
        row(
          "Collider Override",
          '<input type="checkbox" data-action="toggle-clip-collider-override" data-clip-id="' +
            currentClip.id +
            '" style="accent-color:#2C5D87;margin:0;"' +
            (ov ? " checked" : "") +
            "/>"
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "When on, THIS clip uses its own collision shape while playing — other clips (or turning this off) leave the entity's main Collider2D shape above untouched." +
        "</div>";

      if (ov) {
        overrideHtml +=
          row(
            "Shape",
            dropdownInput(Object.values(ColliderShape), ov.shape, "SpriteAnimation.clipOverride." + currentClip.id + ".shape")
          ) +
          (ov.shape === ColliderShape.CIRCLE
            ? row("Radius", numInput("", ov.radius, "SpriteAnimation.clipOverride." + currentClip.id + ".radius"))
            : ov.shape === ColliderShape.CAPSULE
            ? row(
                "Size",
                '<div style="display:flex;gap:4px;width:100%;">' +
                  numInput("Half H", ov.capsuleHalfHeight, "SpriteAnimation.clipOverride." + currentClip.id + ".capsuleHalfHeight") +
                  numInput("Radius", ov.capsuleRadius, "SpriteAnimation.clipOverride." + currentClip.id + ".capsuleRadius") +
                  "</div>"
              )
            : ov.shape === ColliderShape.TRIANGLE
            ? '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
              "Open this clip in the Animation panel to edit its triangle points."
              + "</div>"
            : row(
                "Size",
                '<div style="display:flex;gap:4px;width:100%;">' +
                  numInput("W", ov.width, "SpriteAnimation.clipOverride." + currentClip.id + ".width") +
                  numInput("H", ov.height, "SpriteAnimation.clipOverride." + currentClip.id + ".height") +
                  "</div>"
              ));
      }
    }

    body += section(
      editorState.sectionsOpen,
      "spriteanimation",
      "Sprite Animation",
      "film",
      (spriteAnimation.clips.length
        ? row("Clip", dropdownInput(clipOptions, currentClip ? currentClip.name : "", "SpriteAnimation.currentClipName")) +
          row(
            "Speed",
            numInput("", spriteAnimation.speed, "SpriteAnimation.speed")
          ) +
          overrideHtml
        : '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
          "No clips yet — open the Animation panel to import frames and create one." +
          "</div>") +
        '<button class="anim-open-btn" data-action="open-anim" style="margin-top:6px;width:100%;">' +
        icon("film", 12) +
        " Open Animation Editor</button>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="SpriteAnimation" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const rigidbody = entity.getComponent(RIGIDBODY_2D);
  // Fetched early (controller is normally looked up much further below,
  // see its own section) because the Freeze Rotation checkbox just below
  // needs to know up front whether a Car-type CharacterController is
  // steering this same body — see that checkbox's own comment.
  const controllerForRotationCheck = entity.getComponent(CHARACTER_CONTROLLER);
  const isCarSteered = controllerForRotationCheck && controllerForRotationCheck.controllerType === ControllerType.CAR;
  if (rigidbody) {
    let bodyTypeFieldsHtml = "";

    if (rigidbody.bodyType === BodyType.DYNAMIC) {
      // Dynamic: fully simulated by Rapier — mass, gravity, damping,
      // and rotation-lock all meaningfully affect the body.
      bodyTypeFieldsHtml =
        row(
          "Auto Mass",
          '<input type="checkbox" data-field="Rigidbody2D.autoMass" style="accent-color:#2C5D87;margin:0;"' +
            (rigidbody.autoMass !== false ? " checked" : "") +
            "/>"
        ) +
        (rigidbody.autoMass !== false
          ? '<div class="static-body-note" style="padding:3px 4px 6px;color:#8a93a0;font-size:10px;">Mass is calculated from attached collider geometry and density.</div>'
          : row("Mass", numInput("", rigidbody.mass, "Rigidbody2D.mass"))) +
        row("Gravity Scale", numInput("", rigidbody.gravityScale, "Rigidbody2D.gravityScale")) +
        row("Linear Damping", numInput("", rigidbody.linearDamping, "Rigidbody2D.linearDamping")) +
        row("Angular Damping", numInput("", rigidbody.angularDamping, "Rigidbody2D.angularDamping")) +
        row(
          "Freeze Rotation",
          '<input type="checkbox" data-field="Rigidbody2D.lockRotation" style="accent-color:#2C5D87;margin:0;"' +
            (rigidbody.lockRotation ? " checked" : "") +
            "/>"
        );
    } else if (rigidbody.bodyType === BodyType.KINEMATIC) {
      // Kinematic: moved by velocity/code, not forces — mass/gravity/
      // damping don't apply to a body Rapier never applies forces to.
      bodyTypeFieldsHtml =
        row(
          "Velocity",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("X", rigidbody.velocityX, "Rigidbody2D.velocityX") +
            numInput("Y", rigidbody.velocityY, "Rigidbody2D.velocityY") +
            "</div>"
        ) +
        row("Angular Velocity", numInput("", rigidbody.angularVelocity, "Rigidbody2D.angularVelocity")) +
        row(
          "Freeze Rotation",
          '<input type="checkbox" data-field="Rigidbody2D.lockRotation" style="accent-color:#2C5D87;margin:0;"' +
            (rigidbody.lockRotation ? " checked" : "") +
            "/>"
        ) +
        (isCarSteered && rigidbody.lockRotation
          ? '<div class="static-body-warning" style="padding:6px 4px;color:#c0863a;font-size:11px;">' +
            "Freeze Rotation is on, but this entity's CharacterController is set to Car — Car steering rotates the body every frame, so freezing it means the visible sprite turns while the physics collider stays facing its original direction. Turn Freeze Rotation off for a Car controller to steer correctly." +
            "</div>"
          : "");
    } else {
      // Static: never moves. No mass/gravity/damping/velocity fields —
      // it's just an immovable collider anchor, matching Unity's
      // convention of hiding these entirely for a static body.
      bodyTypeFieldsHtml =
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Static bodies never move — position is fixed in the physics simulation." +
        "</div>";
    }

    body += section(
      editorState.sectionsOpen,
      "rigidbody",
      "Rigidbody 2D",
      "refreshcw",
      row("Body Type", dropdownInput(Object.values(BodyType), rigidbody.bodyType, "Rigidbody2D.bodyType")) +
        row(
          "Simulated",
          '<input type="checkbox" data-field="Rigidbody2D.simulated" style="accent-color:#2C5D87;margin:0;"' +
            (rigidbody.simulated ? " checked" : "") +
            "/>"
        ) +
        bodyTypeFieldsHtml +
        (!entity.getComponent(COLLIDER_2D)
          ? '<div class="static-body-warning" style="padding:6px 4px;color:#c0863a;font-size:11px;">⚠️ No Collider 2D — this Rigidbody will pass through everything. Add a Collider 2D so physics collisions actually work.</div>'
          : "") +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Rigidbody2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const collider = entity.getComponent(COLLIDER_2D);
  if (collider) {
    const shapeFieldsHtml =
      collider.shape === ColliderShape.CIRCLE
        ? row("Radius", numInput("", collider.radius, "Collider2D.radius"))
        : collider.shape === ColliderShape.CAPSULE
        ? row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("Half H", collider.capsuleHalfHeight, "Collider2D.capsuleHalfHeight") +
              numInput("Radius", collider.capsuleRadius, "Collider2D.capsuleRadius") +
              "</div>"
          )
        : collider.shape === ColliderShape.TRIANGLE
        ? row(
            "Points",
            '<div class="static-body-note" style="color:#888;font-size:11px;line-height:1.4;">Drag the 3 yellow handles ' +
              "directly in the Scene view to reshape.</div>"
          )
        : row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("W", collider.width, "Collider2D.width") +
              numInput("H", collider.height, "Collider2D.height") +
              "</div>"
          );

    body += section(
      editorState.sectionsOpen,
      "collider",
      "Collider 2D",
      "box",
      row("Shape", dropdownInput(Object.values(ColliderShape), collider.shape, "Collider2D.shape")) +
        shapeFieldsHtml +
        row(
          "Offset",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("X", collider.offsetX, "Collider2D.offsetX") +
            numInput("Y", collider.offsetY, "Collider2D.offsetY") +
            "</div>"
        ) +
        row(
          "Is Trigger",
          '<input type="checkbox" data-field="Collider2D.isTrigger" style="accent-color:#2C5D87;margin:0;"' +
            (collider.isTrigger ? " checked" : "") +
            "/>"
        ) +
        (collider.shape === ColliderShape.BOX && !collider.isTrigger
          ? row(
              "One-Way Platform",
              '<input type="checkbox" data-field="Collider2D.isOneWayPlatform" style="accent-color:#2C5D87;margin:0;"' +
                (collider.isOneWayPlatform ? " checked" : "") +
                "/>"
            ) +
            '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
            "Solid only when something lands on top from above — a body jumping up from below or approaching from the side passes straight through, like a Mario-style jump-through platform." +
            "</div>"
          : "") +
        row("Friction", numInput("", collider.friction, "Collider2D.friction")) +
        row("Restitution", numInput("", collider.restitution, "Collider2D.restitution")) +
        row("Density", numInput("", collider.density, "Collider2D.density")) +
        // Collision layer/mask — controls which physics layers this collider
        // physically interacts with (both collision response and script events).
        // Layer names are defined by the user in Edit > Physics Layers.
        (function() {
          const namedLayers = getNamedLayers();
          // Show the current layer even if its slot has no name (edge case: user
          // cleared a layer's name while a collider was still assigned to it).
          const layerOptions = namedLayers.length
            ? namedLayers
            : [{ index: 0, name: "Default" }];
          const currentLayerNamed = layerOptions.some(l => l.index === collider.layer);
          const selectOptions = [
            ...(currentLayerNamed ? [] : [{ index: collider.layer, name: "Layer " + collider.layer + " (unnamed)" }]),
            ...layerOptions,
          ];

          return (
            row(
              "Layer",
              '<select data-field="Collider2D.layer" style="flex:1;background:#1a2030;color:#c8d0de;border:1px solid #2e3a50;border-radius:4px;padding:2px 4px;font-size:11px;">' +
                selectOptions.map(({ index, name }) =>
                  '<option value="' + index + '"' + (collider.layer === index ? ' selected' : '') + '>' +
                    name + ' (' + index + ')' +
                  '</option>'
                ).join('') +
              '</select>'
            ) +
            '<div style="padding:2px 0 4px 0;">' +
              '<div style="font-size:10px;color:#8a93a0;padding:2px 0 4px 0;letter-spacing:0.03em;">COLLIDES WITH</div>' +
              (namedLayers.length === 0
                ? '<div style="font-size:10px;color:#5a6480;padding:2px 0;">No layers defined. Use Edit &gt; Physics Layers\u2026 to add some.</div>'
                : '<div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;">' +
                    namedLayers.map(({ index, name }) =>
                      '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#c8d0de;cursor:pointer;padding:1px 0;">' +
                        '<input type="checkbox" data-field="Collider2D.mask" data-bit="' + index + '"' +
                          ((collider.mask & (1 << index)) ? ' checked' : '') +
                          ' style="accent-color:#2C5D87;margin:0;cursor:pointer;">' +
                        name +
                      '</label>'
                    ).join('') +
                  '</div>'
              ) +
            '</div>'
          );
        })() +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Collider2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const joint = entity.getComponent(JOINT_2D);
  if (joint) {
    const jt = joint.jointType;
    const isRevolute = jt === JointType2D.REVOLUTE;
    const isPrismatic = jt === JointType2D.PRISMATIC;
    const isRope = jt === JointType2D.ROPE;
    const isSpring = jt === JointType2D.SPRING;
    const hasMotorAndLimits = isRevolute || isPrismatic;
    const hasWorldAnchor = !joint.connectedEntityId;

    // Every other entity that has a Rigidbody2D can be the joint's second
    // body (PhysicsWorld looks the connected entity up by id in its body
    // handles, so one with no Rigidbody2D could never be attached to).
    // The entity itself is excluded — a body can't be jointed to itself.
    const connectableEntities = world
      ? world.getAllEntities().filter((e) => e.id !== entity.id && e.hasComponent(RIGIDBODY_2D))
      : [];
    const connectedStillExists = !joint.connectedEntityId || connectableEntities.some((e) => e.id === joint.connectedEntityId);
    const connectedOptionsHtml =
      '<option value=""' + (!joint.connectedEntityId ? " selected" : "") + ">World (fixed point)</option>" +
      connectableEntities
        .map(
          (e) =>
            '<option value="' + esc(e.id) + '"' + (e.id === joint.connectedEntityId ? " selected" : "") + ">" +
            esc(e.name) +
            "</option>"
        )
        .join("") +
      // Keep a stale reference visible instead of silently showing "World"
      // while the saved data still points at a deleted / Rigidbody-less
      // entity — that mismatch would be very confusing to debug.
      (!connectedStillExists
        ? '<option value="' + esc(joint.connectedEntityId) + '" selected>⚠ Missing (' + esc(joint.connectedEntityId) + ")</option>"
        : "");
    const connectedPickerHtml =
      '<div class="dropdown-input"><select data-field="Joint2D.connectedEntityId">' +
      connectedOptionsHtml +
      "</select>" +
      icon("chevrondown", 10, "chev") +
      "</div>";

    const xyRow = (label, xProp, yProp) =>
      row(
        label,
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("X", joint[xProp], "Joint2D." + xProp) +
          numInput("Y", joint[yProp], "Joint2D." + yProp) +
          "</div>"
      );
    const checkboxRow = (label, prop) =>
      row(
        label,
        '<input type="checkbox" data-field="Joint2D.' + prop + '" style="accent-color:#2C5D87;margin:0;"' +
          (joint[prop] ? " checked" : "") +
          "/>"
      );

    let typeFieldsHtml = "";
    if (isPrismatic) {
      typeFieldsHtml += xyRow("Slide Axis", "axisX", "axisY");
    }
    if (isRope) {
      typeFieldsHtml +=
        row("Max Length", numInput("", joint.length, "Joint2D.length")) +
        row("Rope Links", numInput("", joint.segmentCount, "Joint2D.segmentCount")) +
        row("Rope Mass", numInput("", joint.ropeMass, "Joint2D.ropeMass"));
    }
    if (isSpring) {
      typeFieldsHtml +=
        row("Rest Length", numInput("", joint.length, "Joint2D.length")) +
        row("Stiffness", numInput("", joint.stiffness, "Joint2D.stiffness")) +
        row("Damping", numInput("", joint.damping, "Joint2D.damping")) +
        row("String Links", numInput("", joint.segmentCount, "Joint2D.segmentCount")) +
        row("String Mass", numInput("", joint.ropeMass, "Joint2D.ropeMass"));
    }
    if (isRope || isSpring) {
      const jointTextureAsset = joint.textureKey ? getSpriteAsset(joint.textureKey) : null;
      const jointTextureDisplayName = jointTextureAsset ? jointTextureAsset.name : joint.textureKey || "None";

      typeFieldsHtml +=
        checkboxRow("Show Rope/String", "visualEnabled") +
        row("Thickness", numInput("", joint.visualThickness, "Joint2D.visualThickness")) +
        (joint.visualEnabled
          ? row("Use Texture", '<input type="checkbox" data-field="Joint2D.useTexture" style="accent-color:#2C5D87;margin:0;"' +
              (joint.useTexture ? " checked" : "") +
              "/>")
          : "") +
        (joint.visualEnabled && joint.useTexture
          ? row(
              "Texture",
              '<div class="sprite-row"><div class="sprite-box">' +
                jointTextureDisplayName +
                '</div><button class="sprite-pick" data-action="open-sprite-picker" data-target="Joint2D" title="Choose a texture"><span></span></button></div>'
            ) +
            row(
              "Texture Mode",
              dropdownInput(
                [
                  { value: "stretch", label: "Stretch" },
                  { value: "tile", label: "Tile (no stretch)" },
                ],
                joint.textureMode,
                "Joint2D.textureMode"
              ) +
                (joint.textureMode === "stretch"
                  ? '<div class="static-body-note" style="color:#888;font-size:10px;margin-top:3px;">Fits the whole image to the rope/string end-to-end — image warps as it swings and its length changes.</div>'
                  : '<div class="static-body-note" style="color:#888;font-size:10px;margin-top:3px;">Repeats the image at its own size — never stretches, however the rope moves.</div>')
            ) +
            (joint.textureMode === "tile"
              ? row("Tile Length", numInput("", joint.textureTiling, "Joint2D.textureTiling"))
              : "") +
            row("Texture Offset", numInput("", joint.textureOffset, "Joint2D.textureOffset")) +
            row(
              "Flip Texture",
              '<input type="checkbox" data-field="Joint2D.textureFlip" style="accent-color:#2C5D87;margin:0;"' +
                (joint.textureFlip ? " checked" : "") +
                "/>"
            )
          : (joint.visualEnabled
              ? row("Color", '<input type="color" data-field="Joint2D.visualColor" value="' + (joint.visualColor || "#c8a66a") + '" style="width:44px;height:22px;padding:0;border:1px solid #3a3a3a;background:#222;"/>' )
              : ""));
    }
    if (isRevolute) {
      typeFieldsHtml +=
        row("Flexibility (%)", numInput("0–100", joint.flexibility ?? 100, "Joint2D.flexibility")) +
        row("Joint Drag", numInput("0 = none", joint.jointDrag ?? 0, "Joint2D.jointDrag")) +
        row("Rest Stiffness", numInput("0 = none", joint.restStiffness ?? 0, "Joint2D.restStiffness")) +
        checkboxRow("Breakable", "breakable") +
        (joint.breakable
          ? row("Break Force", numInput("force", joint.breakForce ?? 10000, "Joint2D.breakForce"))
          : "") +
        '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin:-2px 0 4px;">100% flexibility with zero drag/stiffness is a free hinge. Drag damps rotation; Rest Stiffness resists leaving the joint’s creation angle.</div>';
    }
    if (hasMotorAndLimits) {
      const limitUnit = isRevolute ? "°" : "px";
      const speedUnit = isRevolute ? "°/s" : "px/s";
      typeFieldsHtml +=
        checkboxRow("Use Limits", "limitsEnabled") +
        (joint.limitsEnabled
          ? row(
              "Limits (" + limitUnit + ")",
              '<div style="display:flex;gap:4px;width:100%;">' +
                numInput("Min", joint.limitMin, "Joint2D.limitMin") +
                numInput("Max", joint.limitMax, "Joint2D.limitMax") +
                "</div>"
            )
          : "") +
        checkboxRow("Use Motor", "motorEnabled") +
        (joint.motorEnabled
          ? row("Speed (" + speedUnit + ")", numInput("", joint.motorSpeed, "Joint2D.motorSpeed")) +
            row("Max Force", numInput("", joint.motorMaxForce, "Joint2D.motorMaxForce")) +
            (joint.motorMaxForce === 0
              ? '<div class="static-body-warning" style="padding:6px 4px;color:#c0863a;font-size:11px;">' +
                "Max Force is 0, which keeps the motor switched off. Raise it to let the motor actually drive the joint." +
                "</div>"
              : "")
          : "");
    }

    const typeHint =
      isRevolute ? "Hinge: free to rotate around the anchor point."
      : isPrismatic ? "Slider: free to move along the slide axis only."
      : isRope ? "Rope: a distributed chain of real physics links. It can go slack, sag under gravity, collide with the world, and never exceed Max Length."
      : isSpring ? "String: a distributed elastic chain. Each link has its own mass and spring force, so the string stretches, sags, and oscillates under gravity."
      : "Fixed: welds the two bodies together with no relative motion.";

    body += section(
      editorState.sectionsOpen,
      "joint2d",
      "Joint 2D",
      "route",
      row("Joint Type", dropdownInput(Object.values(JointType2D), joint.jointType, "Joint2D.jointType")) +
        '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin:-2px 0 4px;">' + typeHint + "</div>" +
        row("Connected To", connectedPickerHtml) +
        (connectableEntities.length === 0 && hasWorldAnchor
          ? '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin:-2px 0 4px;">No other object with a Rigidbody 2D in the scene, so this joint is pinned to a fixed point in the world.</div>'
          : "") +
        xyRow("Anchor (this)", "anchor1X", "anchor1Y") +
        xyRow(hasWorldAnchor ? "Anchor (world)" : "Anchor (other)", "anchor2X", "anchor2Y") +
        typeFieldsHtml +
        checkboxRow("Disable Connected Collision", "disableConnectedCollision") +
        '<div class="static-body-note" style="color:#8a93a0;font-size:10px;margin:-2px 0 4px;">When checked, only this connected pair passes through each other. Their physics layers and collisions with other objects are unchanged.</div>' +
        checkboxRow("Enabled", "enabled") +
        (!entity.hasComponent(RIGIDBODY_2D)
          ? '<div class="static-body-warning" style="padding:6px 4px;color:#c0863a;font-size:11px;">⚠️ No Rigidbody 2D — this joint does nothing until this object has one (and a Collider 2D).</div>'
          : "") +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Joint2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const controller = entity.getComponent(CHARACTER_CONTROLLER);
  if (controller) {
    const isPlatformer = controller.controllerType === ControllerType.PLATFORMER;
    const isFree = controller.controllerType === ControllerType.FREE;
    const isCharacter = controller.controllerType === ControllerType.CHARACTER;
    const isCar = controller.controllerType === ControllerType.CAR;
    const isFollow = controller.controllerType === ControllerType.FOLLOW;
    const isPatrol = controller.controllerType === ControllerType.PATROL;
    const jumpCapable = (isCharacter || isPlatformer) && controller.canJump;

    let typeSpecificHtml = "";
    if (isFree) {
      typeSpecificHtml =
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Free: no built-in input mapping. A script drives Rigidbody2D directly; the tunables below are still readable from script." +
        "</div>";
    } else if (isCar) {
      typeSpecificHtml =
        row("Max Speed", numInput("", controller.maxSpeed, "CharacterController.maxSpeed")) +
        row("Acceleration", numInput("", controller.carAcceleration, "CharacterController.carAcceleration")) +
        row("Brake Force", numInput("", controller.brakeForce, "CharacterController.brakeForce")) +
        row("Turn Speed", numInput("", controller.turnSpeed, "CharacterController.turnSpeed")) +
        row("Drift Factor", numInput("", controller.driftFactor, "CharacterController.driftFactor")) +
        row("Drive Toward Arrive Dist.", numInput("", controller.driveTowardArriveDistance, "CharacterController.driveTowardArriveDistance")) +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        (controller.useDefaultInput
          ? "Use Default Input is ON: throttle/brake/steer read WASD/Arrows automatically."
          : "Use Default Input is OFF: WASD/Arrows are ignored. Drive it from a script instead with this.controller.simulateDrive(throttle, steer) every frame you want it moving — throttle/steer are -1..1, so any key you pick, a Joystick component (this.joystick.x/.y), or another input source works.") +
        "</div>" +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Chase-car autopilot: this.controller.simulateDriveToward(x, y) drives/drifts straight toward a point using the settings above. Add a Nav Agent 2D component to also get this.navDriveToward(x, y) — same driving feel, but pathing around obstacles." +
        "</div>";
    } else if (isFollow) {
      typeSpecificHtml =
        row("Target Name", '<input type="text" data-field="CharacterController.targetName" value="' + esc(controller.targetName) + '" style="width:100%;background:#2a2a2a;border:1px solid #3a3a3a;color:#dcdcdc;padding:3px 6px;border-radius:3px;font-size:11px;"/>') +
        row("Follow Speed", numInput("", controller.followSpeed, "CharacterController.followSpeed")) +
        row("Follow Distance", numInput("", controller.followDistance, "CharacterController.followDistance"));
    } else if (isPatrol) {
      const isTopDownPatrol = controller.patrolMode === PatrolMode.TOP_DOWN;
      const isVerticalPatrol = isTopDownPatrol && controller.patrolAxis === PatrolAxis.VERTICAL;
      const obstacleWord = isVerticalPatrol ? "something above/below" : "a wall";
      const scriptExample = isVerticalPatrol ? "this.controller.simulateMove(0, y)" : "this.controller.simulateMove(x, 0)";
      typeSpecificHtml =
        row("Move Speed", numInput("", controller.moveSpeed, "CharacterController.moveSpeed")) +
        row("Acceleration", numInput("", controller.acceleration, "CharacterController.acceleration")) +
        row("Patrol Distance", numInput("", controller.patrolDistance, "CharacterController.patrolDistance")) +
        row("Patrol Mode", dropdownInput(Object.values(PatrolMode), controller.patrolMode, "CharacterController.patrolMode")) +
        (isTopDownPatrol
          ? row("Patrol Axis", dropdownInput(Object.values(PatrolAxis), controller.patrolAxis, "CharacterController.patrolAxis"))
          : "") +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        (isTopDownPatrol
          ? "Top-Down mode: no gravity, walks along the " + controller.patrolAxis + " axis only."
          : "Platformer mode: gravity always on, walks left/right only. No jump.") +
        "</div>" +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        (controller.useDefaultInput
          ? "Use Default Input is ON: walks automatically, turning around at " + obstacleWord + " or after Patrol Distance px — whichever comes first."
          : "Use Default Input is OFF: auto-walk and auto-turn are disabled. Drive it from a script instead with " + scriptExample + " every frame you want it moving.") +
        "</div>";
    } else {
      typeSpecificHtml =
        row("Move Speed", numInput("", controller.moveSpeed, "CharacterController.moveSpeed")) +
        row("Acceleration", numInput("", controller.acceleration, "CharacterController.acceleration"));

      if (isPlatformer) {
        typeSpecificHtml += row("Air Control", numInput("", controller.airControl, "CharacterController.airControl"));
      }

      if (isCharacter) {
        typeSpecificHtml += row(
          "Use Gravity",
          '<input type="checkbox" data-field="CharacterController.useGravity" style="accent-color:#2C5D87;margin:0;"' +
            (controller.useGravity ? " checked" : "") +
            "/>"
        );
      }

      if ((isCharacter || isPlatformer) && (isPlatformer || controller.useGravity)) {
        // Platformer always has gravity on (no toggle above), so this
        // always shows for it. For Character Controller it only makes
        // sense while Use Gravity is checked — with gravity off there's
        // nothing for a scale to multiply (see ControllerSystem.js's
        // _applyKinematic: gravityScale only ever multiplies GRAVITY_Y,
        // which isn't applied at all when useGravity is false).
        typeSpecificHtml += row("Gravity Scale", numInput("", controller.gravityScale, "CharacterController.gravityScale"));
      }

      if (isCharacter || isPlatformer) {
        typeSpecificHtml +=
          row(
            "Can Jump",
            '<input type="checkbox" data-field="CharacterController.canJump" style="accent-color:#2C5D87;margin:0;"' +
              (controller.canJump ? " checked" : "") +
              "/>"
          ) +
          (jumpCapable
            ? row("Jump Force", numInput("", controller.jumpForce, "CharacterController.jumpForce")) +
              row("Max Jumps", numInput("", controller.maxJumps, "CharacterController.maxJumps"))
            : "");
      }
    }

    body += section(
      editorState.sectionsOpen,
      "movement",
      "Movement Type",
      "move",
      row("Controller Type", dropdownInput(Object.values(ControllerType), controller.controllerType, "CharacterController.controllerType")) +
        row(
          "Use Default Input",
          '<input type="checkbox" data-field="CharacterController.useDefaultInput" style="accent-color:#2C5D87;margin:0;"' +
            (controller.useDefaultInput ? " checked" : "") +
            "/>"
        ) +
        typeSpecificHtml +
        (rigidbody && rigidbody.bodyType === BodyType.STATIC
          ? '<div class="static-body-warning" style="padding:6px 4px;color:#c0863a;font-size:11px;">' +
            "This entity's Rigidbody2D Body Type is Static — a Static body never moves. Set Body Type to Dynamic (recommended — gets real collision push-back/landing from Rapier) or Kinematic above for this movement type to take effect." +
            "</div>"
          : !rigidbody
          ? '<div class="static-body-warning" style="padding:6px 4px;color:#c0863a;font-size:11px;">' +
            "Add a Rigidbody2D for this movement type to actually move the object — Dynamic is recommended for the most realistic collision response (pushback, landing on slopes), or use Kinematic for a controller that ignores physics forces. Physics itself is still handled entirely by Rapier either way." +
            "</div>"
          : "") +
        '<button class="removecomp-btn" data-action="remove-component" data-component="CharacterController" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const script = entity.getComponent(SCRIPT);
  if (script && script.scriptName) {
    body += section(
      editorState.sectionsOpen,
      "script",
      "Script",
      "code",
      row("Script Name", '<input type="text" class="num-input" value="' + esc(script.scriptName) + '" placeholder="No script — deleted or never assigned" data-field="Script.scriptName" style="width:100%;box-sizing:border-box;" />') +
      row("Enabled", '<input type="checkbox"' + (script.enabled ? " checked" : "") + ' data-action="toggle-script-enabled" />') +
      '<div style="padding:6px 0;">' +
      '<button class="animwin-btn" data-action="open-script-editor" style="width:100%;">' + icon("code", 12) + " Open Script Editor</button>" +
      "</div>" +
      '<button class="removecomp-btn" data-action="remove-component" data-component="Script" style="margin-top:6px;">Remove Component</button>'
    );
  } else if (script) {
    // Script component exists but its scriptName was cleared (the
    // script it pointed to was deleted via deleteScriptEverywhere —
    // see ScriptEditorWindow.js's _clearScriptOnEntities). Same
    // "nothing attached yet" choice as a brand-new Script component
    // below, but keep the Remove Component button since the component
    // itself is still present on the entity.
    body += section(
      editorState.sectionsOpen,
      "script",
      "Script",
      "code",
      '<div style="padding:6px 0;display:flex;flex-direction:column;gap:6px;">' +
      '<button class="animwin-btn" data-action="inspector-create-script" style="width:100%;">' + icon("plus", 12) + " Create New Script</button>" +
      '<button class="animwin-btn" data-action="open-script-picker" style="width:100%;">' + icon("code", 12) + " Load Script...</button>" +
      "</div>" +
      '<button class="removecomp-btn" data-action="remove-component" data-component="Script" style="margin-top:6px;">Remove Component</button>'
    );
  } else {
    body += section(
      editorState.sectionsOpen,
      "script",
      "Script",
      "code",
      '<div style="padding:6px 0;display:flex;flex-direction:column;gap:6px;">' +
      '<button class="animwin-btn" data-action="inspector-create-script" style="width:100%;">' + icon("plus", 12) + " Create New Script</button>" +
      '<button class="animwin-btn" data-action="open-script-picker" style="width:100%;">' + icon("code", 12) + " Load Script...</button>" +
      "</div>"
    );
  }

  // The actual list + search UI lives in its own centered, scrollable
  // modal (see AddComponentWindow.js, rendered by main.js alongside the
  // other picker popups like "Load Script"/"Choose Sprite") instead of
  // an inline dropdown here — an inline absolute-positioned menu had no
  // max-height/overflow, so once enough component types existed it grew
  // taller than the Inspector panel and its lowest entries ran off-
  // screen, unclickable. This button now only opens that modal.
  body +=
    '<div class="addcomp-wrap">' +
    '<button class="addcomp-btn" data-action="add-component">Add Component</button>' +
    "</div>";
  body +=
    '<div class="animwin-wrap"><button class="animwin-btn" data-action="open-anim">' +
    icon("film", 12) +
    " Open Animation Window</button></div>";

  const notesOn = document.body.classList.contains("show-component-notes");
  return (
    '<div class="inspector-panel">' +
    '<div class="inspector-tabbar">' +
    tabBtn(true, "Inspector", "info") +
    '<div style="display:flex;align-items:center;">' +
    '<button class="more inspector-notes-btn' + (notesOn ? " active" : "") + '" data-action="toggle-component-notes" title="' +
    (notesOn ? "Hide component notes" : "Show component notes") +
    '">' +
    icon("info", 12) +
    "</button>" +
    '<button class="more">' +
    icon("morevertical", 12) +
    "</button>" +
    "</div></div>" +
    '<div class="inspector-body">' +
    '<div class="obj-header">' +
    '<div class="obj-header-row1">' +
    '<input type="checkbox"' +
    (entity.active ? " checked" : "") +
    ' data-action="toggle-entity-active" />' +
    '<input type="text" class="obj-name-input" value="' +
    esc(entity.name) +
    '" data-action="rename-entity" />' +
    (!(entity.prefabId && getPrefab(entity.prefabId))
      ? '<button class="obj-header-icon-btn" data-action="create-prefab" title="Create a prefab from this object">' +
        icon("box", 13) +
        "</button>"
      : "") +
    "</div>" +
    '<div class="obj-header-row2">' +
    '<div class="tag-layer-group"><span>Tag</span>' +
     dropdownInput(
       [...new Set([...getTagNames(), entity.tag, "Add Tag..."])],
       entity.tag,
       "entity.tag"
     ) +
     (!BUILTIN_TAGS.has(entity.tag)
       ? '<button class="tag-delete-btn" data-action="delete-tag" data-tag="' + esc(entity.tag) + '" title="Remove \'' + esc(entity.tag) + '\' from the project tag list">✕</button>'
       : '') +
    "</div>" +
    "</div>" +
    renderPrefabSection(entity) +
    body +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

/**
 * The Inspector's "Prefab" strip — shown only for an entity linked to a
 * (still-existing) prefab, right below the name/tag header and above
 * every component section, matching where Unity shows its own prefab
 * banner. A dangling prefabId (the prefab was deleted from the
 * catalogue — see PrefabRegistry.deletePrefab()'s doc comment) is
 * treated exactly like "not linked" and renders nothing here, same as
 * a null prefabId.
 *
 * Three actions:
 *   - "Update Prefab": THIS instance's current data becomes the
 *     prefab's new canonical template, pushed out to every other
 *     instance in every scene (see PrefabPropagation.updatePrefabFromEntity,
 *     wired up in EditorEvents.js's "update-prefab" case).
 *   - "Revert": wipes this instance's own overrides and re-syncs every
 *     field from the prefab's current data (PrefabPropagation.
 *     revertInstanceToPrefab).
 *   - "Unpack": detaches this instance from the prefab entirely,
 *     leaving its current data exactly as-is (PrefabPropagation.
 *     unlinkFromPrefab).
 * "Revert" and the override count are only shown when this instance
 * actually HAS any overrides — an unmodified instance has nothing to
 * revert, so showing a disabled/no-op button there would just be
 * clutter.
 * @param {import('../../runtime/core/Entity.js').Entity} entity
 * @returns {string}
 */
function renderPrefabSection(entity) {
  if (!entity.prefabId) return "";
  const prefab = getPrefab(entity.prefabId);
  if (!prefab) return "";

  const overrideCount = Object.values(entity.prefabOverrides || {}).reduce((n, props) => n + props.length, 0);

  return (
    '<div class="prefab-strip">' +
    '<div class="prefab-strip-row">' +
    icon("box", 12) +
    '<span class="prefab-strip-name">' +
    prefab.name +
    "</span>" +
    (overrideCount > 0
      ? '<span class="prefab-strip-override-count" title="' +
        overrideCount +
        ' field(s) overridden on this instance">' +
        overrideCount +
        " override" + (overrideCount === 1 ? "" : "s") +
        "</span>"
      : "") +
    "</div>" +
    '<div class="prefab-strip-actions">' +
    '<div class="prefab-transform-options" title="Choose which parts of the source Transform should update existing prefab instances. Unchecked fields keep each instance\'s own value.">' +
    '<span class="prefab-transform-options-label">Update Transform:</span>' +
    '<label class="prefab-transform-option" title="Copy Position (X, Y, Z) to instances that have not overridden it">' +
    '<input type="checkbox" data-action="prefab-update-apply-position" />' +
    '<span>Position</span>' +
    '</label>' +
    '<label class="prefab-transform-option" title="Copy Rotation to instances that have not overridden it">' +
    '<input type="checkbox" data-action="prefab-update-apply-rotation" />' +
    '<span>Rotation</span>' +
    '</label>' +
    '<label class="prefab-transform-option" title="Copy Scale (X, Y) to instances that have not overridden it">' +
    '<input type="checkbox" data-action="prefab-update-apply-scale" />' +
    '<span>Scale</span>' +
    '</label>' +
    '</div>' +
    '<button class="prefab-strip-btn prefab-strip-btn-primary" data-action="update-prefab" title="Push this instance\'s current values to the prefab and every other instance">' +
    icon("upload", 11) +
    " Update Prefab</button>" +
    (overrideCount > 0
      ? '<button class="prefab-strip-btn" data-action="revert-prefab" title="Discard this instance\'s own edits and re-sync from the prefab">' +
        icon("undo", 11) +
        " Revert</button>"
      : "") +
    '<button class="prefab-strip-btn" data-action="unpack-prefab" title="Detach this instance from the prefab (keeps its current values)">' +
    icon("unlink", 11) +
    " Unpack</button>" +
    "</div>" +
    "</div>"
  );
}
