---
name: figma-page-translate
summary: Connect Figma to an AI agent via a local MCP write-bridge + Figma plugin, scan every text node of a target page, machine-translate to any language, and rewrite into Figma while preserving layout — font family/style/size, alignment (incl. RTL flip LEFT↔RIGHT), color, position, auto-resize. Verification via a re-scan asserting 0 residual source text. Works for any source→target language pair (French→Arabic, Spanish→Turkish, Russian→EN, …).
agent_created: true
---

# Figma Page Auto-Translation (keep layout)

Turn a user's request like "translate this Figma page to Arabic/Hebrew/Turkish/French,
watch the text direction & text-box position" into an end-to-end, write-in-place job.

The hard part is **not translation** — Figma text can only be **written through the
Figma Plugin API** (the REST API is read-only). So the whole skill is built around a
local **write bridge**: an MCP stdio server that talks over WebSocket to a Figma plugin
running inside Figma Desktop.

## What the presenter (the person who runs the agent) must have

1. A working **write bridge + Figma plugin** (this skill ships a ready-to-install copy).
2. A **connected MCP connector** named e.g. `figma-write` (it spawns `server.ts`).
3. The Figma file open in **Figma Desktop** with the bridge plugin running.

If any of these is missing, say so honestly and give one-line setup — do not claim the
page is "done". The user owns final sign-off on visual quality (esp. RTL reflow).

---

## Part A — One-time install (do this once, per machine)

### A1. Install the bridge
The folder `assets/bridge/` contains the full server + plugin. Copy it to a machine the
agent can run Node on, e.g. `~/.workbuddy/figma-bridge/`:

```
npm install        # installs @modelcontextprotocol/sdk, ws, zod, tsx
```

Register it as an MCP server in the agent's MCP config (`~/.workbuddy/mcp.json`):

```json
{
  "mcpServers": {
    "figma-write": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "C:/path/to/figma-bridge/server.ts"]
    }
  }
}
```

Then connect/trust the `figma-write` connector in the connector panel. This spawns
`server.ts`, which listens on `ws://127.0.0.1:3055`.

### A2. Load the Figma plugin

1. Figma Desktop → **Plugins → Development → Import plugin from manifest** →
   pick `assets/bridge/plugin/manifest.json`.
2. The plugin appears under **Development → MCP Figma Write Bridge**. Run it once per
   session (it connects to the bridge over WebSocket).

The bridge tools the agent needs: **`get_all_text`, `set_text`,
`set_text_batch_file`, `verify_page`** (all present in the shipped `server.ts`).

---

## Pipeline (the actual task)

1. **Scan** — call `get_all_text`. It returns every text node in the document with:
   `pageId, pageName, nodeId, characters, fontFamily, fontStyle, fontSize,
   textAlignHorizontal, color`. Write the raw result to a file on disk
   (`scan.json`) so it does not flood the context.

2. **Filter + classify** the target `pageName`'s nodes:
   - **translate**: real sentences / product descriptions / headings.
   - **reserved — keep literal**: model numbers, URLs, emails, phone numbers, pure
     numbers, units (`W`, `mm`, `°`), most `\b[A-Z]{1,4}\d{3}\w` style product codes.
   - **watch for stray nodes** copied from another language page (e.g. a Russian
     company name on the Arabic page). Translate them but flag to the user to confirm.

3. **Dedupe to unique strings** and translate each once (whatever source → whatever
   target). Keep a `{"<exact original>": "<translation>"}` map. Preserve the **exact**
   source string as the key — never a hand-retyped version.

4. **Build** a write-batch (array of `{nodeId, text, fontFamily, fontStyle, fontSize,
   textAlignHorizontal}`):
   - **RTL flip** when target is Arabic/Hebrew/Persian: `LEFT↔RIGHT`; `CENTER` and
     `JUSTIFIED` unchanged. For LTR targets, keep alignment.
   - **Font**: the target script needs a font that contains its glyphs. Call
     `list_fonts` and pick one already available in the file (e.g. `Noto Sans Arabic`
     ships via Figma's Google Fonts). Map the source styles onto the target font's
     styles to preserve hierarchy (Demibold/Semibold → SemiBold 600, Normal → Regular).
   - The `assets/bridge/script/build_batch.mjs` template does all this; edit the CONFIG
     block (PAGE / FONT / translations / reserved / style map).

5. **Write** — `set_text_batch_file` with the absolute path to the batch JSON. The
   plugin queues and drains the writes serially with a font cache, avoiding MCP
   framework request timeouts. It preserves color / position / layout / auto-resize;
   only text + font + alignment change.

6. **Verify** — call `verify_page` with the target page + regexes
   for the source-language scripts, plus `outFile`. Assert: **0 residual source
   characters**, target font applied (no tofu / no fallback to the old font), RTL
   alignment flipped where expected, reserved strings unchanged.

---

## Gotchas (learned the hard way)

- **Key by the EXACT node `characters`.** One stray character (e.g. an extra `35 ` before
  `Série W12NC`) breaks the match and silently leaves that node untranslated. If a node
  won't match, diff `norm(key)` vs `norm(original)` codepoint-by-codepoint.
- **Invisible chars survive a naive `===`.** Strip `U+2028/U+2029/U+200B/U+200C/U+200D/
  U+FEFF` and normalize curly quotes `’‘→'`, `""→"`, `–—→-` before comparing. Build the
  strip regex via `String.fromCodePoint(...)`, not literal control chars in source.
- **`.mjs` must use ESM** (`import fs from 'fs'`). On Windows pass real Windows paths
  (`C:/Users/...`), not Git-Bash `/c/...` (Node mis-resolves it).
- **Font naming must match Figma exactly.** `Noto Sans Arabic`'s SemiBold is `SemiBold`,
  not `Semibold`. A wrong style name makes the font load fail and the node falls back to
  its original font → tofu. Confirm with `set_text` on one probe node per weight and check
  `fontApplied: true` before the bulk write.
- **A font downloaded to the sandbox is invisible to Figma** (LOCALAPPDATA is isolated).
  Prefer a font already available via `list_fonts` / Figma's Google Fonts integration.
- **Be honest about limits.** If the connector is disconnected or the plugin isn't
  running, say so. Never claim "上架/done" until a re-scan proves 0 residuals.

---

## Deliverables for the user

- `translation_table.csv` — source/target pairs with nodeId + font + alignment, for
  human/mother-tongue review.
- `write_batch.json` — the exact items written into Figma.
- After verify: a plain summary (residual counts per script, font family histogram,
  alignment histogram) + named the verify JSON so the user can eyeball the written nodes.