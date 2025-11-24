"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
/**
 * Minimal MCP client for VS Code extension
 */
class MCPClient {
    constructor(command, args) {
        this.command = command;
        this.args = args;
        this.proc = null;
        this.msgId = 1;
        this.pending = new Map();
    }
    start(out) {
        this.proc = (0, child_process_1.spawn)(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc.stdout.on("data", (data) => {
            const text = data.toString();
            out.appendLine("[MCP STDOUT] " + text);
            // Parse JSON RPC safely
            try {
                const obj = JSON.parse(text);
                if (obj.id && this.pending.has(obj.id)) {
                    this.pending.get(obj.id)?.(obj);
                    this.pending.delete(obj.id);
                }
            }
            catch {
                // ignore non-JSON output
            }
        });
        this.proc.stderr.on("data", (data) => {
            out.appendLine("[MCP ERROR] " + data.toString());
        });
        this.proc.on("close", (code) => {
            out.appendLine(`[MCP] exited with code ${code}`);
        });
    }
    send(method, params = {}) {
        return new Promise((resolve) => {
            const id = this.msgId++;
            const req = {
                jsonrpc: "2.0",
                id,
                method,
                params,
            };
            const json = JSON.stringify(req);
            this.proc?.stdin.write(json + "\n");
            this.pending.set(id, (resp) => {
                resolve(resp.result);
            });
        });
    }
}
/**
 * VS Code Extension Activation
 */
function activate(context) {
    const out = vscode.window.createOutputChannel("Snap MCP Debug");
    out.show(true);
    const mcpPath = "C:/Users/DuddeYaswaAnirwin/snap-mcp-plugin/mcp/instructions-remote-mcp.mjs";
    const client = new MCPClient("node", [mcpPath]);
    client.start(out);
    // === Send initialize sequence ===
    (async () => {
        out.appendLine("➡️ Sending initialize...");
        await client.send("initialize", {});
        await client.send("initialized", {});
        const tools = await client.send("tools/list", {});
        out.appendLine("🧰 Tools discovered:");
        for (const t of tools.tools)
            out.appendLine(" - " + t.name);
    })();
    /**
     * Chat participant: @snap
     */
    const participant = vscode.chat.createChatParticipant("snap", async (req, ctx, res) => {
        const text = req.prompt.toLowerCase();
        if (text.includes("list tools")) {
            const tools = await client.send("tools/list", {});
            res.markdown("### 🧰 Available Tools:");
            res.markdown(tools.tools.map((t) => "- " + t.name).join("\n"));
            return;
        }
        if (text.includes("figma")) {
            const outText = await client.send("tools/call", {
                name: "getFigmaInstructions",
                arguments: {},
            });
            res.markdown("### 🎨 Figma Instructions\n" + outText.content[0].text);
            return;
        }
        if (text.includes("azure") || text.includes("pbi")) {
            const outText = await client.send("tools/call", {
                name: "getAzureDevOpsInstructions",
                arguments: {},
            });
            res.markdown("### 🔷 Azure DevOps Instructions\n" + outText.content[0].text);
            return;
        }
        if (text.includes("ui")) {
            const outText = await client.send("tools/call", {
                name: "getUIComponentInstructions",
                arguments: {},
            });
            res.markdown("### 🧩 UI Instructions\n" + outText.content[0].text);
            return;
        }
        res.markdown("I can run MCP tools. Try:\n- list tools\n- figma link\n- azure pbi\n- load ui instructions");
    });
    context.subscriptions.push(participant);
}
function deactivate() { }
