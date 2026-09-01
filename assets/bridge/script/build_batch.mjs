// build_batch.mjs — GENERIC template: merge translation batches + dump -> write-batch JSON + CSV.
// Fill in the CONFIG block below, then run with Node (no deps).
// Outputs:
//   <outDir>/translation_table.csv   (nodeId,pageName,fontFamily,fontStyle,original,target) — for review
//   <outDir>/write_batch.json        (array of {nodeId,text,fontFamily,fontStyle,fontSize,textAlignHorizontal}) — feed to set_text_batch_file
import fs from "fs";

// ============================ CONFIG (EDIT ME) ============================
const DIR = "/abs/path/to/your/workdir/";        // trailing slash
const PAGE = "name_of_target_page";              // e.g. "Français" or "Arabic"
const TARGET_LANG = "ar";                        // used only for filenames/notes
const FONT = "Noto Sans Arabic";                 // real font family already in Figma (see list_fonts)
// Extend this key -> replacement (subset is enough): {"Original text": "Translation"}
const translationFile = __dirname + "/" + "translations.json"; // {"original": "translated"}
// If a node's characters match a reserved regex, it is kept literally (model nos,
// emails, urls, numbers, units).
const RESERVED = /(https?:\/\/[^\s]+|[-+.\d]+\.\d+|\b\d{2,}\b|@\w+\.\w+|[A-Z]{1,4}\s?\d{3}\w|-?\d+%|mm|W$)/i;
const flip = { LEFT: "RIGHT", RIGHT: "LEFT", CENTER: "CENTER", JUSTIFIED: "JUSTIFIED" };
// Map the source page's font styles onto TARGET font styles (preserve hierarchy).
const styleMap = { Regular: "Regular", Normal: "Regular", Medium: "Medium", Demibold: "SemiBold", Semibold: "SemiBold", Bold: "Bold", Light: "Light" };
const mapStyle = (s) => styleMap[s] || "Regular";
// ==========================================================================

// --- normalize: strip zero-width & Unicode line separators, trim, fold spaces ---
const seps = String.fromCodePoint(0x2028, 0x2029, 0x200B, 0x200C, 0x200D, 0xFEFF);
const ZW = new RegExp("[" + seps + "]", "g");
const norm = (s) => (s || "")
  .replace(ZW, " ")
  .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .split(/\r?\n/).map((l) => l.trim()).join(" ")
  .replace(/\s+/g, " ")
  .trim();

const dict = JSON.parse(fs.readFileSync(DIR + "translations.json", "utf8"));
const dictNorm = {};
for (const [k, v] of Object.entries(dict)) dictNorm[norm(k)] = v;
console.log(`Merged dictionary entries: ${Object.keys(dictNorm).length}`);

// Dump produced by get_all_text then filtered server-side, or your own scan.
// Expected shape: { page: "<name>", nodes: [{nodeId, characters, fontFamily, fontStyle, fontSize, align}] }.
const dump = JSON.parse(fs.readFileSync(DIR + "scan.json", "utf8"));
const nodes = Array.isArray(dump.nodes) ? dump.nodes : dump.toTranslate || [];
console.log(`Nodes to translate: ${nodes.length}`);

const rows = [], missing = [];
for (const n of nodes) {
  const key = norm(n.characters ?? n.original ?? "");
  if (RETAINED(key)) { rows.push({ nodeId: n.nodeId, kept: true, reason: "reserved" }); continue; }
  const tr = dictNorm[key];
  if (tr == null) { missing.push(n); continue; }
  rows.push({
    nodeId: n.nodeId, fontFamily: FONT, fontStyle: mapStyle(n.fontStyle),
    fontSize: n.fontSize, alignOriginal: n.align, alignRtl: flip[n.align] || n.align,
    original: n.characters ?? n.original, target: tr
  });
}
console.log(`Translated OK: ${rows.length}   Kept: ${rows.filter((r) => r.kept).length}   Missing: ${missing.length}`);
for (const m of missing) console.log(`MISSING ${m.nodeId}: ${JSON.stringify(norm(m.characters ?? m.original))}`);

const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const csv = ["nodeId,pageName,fontFamily,fontStyle,alignRtl,original,target"].concat(
  rows.filter((r) => !r.kept).map((r) => [r.nodeId, PAGE, r.fontFamily, r.fontStyle, r.alignRtl, esc(r.original), esc(r.target)].join(","))
).join("\n");
fs.writeFileSync(DIR + "translation_table.csv", csv);
const batch = rows.filter((r) => !r.kept).map((r) => ({
  nodeId: r.nodeId, text: r.target, fontFamily: r.fontFamily,
  fontStyle: r.fontStyle, fontSize: r.fontSize, textAlignHorizontal: r.alignRtl
}));
fs.writeFileSync(DIR + "write_batch.json", JSON.stringify(batch, null, 2));
console.log(`Wrote translation_table.csv (${batch.length} rows) and write_batch.json (${batch.length} items, font=${FONT})`);