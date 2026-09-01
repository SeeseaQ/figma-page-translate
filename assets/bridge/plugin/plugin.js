// Show UI (hidden) so we can use Web APIs (WebSocket in ui.html)
figma.showUI(__html__, { visible: false });

// ---------- Bridge ----------
figma.ui.onmessage = async (msg) => {
  const { id, action, args } = msg || {};
  try {
    // Batch text writes are queued and acknowledged immediately so the MCP
    // bridge returns fast (avoids framework request timeouts). A background
    // worker drains the queue serially. The actual writes happen async.
    if (action === "set_text_batch") {
      const items = (args && args.items) || [];
      enqueueBatch(items);
      reply(id, { ok: true, status: "queued", count: items.length });
      return;
    }
    const result = await handleAction(action, args || {});
    reply(id, Object.assign({ ok: true }, result || {}));
  } catch (e) {
    reply(id, { ok: false }, e instanceof Error ? e.message : String(e));
  }
};
function reply(replyTo, result, error) {
  figma.ui.postMessage({ replyTo, result, error });
}
const page = () => figma.currentPage;

// ---------- Font cache (avoid re-loading the same font thousands of times) ----------
const loadedFonts = new Set();
async function loadFont(family, style) {
  const key = family + "|" + style;
  if (loadedFonts.has(key)) return;
  await figma.loadFontAsync({ family, style });
  loadedFonts.add(key);
}

// ---------- Serial batch queue (drained by a single background worker) ----------
let batchQueue = [];
let batchRunning = false;
function enqueueBatch(items) {
  if (Array.isArray(items) && items.length) batchQueue = batchQueue.concat(items);
  if (!batchRunning) { batchRunning = true; batchWorker(); }
}
async function batchWorker() {
  while (batchQueue.length) {
    const items = batchQueue;
    batchQueue = [];
    try { await processBatch(items); }
    catch (e) { console.error("[bridge] batch segment error:", e); }
  }
  batchRunning = false;
}

// ---------- Utilities ----------
function hexToRGB(hex) {
  const v = String(hex || "").replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(v)) throw new Error("Invalid hex color");
  return { r: parseInt(v.slice(0,2),16)/255, g: parseInt(v.slice(2,4),16)/255, b: parseInt(v.slice(4,6),16)/255 };
}
function rgbToHex(c) {
  const h = (v) => ("0" + Math.round((v || 0) * 255).toString(16)).slice(-2);
  return "#" + h(c.r) + h(c.g) + h(c.b);
}
function getNode(id) {
  const n = figma.getNodeById(id);
  if (!n) throw new Error("Node not found: " + id);
  return n;
}
function assertFills(n) {
  if (!("fills" in n)) throw new Error("Node does not support fills");
}
function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- Actions dispatcher ----------
async function handleAction(action, input) {
  switch (action) {
    // Create
    case "create_frame": return createFrame(input);
    case "create_rectangle": return createRectangle(input);
    case "create_ellipse": return createEllipse(input);
    case "create_line": return createLine(input);
    case "create_polygon": return createPolygon(input);
    case "create_star": return createStar(input);
    case "add_text": return addText(input);
    case "place_image_base64": return placeImageBase64(input);

    // Selection / find / pages
    case "find_nodes": return findNodes(input);
    case "select_nodes": return selectNodes(input);
    case "get_selection": return getSelection();
    case "create_page": return createPage(input);
    case "set_current_page": return setCurrentPage(input);

    // Node management
    case "rename_node": return renameNode(input);
    case "delete_node": return deleteNode(input);
    case "duplicate_node": return duplicateNode(input);
    case "resize_node": return resizeNode(input);
    case "rotate_node": return rotateNode(input);
    case "set_position": return setPosition(input);
    case "group_nodes": return groupNodes(input);
    case "ungroup": return ungroup(input);

    // Styling
    case "set_fill": return setFill(input);
    case "set_stroke": return setStroke(input);
    case "set_corner_radius": return setCornerRadius(input);
    case "set_opacity": return setOpacity(input);
    case "set_blend_mode": return setBlendMode(input);
    case "add_effect": return addEffect(input);
    case "clear_effects": return clearEffects(input);
    case "layout_grid_add": return layoutGridAdd(input);
    case "layout_grid_clear": return layoutGridClear(input);

    // Auto Layout & Constraints
    case "set_auto_layout": return setAutoLayout(input);
    case "set_constraints": return setConstraints(input);

    // Text
    case "set_text_content": return setTextContent(input);
    case "set_text_style": return setTextStyle(input);
    case "set_text_color": return setTextColor(input);
    case "get_all_text": return getAllText();
    case "list_fonts": return listFonts(input);
    case "set_text": return setText(input);
    case "set_text_batch": return { ok: true, status: "handled-by-queue" };

    // Components / booleans
    case "create_component": return createComponent(input);
    case "create_instance": return createInstance(input);
    case "detach_instance": return detachInstance(input);
    case "boolean_op": return booleanOp(input);

    // Export / data / generic
    case "export_node": return exportNode(input);
    case "set_plugin_data": return setPluginData(input);
    case "get_plugin_data": return getPluginData(input);
    case "set_properties": return setProperties(input);

    default:
      throw new Error("Unknown action: " + action);
  }
}

// ---------- Create ----------
function createFrame({ name = "Frame", width = 800, height = 600, x = 0, y = 0 }) {
  const f = figma.createFrame();
  f.name = name; f.resize(width, height); f.x = x; f.y = y;
  page().appendChild(f);
  return { nodeId: f.id, type: f.type, name: f.name, width, height };
}
function createRectangle({ width, height, x = 0, y = 0, cornerRadius, hex }) {
  const r = figma.createRectangle(); r.resize(width, height);
  if (typeof cornerRadius === "number") r.cornerRadius = cornerRadius;
  if (hex) r.fills = [{ type: "SOLID", color: hexToRGB(hex) }];
  r.x = x; r.y = y; page().appendChild(r);
  return { nodeId: r.id, type: r.type };
}
function createEllipse({ width, height, x = 0, y = 0, hex }) {
  const e = figma.createEllipse(); e.resize(width, height);
  if (hex) e.fills = [{ type: "SOLID", color: hexToRGB(hex) }];
  e.x = x; e.y = y; page().appendChild(e);
  return { nodeId: e.id, type: e.type };
}
function createLine({ x = 0, y = 0, length, rotation = 0, strokeHex = "#111827", strokeWeight = 1 }) {
  const l = figma.createLine();
  l.x = x; l.y = y; l.rotation = rotation;
  l.strokes = [{ type: "SOLID", color: hexToRGB(strokeHex) }];
  l.strokeWeight = strokeWeight;
  // Figma line length controlled via vector network — easiest: resize in x.
  l.resize(length, 0);
  page().appendChild(l);
  return { nodeId: l.id, type: l.type };
}
function createPolygon({ sides, width, height, x = 0, y = 0, hex }) {
  const p = figma.createPolygon(); p.pointCount = sides; p.resize(width, height);
  if (hex) p.fills = [{ type: "SOLID", color: hexToRGB(hex) }];
  p.x = x; p.y = y; page().appendChild(p);
  return { nodeId: p.id, type: p.type };
}
function createStar({ points, width, height, x = 0, y = 0, hex }) {
  const s = figma.createStar(); s.pointCount = points; s.resize(width, height);
  if (hex) s.fills = [{ type: "SOLID", color: hexToRGB(hex) }];
  s.x = x; s.y = y; page().appendChild(s);
  return { nodeId: s.id, type: s.type };
}
async function addText({ text, x = 0, y = 0, fontFamily = "Inter", fontStyle = "Regular", fontSize = 32 }) {
  await loadFont(fontFamily, fontStyle);
  const t = figma.createText();
  t.characters = text; t.fontName = { family: fontFamily, style: fontStyle };
  if (fontSize) t.fontSize = fontSize;
  t.x = x; t.y = y; page().appendChild(t);
  return { nodeId: t.id, type: t.type, text: t.characters };
}
function placeImageBase64({ width, height, x = 0, y = 0, base64 }) {
  const bytes = base64ToUint8Array(base64);
  const image = figma.createImage(bytes);
  const r = figma.createRectangle(); r.resize(width, height); r.x = x; r.y = y;
  r.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  page().appendChild(r);
  return { nodeId: r.id, type: r.type };
}

// ---------- Selection / find / pages ----------
function findNodes({ type, nameContains, within }) {
  let scope = within ? getNode(within) : page();
  if (!("findAll" in scope)) throw new Error("Invalid 'within' scope");
  const nodes = scope.findAll(n => {
    const typeOk = type ? n.type === type : true;
    const nameOk = nameContains ? (("name" in n) && String(n.name).toLowerCase().includes(nameContains.toLowerCase())) : true;
    return typeOk && nameOk;
  });
  return nodes.map(n => ({ id: n.id, type: n.type, name: "name" in n ? n.name : undefined }));
}
function selectNodes({ nodeIds }) {
  const nodes = nodeIds.map(getNode).filter(n => !!n);
  figma.currentPage.selection = nodes;
  return { selected: nodes.map(n => n.id) };
}
function getSelection() {
  return figma.currentPage.selection.map(n => ({ id: n.id, type: n.type, name: "name" in n ? n.name : undefined }));
}
function createPage({ name = "Page", makeCurrent = true }) {
  const p = figma.createPage(); p.name = name;
  if (makeCurrent) figma.currentPage = p;
  return { pageId: p.id, name: p.name };
}
function setCurrentPage({ pageId }) {
  const p = getNode(pageId);
  if (p.type !== "PAGE") throw new Error("Not a page");
  figma.currentPage = p;
  return { pageId: p.id };
}

// ---------- Node management ----------
function renameNode({ nodeId, name }) { const n = getNode(nodeId); if ("name" in n) n.name = name; return { nodeId }; }
function deleteNode({ nodeId }) { const n = getNode(nodeId); n.remove(); return { removed: nodeId }; }
function duplicateNode({ nodeId, x, y }) {
  const n = getNode(nodeId); const copy = n.clone();
  if (typeof x === "number") copy.x = x;
  if (typeof y === "number") copy.y = y;
  n.parent && n.parent.appendChild(copy);
  return { nodeId: copy.id };
}
function resizeNode({ nodeId, width, height }) { const n = getNode(nodeId); if (!("resize" in n)) throw new Error("Node cannot be resized"); n.resize(width, height); return { nodeId }; }
function rotateNode({ nodeId, rotation }) { const n = getNode(nodeId); if (!("rotation" in n)) throw new Error("No rotation on node"); n.rotation = rotation; return { nodeId }; }
function setPosition({ nodeId, x, y }) { const n = getNode(nodeId); if (!("x" in n && "y" in n)) throw new Error("Node not positionable"); n.x = x; n.y = y; return { nodeId }; }
function groupNodes({ nodeIds, name = "Group" }) {
  const nodes = nodeIds.map(getNode).filter(n => !!n && "visible" in n);
  if (nodes.length < 2) throw new Error("Need 2+ nodes");
  const parent = nodes[0].parent || page();
  const g = figma.group(nodes, parent); g.name = name; return { nodeId: g.id, type: g.type };
}
function ungroup({ groupId }) {
  const g = getNode(groupId);
  if (g.type !== "GROUP") throw new Error("Not a group");
  const parent = g.parent || page();
  const children = [];
  for (let i = 0; i < g.children.length; i++) children.push(g.children[i]);
  for (const c of children) parent.appendChild(c);
  g.remove();
  return { released: children.map(c => c.id) };
}

// ---------- Styling ----------
function setFill({ nodeId, hex, opacity }) {
  const n = getNode(nodeId); assertFills(n);
  const fill = { type: "SOLID", color: hexToRGB(hex) };
  if (typeof opacity === "number") fill.opacity = Math.max(0, Math.min(1, opacity));
  n.fills = [fill];
  return { nodeId };
}
function setStroke({ nodeId, hex, opacity, strokeWeight, strokeAlign, dashPattern, cap, join }) {
  const n = getNode(nodeId);
  if (!("strokes" in n)) throw new Error("Node does not support strokes");
  const s = { type: "SOLID", color: hexToRGB(hex) };
  if (typeof opacity === "number") s.opacity = Math.max(0, Math.min(1, opacity));
  n.strokes = [s];
  if (strokeWeight != null) n.strokeWeight = strokeWeight;
  if (strokeAlign) n.strokeAlign = strokeAlign;
  if (dashPattern) n.dashPattern = dashPattern;
  if (cap) n.strokeCap = cap;
  if (join) n.strokeJoin = join;
  return { nodeId };
}
function setCornerRadius({ nodeId, radius, topLeft, topRight, bottomRight, bottomLeft }) {
  const n = getNode(nodeId);
  if ("cornerRadius" in n && typeof radius === "number") n.cornerRadius = radius;
  if ("topLeftRadius" in n) {
    if (typeof topLeft === "number") n.topLeftRadius = topLeft;
    if (typeof topRight === "number") n.topRightRadius = topRight;
    if (typeof bottomRight === "number") n.bottomRightRadius = bottomRight;
    if (typeof bottomLeft === "number") n.bottomLeftRadius = bottomLeft;
  }
  return { nodeId };
}
function setOpacity({ nodeId, opacity }) { const n = getNode(nodeId); if (!("opacity" in n)) throw new Error("No opacity on node"); n.opacity = Math.max(0, Math.min(1, opacity)); return { nodeId }; }
function setBlendMode({ nodeId, mode }) { const n = getNode(nodeId); if (!("blendMode" in n)) throw new Error("No blend mode"); n.blendMode = mode; return { nodeId }; }
function addEffect({ nodeId, type, radius = 8, spread = 0, hex = "#000000", opacity = 0.25, offsetX = 0, offsetY = 2 }) {
  const n = getNode(nodeId);
  if (!("effects" in n)) throw new Error("Node does not support effects");
  const newEff = (() => {
    if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") return { type, radius };
    const rgb = hexToRGB(hex);
    const color = { r: rgb.r, g: rgb.g, b: rgb.b, a: opacity };
    return { type, radius, spread, color, offset: { x: offsetX, y: offsetY } };
  })();
  const currentEffects = [];
  for (let i = 0; i < n.effects.length; i++) currentEffects.push(n.effects[i]);
  currentEffects.push(newEff);
  n.effects = currentEffects;
  return { nodeId, effects: n.effects.length };
}
function clearEffects({ nodeId }) { const n = getNode(nodeId); if (!("effects" in n)) throw new Error("Node does not support effects"); n.effects = []; return { nodeId }; }
function layoutGridAdd({ nodeId, pattern = "COLUMNS", count = 12, gutterSize = 20, sectionSize = 80, hex = "#E5E7EB", opacity = 0.5 }) {
  const n = getNode(nodeId);
  if (!("layoutGrids" in n)) throw new Error("Node does not support layoutGrids");
  const rgb = hexToRGB(hex);
  const g = { pattern, count, gutterSize, sectionSize, color: { r: rgb.r, g: rgb.g, b: rgb.b, a: opacity } };
  const currentGrids = [];
  for (let i = 0; i < n.layoutGrids.length; i++) currentGrids.push(n.layoutGrids[i]);
  currentGrids.push(g);
  n.layoutGrids = currentGrids;
  return { nodeId, grids: n.layoutGrids.length };
}
function layoutGridClear({ nodeId }) { const n = getNode(nodeId); if (!("layoutGrids" in n)) throw new Error("Node does not support layoutGrids"); n.layoutGrids = []; return { nodeId }; }

// ---------- Auto Layout & Constraints ----------
function setAutoLayout(input) {
  const nodeId = input.nodeId;
  const props = Object.assign({}, input);
  delete props.nodeId;
  const f = getNode(nodeId);
  if (f.type !== "FRAME") throw new Error("Auto Layout only on frames");
  const map = {
    layoutMode: "layoutMode",
    primaryAxisSizingMode: "primaryAxisSizingMode",
    counterAxisSizingMode: "counterAxisSizingMode",
    itemSpacing: "itemSpacing",
    paddingTop: "paddingTop",
    paddingRight: "paddingRight",
    paddingBottom: "paddingBottom",
    paddingLeft: "paddingLeft",
    primaryAxisAlignItems: "primaryAxisAlignItems",
    counterAxisAlignItems: "counterAxisAlignItems",
    layoutWrap: "layoutWrap",
    counterAxisSpacing: "counterAxisSpacing",
    layoutPositioning: "layoutPositioning"
  };
  for (const k in map) if (k in props) f[map[k]] = props[k];
  return { nodeId: f.id };
}
function setConstraints({ nodeId, horizontal, vertical }) {
  const n = getNode(nodeId);
  if (!("constraints" in n)) throw new Error("No constraints on node");
  n.constraints = {
    horizontal: horizontal || n.constraints.horizontal,
    vertical: vertical || n.constraints.vertical
  };
  return { nodeId };
}

// ---------- Text ----------
async function setTextContent({ nodeId, text }) {
  const t = getNode(nodeId);
  if (t.type !== "TEXT") throw new Error("Not a text node");
  const font = t.fontName;
  if (font && typeof font !== "symbol") { try { await loadFont(font.family, font.style); } catch (e) { /* ignore */ } }
  t.characters = text;
  return { nodeId };
}
async function setTextStyle({ nodeId, fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, textAlignHorizontal, textAutoResize }) {
  const t = getNode(nodeId);
  if (t.type !== "TEXT") throw new Error("Not a text node");
  const fam = fontFamily || (typeof t.fontName !== "symbol" ? t.fontName.family : "Inter");
  const sty = fontStyle || (typeof t.fontName !== "symbol" ? t.fontName.style : "Regular");
  await loadFont(fam, sty);
  t.fontName = { family: fam, style: sty };
  if (fontSize != null) t.fontSize = fontSize;
  if (lineHeight != null) t.lineHeight = { unit: "PIXELS", value: lineHeight };
  if (letterSpacing != null) t.letterSpacing = { unit: "PIXELS", value: letterSpacing };
  if (textAlignHorizontal) t.textAlignHorizontal = textAlignHorizontal;
  if (textAutoResize) t.textAutoResize = textAutoResize;
  return { nodeId };
}
function setTextColor({ nodeId, hex, opacity }) {
  const t = getNode(nodeId);
  if (t.type !== "TEXT") throw new Error("Not a text node");
  const fill = { type: "SOLID", color: hexToRGB(hex) };
  if (typeof opacity === "number") fill.opacity = Math.max(0, Math.min(1, opacity));
  t.fills = [fill];
  return { nodeId };
}

// Return all font families available in the current Figma file/team, so the
// agent can pick an Arabic-capable font for RTL pages (MiSans VF has no Arabic
// glyphs). Deduplicates family names and flags families that look Arabic.
async function listFonts() {
  const all = await figma.listAvailableFontsAsync();
  const families = new Set();
  for (const f of all) {
    if (f && f.fontName && f.fontName.family) families.add(f.fontName.family);
  }
  const list = Array.from(families).sort();
  // crude Arabic heuristic: families whose name mentions arabic / an arabic-
  // script word in common arabic webfont names.
  const arabicHints = /arabic|arab|tajawal|cairo|almarai|noto|ibm plex|amiri|el messiri|lateef|reem|harmattan|mada|scheherazade|gula|khebr|droid|vazir|sahel|baloo|lemonada|markazi|qahiri|rakk|frank|janna/i;
  const arabicFonts = list.filter((f) => arabicHints.test(f));
  return { total: list.length, families: list, arabicFonts };
}

// Read ALL text nodes across the whole document (every page/frame),
// returning content + current style so the agent can translate & rewrite.
function getAllText() {
  const out = [];
  for (const page of figma.root.children) {
    if (page.type !== "PAGE") continue;
    const texts = page.findAll((n) => n.type === "TEXT");
    for (const t of texts) {
      let fontFamily = null, fontStyle = null, fontSize = null, textAlignHorizontal = null;
      const fn = t.fontName;
      if (fn && typeof fn !== "symbol") { fontFamily = fn.family; fontStyle = fn.style; }
      if (typeof t.fontSize === "number") fontSize = t.fontSize;
      if (t.textAlignHorizontal) textAlignHorizontal = t.textAlignHorizontal;
      let color = null;
      try {
        const fills = Array.isArray(t.fills) ? t.fills : [];
        const fill = fills.find((f) => f.type === "SOLID");
        if (fill && fill.color) color = rgbToHex(fill.color);
      } catch (e) { /* ignore */ }
      out.push({
        pageId: page.id,
        pageName: page.name,
        nodeId: t.id,
        name: t.name,
        characters: t.characters,
        fontFamily, fontStyle, fontSize, textAlignHorizontal, color
      });
    }
  }
  return { count: out.length, nodes: out };
}

// Write translated text + font to a node. Everything else (color, alignment,
// position, auto-resize, line height) is preserved. Font applied only if it
// exists in the file; otherwise text is still written and fontApplied=false.
async function setText({ nodeId, text, fontFamily, fontStyle, fontSize, textAlignHorizontal }) {
  const t = getNode(nodeId);
  if (t.type !== "TEXT") throw new Error("Not a text node");
  const cur = t.fontName;
  if (cur && typeof cur !== "symbol") { try { await loadFont(cur.family, cur.style); } catch (e) { /* ignore */ } }
  t.characters = text;
  let fontApplied = true, fontError = null;
  const fam = fontFamily || (typeof t.fontName !== "symbol" ? t.fontName.family : "Inter");
  const sty = fontStyle || (typeof t.fontName !== "symbol" ? t.fontName.style : "Regular");
  try {
    await loadFont(fam, sty);
    t.fontName = { family: fam, style: sty };
  } catch (e) {
    fontApplied = false;
    fontError = String((e && e.message) ? e.message : e);
  }
  if (fontSize != null) t.fontSize = fontSize;
  if (textAlignHorizontal) {
    try { t.textAlignHorizontal = textAlignHorizontal; } catch (e) { /* ignore alignment errors */ }
  }
  return {
    nodeId,
    fontApplied,
    fontError,
    currentFont: typeof t.fontName !== "symbol" ? t.fontName : null
  };
}

// Batch variant of setText, drained serially by batchWorker. Font loads are
// cached so a font used by hundreds of nodes is loaded only once. Font is
// applied only if it loads in the file; otherwise the original font is kept.
async function processBatch(items) {
  const applied = [];
  const fontFailed = [];
  const notFound = [];
  const errors = [];
  const list = Array.isArray(items) ? items : [];
  for (const it of list) {
    try {
      const t = getNode(it.nodeId);
      if (!t || t.type !== "TEXT") { notFound.push(it.nodeId); continue; }
      const cur = t.fontName;
      if (cur && typeof cur !== "symbol") { try { await loadFont(cur.family, cur.style); } catch (e) { /* ignore */ } }
      t.characters = it.text;
      let fontApplied = true;
      const fam = it.fontFamily || (typeof t.fontName !== "symbol" ? t.fontName.family : "Inter");
      const sty = it.fontStyle || (typeof t.fontName !== "symbol" ? t.fontName.style : "Regular");
      try {
        await loadFont(fam, sty);
        t.fontName = { family: fam, style: sty };
      } catch (e) {
        fontApplied = false;
      }
      if (it.fontSize != null) t.fontSize = it.fontSize;
      if (it.textAlignHorizontal) {
        try { t.textAlignHorizontal = it.textAlignHorizontal; } catch (e) { /* ignore */ }
      }
      applied.push(it.nodeId);
      if (!fontApplied) fontFailed.push(it.nodeId);
    } catch (e) {
      errors.push({ nodeId: it.nodeId, error: String((e && e.message) ? e.message : e) });
    }
  }
  // Posted for visibility; the bridge may ignore it (request already acked).
  figma.ui.postMessage({ type: "batch_done", total: list.length, appliedCount: applied.length, fontFailedCount: fontFailed.length, notFoundCount: notFound.length, errorCount: errors.length });
  return {
    total: list.length,
    appliedCount: applied.length,
    fontFailedCount: fontFailed.length,
    notFoundCount: notFound.length,
    errorCount: errors.length,
    fontFailed,
    notFound,
    errors
  };
}

// ---------- Components & Boolean ----------
function createComponent({ name = "Component", fromNodeIds }) {
  const c = figma.createComponent(); c.name = name;
  page().appendChild(c);
  if (Array.isArray(fromNodeIds) && fromNodeIds.length) {
    const nodes = fromNodeIds.map(getNode);
    for (const n of nodes) c.appendChild(n);
  }
  return { nodeId: c.id, type: c.type };
}
function createInstance({ componentId, x = 0, y = 0 }) {
  const c = getNode(componentId);
  if (c.type !== "COMPONENT") throw new Error("Not a component");
  const inst = c.createInstance(); inst.x = x; inst.y = y; page().appendChild(inst);
  return { nodeId: inst.id, type: inst.type };
}
function detachInstance({ nodeId }) {
  const n = getNode(nodeId);
  if ("detachInstance" in n) {
    const d = n.detachInstance();
    return { nodeId: d.id, type: d.type };
  }
  throw new Error("Node is not an instance");
}
function booleanOp({ op, nodeIds, name = "Boolean" }) {
  const nodes = nodeIds.map(getNode);
  const parent = nodes[0].parent || page();
  let res;
  switch (op) {
    case "UNION": res = figma.union(nodes, parent); break;
    case "SUBTRACT": res = figma.subtract(nodes, parent); break;
    case "INTERSECT": res = figma.intersect(nodes, parent); break;
    case "EXCLUDE": res = figma.exclude(nodes, parent); break;
  }
  res.name = name;
  return { nodeId: res.id, type: res.type };
}

// ---------- Export / plugin data / generic ----------
async function exportNode({ nodeId, format = "PNG", scale = 1 }) {
  const n = getNode(nodeId);
  const bytes = await n.exportAsync({ format, constraint: { type: "SCALE", value: scale } });
  // encode base64
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return { format, base64 };
}
function setPluginData({ nodeId, key, value }) {
  const n = getNode(nodeId);
  n.setPluginData(key, JSON.stringify(value));
  return { nodeId };
}
function getPluginData({ nodeId, key }) {
  const n = getNode(nodeId);
  const raw = n.getPluginData(key);
  try { 
    return { value: JSON.parse(raw) }; 
  } catch (e) { 
    return { value: raw }; 
  }
}
function setProperties({ nodeId, props }) {
  const n = getNode(nodeId);
  // Whitelisted scalar props (expand as needed)
  const allowed = [
    "x","y","rotation","opacity","visible","locked",
    "layoutAlign","layoutGrow",
    "fills","strokes","strokeWeight","strokeAlign","dashPattern","blendMode",
    "itemSpacing","paddingTop","paddingRight","paddingBottom","paddingLeft",
    "primaryAxisAlignItems","counterAxisAlignItems","layoutMode",
    "primaryAxisSizingMode","counterAxisSizingMode","layoutWrap","counterAxisSpacing",
    "textAlignHorizontal","textAlignVertical"
  ];
  for (const k of Object.keys(props || {})) {
    if (allowed.includes(k)) {
      try { n[k] = props[k]; } catch (_) {}
    }
  }
  return { nodeId };
}
