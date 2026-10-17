/**
 * editor/panels/UIComponents.js
 *
 * Small reusable HTML-string builders shared across editor panels:
 * tabs, label rows, numeric inputs, vec3 inputs, dropdowns, collapsible
 * sections. Editor-only, no runtime dependency.
 */

import { icon } from "../icons/IconLibrary.js";

/**
 * Escapes a value for safe use inside an HTML attribute (e.g. a
 * data-* attribute or an input's value="..."). Shared by any panel
 * that interpolates user-provided text (entity/folder/asset names)
 * into an HTML string — BottomPanel.js's asset grid and Hierarchy.js's
 * folder rows both use this instead of keeping their own copies.
 * @param {*} s
 * @returns {string}
 */
/**
 * Escapes a value for use in HTML built by string concatenation — safe both
 * inside a quoted attribute and as text between tags. Project data (entity,
 * asset and script names...) can come from other people's files, so it must
 * never be inserted raw.
 */
export function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export const escapeHtml = escapeAttr;

export function tabBtn(active, label, iconName, extraHtml, dataAction) {
  return (
    '<button class="tab-btn' +
    (active ? " active" : "") +
    '"' +
    (dataAction ? ' data-action="' + dataAction + '"' : "") +
    ">" +
    icon(iconName, 12) +
    "<span>" +
    label +
    "</span>" +
    (extraHtml || "") +
    "</button>"
  );
}

export function row(label, contentHtml) {
  return '<div class="row"><span class="row-label">' + label + '</span><div class="row-content">' + contentHtml + "</div></div>";
}

export function numInput(label, value, dataField, dataAxis) {
  const dataAttrs =
    (dataField ? ' data-field="' + dataField + '"' : "") + (dataAxis ? ' data-axis="' + dataAxis + '"' : "");
  return (
    '<div class="numinput">' +
    (label ? '<span class="axis-label">' + label + "</span>" : "") +
    '<input type="number" value="' + value + '"' + dataAttrs + " />" +
    "</div>"
  );
}

export function vec3Input(x, y, z, dataField) {
  return (
    '<div class="vec3">' +
    numInput("X", x, dataField, "x") +
    numInput("Y", y, dataField, "y") +
    numInput("Z", z, dataField, "z") +
    "</div>"
  );
}

// 2D-only counterpart to vec3Input above — used for fields that
// genuinely only have X/Y (e.g. Transform.scaleX/scaleY: this is a 2D
// engine, there's no scaleZ on the component — see runtime/components/
// Transform.js). Reuses the same .vec3 row layout (a plain flex row,
// name notwithstanding) since it already sizes any number of .numinput
// children correctly.
export function vec2Input(x, y, dataField) {
  return (
    '<div class="vec3">' +
    numInput("X", x, dataField, "x") +
    numInput("Y", y, dataField, "y") +
    "</div>"
  );
}

export function dropdownInput(options, selected, dataField) {
  return (
    '<div class="dropdown-input"><select' + (dataField ? ' data-field="' + dataField + '"' : "") + ">" +
    options.map((o) => {
      const value = typeof o === "object" ? o.value : o;
      const label = typeof o === "object" ? o.label : o;
      // Values/labels can be project data (tag names, layer names...): escape on output only,
      // compare on the raw values.
      return '<option value="' + escapeAttr(value) + '"' + (value === selected ? " selected" : "") + ">" + escapeAttr(label) + "</option>";
    }).join("") +
    "</select>" +
    icon("chevrondown", 10, "chev") +
    "</div>"
  );
}

/**
 * @param {object} sectionsOpen state map of which sections are expanded
 */
export function section(sectionsOpen, key, title, iconName, bodyHtml) {
  const open = sectionsOpen[key] !== false;
  return (
    '<div class="section" data-section-key="' + key + '">' +
    '<div class="section-header">' +
    '<button class="section-toggle" data-action="toggle-section" data-key="' +
    key +
    '">' +
    icon(open ? "chevrondown" : "chevronright", 12) +
    "</button>" +
    '<div class="section-title-row">' +
    '<input type="checkbox" checked />' +
    '<span class="icon-wrap">' +
    icon(iconName, 12) +
    "</span>" +
    "<span>" +
    title +
    "</span>" +
    "</div>" +
    '<button class="section-settings">' +
    icon("settings", 11) +
    "</button>" +
    "</div>" +
    (open ? '<div class="section-body">' + bodyHtml + "</div>" : "") +
    "</div>"
  );
}
