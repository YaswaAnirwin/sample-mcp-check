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
/* ---------------------------------------------------------
   Minimal JSON-RPC MCP client
--------------------------------------------------------- */
class MCPClient {
    constructor(command, args) {
        this.command = command;
        this.args = args;
        this.proc = null;
        this.msgId = 1;
        this.pending = new Map();
        this.buffer = ""; // <- CRITICAL FIX
    }
    start(out) {
        this.proc = (0, child_process_1.spawn)(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"],
        });
        /* ---------------------------------------------------------
           FIXED JSON PARSER
           Reads stdout line-by-line so JSON never breaks
        --------------------------------------------------------- */
        this.proc.stdout.on("data", (data) => {
            this.buffer += data.toString();
            let idx;
            while ((idx = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, idx).trim();
                this.buffer = this.buffer.slice(idx + 1);
                if (!line)
                    continue;
                out.appendLine("[MCP STDOUT] " + line);
                try {
                    const obj = JSON.parse(line);
                    if (obj.id && this.pending.has(obj.id)) {
                        this.pending.get(obj.id)?.(obj);
                        this.pending.delete(obj.id);
                    }
                }
                catch {
                    // ignore non-JSON lines
                }
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
            const req = { jsonrpc: "2.0", id, method, params };
            this.proc?.stdin.write(JSON.stringify(req) + "\n");
            this.pending.set(id, (resp) => resolve(resp.result));
        });
    }
}
/* ---------------------------------------------------------
   VS Code Extension Activation
--------------------------------------------------------- */
function activate(context) {
    const out = vscode.window.createOutputChannel("Snap MCP Debug");
    out.show(true);
    const mcpPath = "C:/Users/DuddeYaswaAnirwin/snap-mcp-plugin/mcp/instructions-remote-mcp.mjs";
    const client = new MCPClient("node", [mcpPath]);
    client.start(out);
    // Initialize MCP
    (async () => {
        out.appendLine("➡️ Sending initialize...");
        await client.send("initialize", {});
        await client.send("initialized", {});
        const tools = await client.send("tools/list", {});
        out.appendLine("🧰 Tools discovered:");
        for (const t of tools.tools)
            out.appendLine(" - " + t.name);
    })();
    /* ---------------------------------------------------------
       VS Code Chat Participant
    --------------------------------------------------------- */
    const participant = vscode.chat.createChatParticipant("snap", async (req, ctx, response) => {
        response.markdown("⏳ Loading instructions...");
        const userPrompt = req.prompt.toLowerCase();
        /* ---------------------------------------------------------
           Tool listing for debugging
        --------------------------------------------------------- */
        if (userPrompt.includes("list tools") || userPrompt.includes("show tools")) {
            const tools = await client.send("tools/list", {});
            response.markdown("### 🧰 Available Tools:");
            response.markdown(tools.tools.map((t) => "- " + t.name).join("\n"));
            return;
        }
        /* ---------------------------------------------------------
           Detect specific instruction tool
        --------------------------------------------------------- */
        let specificToolName = "";
        if (userPrompt.includes("figma")) {
            specificToolName = "getFigmaInstructions";
        }
        else if (userPrompt.includes("azure") ||
            userPrompt.includes("dev.azure.com") ||
            userPrompt.includes("pbi")) {
            specificToolName = "getAzureDevOpsInstructions";
        }
        else if (userPrompt.includes("ui") ||
            userPrompt.includes("saffron") ||
            userPrompt.includes("react")) {
            specificToolName = "getUIComponentInstructions";
        }
        out.appendLine(`[DEBUG] Detected tool: ${specificToolName || "none"}`);
        /* ---------------------------------------------------------
           Load auto-detected instructions
        --------------------------------------------------------- */
        out.appendLine("[DEBUG] Calling detectAndLoadInstructions...");
        const detect = await client.send("tools/call", {
            name: "detectAndLoadInstructions",
            arguments: { query: req.prompt },
        });
        /* ---------------------------------------------------------
           Load specific instructions if required
        --------------------------------------------------------- */
        let specificInstructions = null;
        if (specificToolName) {
            out.appendLine(`[DEBUG] Calling ${specificToolName}...`);
            specificInstructions = await client.send("tools/call", {
                name: specificToolName,
                arguments: {},
            });
        }
        /* ---------------------------------------------------------
           Show visible messages (file list)
        --------------------------------------------------------- */
        const visible = detect?.content?.find((c) => c.type === "text");
        if (visible)
            response.markdown(visible.text);
        const specificVisible = specificInstructions?.content?.find((c) => c.type === "text");
        if (specificVisible)
            response.markdown(specificVisible.text);
        /* ---------------------------------------------------------
           Extract HIDDEN instruction content (CRITICAL FIX)
        --------------------------------------------------------- */
        const hiddenDetect = detect?.content?.filter((c) => c.type === "copilot_context") || [];
        const hiddenSpecific = specificInstructions?.content?.filter((c) => c.type === "copilot_context") || [];
        const allHiddenInstructions = [...hiddenDetect, ...hiddenSpecific];
        let combinedInstructions = "";
        for (const instr of allHiddenInstructions) {
            if (instr.type === "copilot_context" && instr.data) {
                combinedInstructions += instr.data + "\n\n"; // FIXED
            }
        }
        /* ---------------------------------------------------------
           Combine instructions + user request
        --------------------------------------------------------- */
        const MAX_CHARS = 20000;
        const safeCombined = combinedInstructions.length > MAX_CHARS
            ? combinedInstructions.slice(0, MAX_CHARS) + "\n\n[...truncated...]"
            : combinedInstructions;
        const finalPrompt = safeCombined
            ? `${safeCombined}\n\nUser Request: ${req.prompt}`
            : req.prompt;
        /* ---------------------------------------------------------
           Select Language Model (stabilized 10s timeout)
        --------------------------------------------------------- */
        const selectWithTimeout = (selector, timeoutMs) => Promise.race([
            vscode.lm.selectChatModels(selector),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Model selection timed out")), timeoutMs)),
        ]);
        let models = [];
        try {
            models = await selectWithTimeout({ family: "gpt-4o" }, 10000);
        }
        catch {
            models = await selectWithTimeout({}, 10000).catch(() => []);
        }
        if (models.length === 0) {
            response.markdown("\n⚠️ No language model available.");
            return;
        }
        /* ---------------------------------------------------------
           Send final prompt to language model
        --------------------------------------------------------- */
        const model = models[0];
        response.markdown("\n---\n### 🤖 Generated Response:\n\n");
        const tokenSrc = new vscode.CancellationTokenSource();
        const timeout = setTimeout(() => {
            tokenSrc.cancel();
        }, 60000);
        try {
            const messages = [
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, finalPrompt),
            ];
            const chatResponse = await model.sendRequest(messages, {}, tokenSrc.token);
            for await (const fragment of chatResponse.text) {
                response.markdown(fragment);
            }
        }
        catch (err) {
            response.markdown(`\n❌ Error: ${err?.message || String(err)}`);
        }
        finally {
            clearTimeout(timeout);
        }
    });
    context.subscriptions.push(participant);
}
function deactivate() { }
