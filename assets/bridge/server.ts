import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";

// --- WebSocket bridge to the Figma plugin UI ---
const PORT = 3055;
const HOST = "127.0.0.1";

const wss = new WebSocketServer({ host: HOST, port: PORT });
let pluginClient: WebSocket | null = null;

type Pending = {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
};
const pending = new Map<string, Pending>();

function makeId() {
  return Math.random().toString(36).slice(2);
}

function sendToPlugin(action: string, args: unknown, timeoutMs: number = 15000): Promise<any> {
  if (!pluginClient || pluginClient.readyState !== WebSocket.OPEN) {
    throw new Error(
      "Figma plugin not connected. Open Figma → Plugins → Development → <bridge plugin name>."
    );
  }
  const id = makeId();
  const payload = JSON.stringify({ id, action, args });
  pluginClient.send(payload);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Plugin timeout waiting for "${action}" response.`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timeout });
  });
}

wss.on("connection", (ws) => {
  pluginClient = ws;
  console.error(`[bridge] Plugin connected from ${ws.url ?? "ui.html"}`);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { replyTo, result, error } = msg;
      if (!replyTo) return;

      const p = pending.get(replyTo);
      if (!p) return;

      clearTimeout(p.timeout);
      pending.delete(replyTo);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    } catch (e) {
      console.error("[bridge] Bad message from plugin:", e);
    }
  });

  ws.on("close", () => {
    console.error("[bridge] Plugin disconnected");
    pluginClient = null;
  });
});

console.error(`[bridge] Waiting for plugin on ws://${HOST}:${PORT}`);

// --- MCP server with tools that forward to the plugin ---
const server = new McpServer({
  name: "figma-write-bridge",
  version: "1.0.0"
});

function registerTool<T extends z.ZodTypeAny>(
  name: string,
  schema: T,
  description: string,
  action: string,
  timeoutMs: number = 15000
) {
  const inputSchema =
    schema && typeof schema === "object" && "shape" in schema && (schema as any).shape
      ? (schema as any).shape
      : schema;
  server.registerTool(
    name,
    { title: name, description, inputSchema: inputSchema as any },
    async (input: z.infer<T>, _extra: any) => {
      const result = await sendToPlugin(action, input, timeoutMs);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    }
  );
}

// --- Text read/write tools (the ones the translation skill needs) ---
registerTool(
  "get_all_text",
  z.object({}),
  "Return ALL text nodes in the whole document (every page/frame) with nodeId, page, current characters, font family/style/size, alignment and color. Use this first to read everything that needs translating.",
  "get_all_text"
);

registerTool(
  "set_text",
  z.object({
    nodeId: z.string(),
    text: z.string(),
    fontFamily: z.string().optional(),
    fontStyle: z.string().optional(),
    fontSize: z.number().optional(),
    textAlignHorizontal: z.enum(["LEFT", "RIGHT", "CENTER", "JUSTIFIED"]).optional()
  }),
  "Write translated text into a text node and optionally change its font or alignment (preserves color/position/layout/auto-resize). textAlignHorizontal supports RTL flipping (LEFT<->RIGHT). Returns whether the requested font was actually applied in the file.",
  "set_text"
);

{
  const itemShape = z.object({
    nodeId: z.string(),
    text: z.string(),
    fontFamily: z.string().optional(),
    fontStyle: z.string().optional(),
    fontSize: z.number().optional(),
    textAlignHorizontal: z.enum(["LEFT", "RIGHT", "CENTER", "JUSTIFIED"]).optional()
  });
  server.registerTool(
    "set_text_batch_file",
    {
      title: "set_text_batch_file",
      description:
        "Apply many text + font updates from a JSON file (absolute path). The file must contain a JSON array of {nodeId, text, fontFamily?, fontStyle?, fontSize?, textAlignHorizontal?}. Preserves color/alignment/position/layout. Returns per-node counts: applied/fontFailed/notFound/errors.",
      inputSchema: { itemsFile: z.string() }
    },
    async (input: any, _extra: any) => {
      const raw = fs.readFileSync(input.itemsFile, "utf8");
      const args = { items: JSON.parse(raw) };
      const result = await sendToPlugin("set_text_batch", args, 600000);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    }
  );
}

registerTool(
  "list_fonts",
  z.object({}),
  "Return all font families available in the current Figma file/team (via figma.listAvailableFontsAsync). Use this to find a script-capable font (Arabic/Cyrillic/CJK) before translating a page.",
  "list_fonts"
);

// Generic post-write verification: re-scan, filter to one page, write nodes to
// a local JSON file, return a compact summary. Source chars that should be gone
// are passed via `sourcePatterns` (array of regex strings, e.g. for French).
{
  server.registerTool(
    "verify_page",
    {
      title: "verify_page",
      description:
        "After writing a translation, re-scan the document, filter to `pageName`, write the matching nodes to `outFile` (absolute path), and return a summary: residual `sourcePatterns` counts (pass regex strings like ['/[àâäéèêëîïôöûüçÀÂÄÉÈÊËÎÏÔÖÛÜÇ]/','/[Ѐ-ӿ]/'] — one per source-language script you expect to be gone), font-family distribution, and alignment distribution.",
      inputSchema: {
        pageName: z.string(),
        outFile: z.string(),
        sourcePatterns: z.array(z.string()).optional().default([])
      }
    },
    async (input: any, _extra: any) => {
      const all = await sendToPlugin("get_all_text", {}, 120000);
      const nodes: any[] = (all && all.nodes) || [];
      const pageNodes = nodes.filter((n: any) => n.pageName === input.pageName);
      let residualTotal = 0;
      const fontDist: Record<string, number> = {};
      const alignDist: Record<string, number> = {};
      const residualSamples: any[] = [];
      const perPattern: Record<string, number> = {};
      for (const pat of input.sourcePatterns) {
        let re: RegExp;
        try { re = new RegExp(pat, "g"); } catch (e) { perPattern[pat] = -1; continue; }
        let c = 0;
        for (const n of pageNodes) { if (re.test(n.characters || "")) c++; }
        perPattern[pat] = c;
        residualTotal += c;
      }
      for (const n of pageNodes) {
        if (residualTotal > 0 && residualSamples.length < 15) {
          const ch = n.characters || "";
          const hit = input.sourcePatterns.some((p: string) => { try { return new RegExp(p, "g").test(ch); } catch (e) { return false; } });
          if (hit) residualSamples.push({ nodeId: n.nodeId, characters: ch.slice(0, 60) });
        }
        const fam = n.fontFamily || "(null)";
        fontDist[fam] = (fontDist[fam] || 0) + 1;
        const a = n.textAlignHorizontal || "(null)";
        alignDist[a] = (alignDist[a] || 0) + 1;
      }
      const summary = {
        page: input.pageName,
        totalNodes: pageNodes.length,
        residualSourceText: residualTotal,
        perPattern,
        fontDist,
        alignDist,
        residualSamples
      };
      try { fs.writeFileSync(input.outFile, JSON.stringify(pageNodes, null, 1)); } catch (e) { /* ignore */ }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary
      };
    }
  );
}

// Connect via stdio (the client / MCP host spawns this process)
const transport = new StdioServerTransport();
await server.connect(transport);