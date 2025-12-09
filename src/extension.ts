import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

/* ---------------------------------------------------------
   JSON-RPC Types
--------------------------------------------------------- */
interface MCPRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: any;
}

/* ---------------------------------------------------------
   Minimal JSON-RPC MCP client
--------------------------------------------------------- */
class MCPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private msgId = 1;
  private pending: Map<number, (resp: MCPResponse) => void> = new Map();

  private buffer = ""; // <- CRITICAL FIX

  constructor(private command: string, private args: string[]) {}

  start(out: vscode.OutputChannel) {
    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    /* ---------------------------------------------------------
       FIXED JSON PARSER
       Reads stdout line-by-line so JSON never breaks
    --------------------------------------------------------- */
    this.proc.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();

      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);

        if (!line) continue;
        out.appendLine("[MCP STDOUT] " + line);

        try {
          const obj = JSON.parse(line) as MCPResponse;

          if (obj.id && this.pending.has(obj.id)) {
            this.pending.get(obj.id)?.(obj);
            this.pending.delete(obj.id);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    this.proc.stderr.on("data", (data: Buffer) => {
      out.appendLine("[MCP ERROR] " + data.toString());
    });

    this.proc.on("close", (code: number | null) => {
      out.appendLine(`[MCP] exited with code ${code}`);
    });
  }

  send(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve) => {
      const id = this.msgId++;
      const req: MCPRequest = { jsonrpc: "2.0", id, method, params };
      this.proc?.stdin.write(JSON.stringify(req) + "\n");
      this.pending.set(id, (resp: MCPResponse) => resolve(resp.result));
    });
  }
}

/* ---------------------------------------------------------
   VS Code Extension Activation
--------------------------------------------------------- */
export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Snap MCP Debug");
  out.show(true);

  const mcpPath =
    "C:/Users/DuddeYaswaAnirwin/snap-mcp-plugin/mcp/instructions-remote-mcp.mjs";

  const client = new MCPClient("node", [mcpPath]);
  client.start(out);

  // Initialize MCP
  (async () => {
    out.appendLine("➡️ Sending initialize...");
    await client.send("initialize", {});
    await client.send("initialized", {});
    const tools = await client.send("tools/list", {});
    out.appendLine("🧰 Tools discovered:");
    for (const t of tools.tools) out.appendLine(" - " + t.name);
  })();

  /* ---------------------------------------------------------
     VS Code Chat Participant
  --------------------------------------------------------- */
  const participant = vscode.chat.createChatParticipant(
    "snap",
    async (req, ctx, response) => {
      response.markdown("⏳ Loading instructions...");
      const userPrompt = req.prompt.toLowerCase();

      /* ---------------------------------------------------------
         Tool listing for debugging
      --------------------------------------------------------- */
      if (userPrompt.includes("list tools") || userPrompt.includes("show tools")) {
        const tools = await client.send("tools/list", {});
        response.markdown("### 🧰 Available Tools:");
        response.markdown(tools.tools.map((t: any) => "- " + t.name).join("\n"));
        return;
      }

      /* ---------------------------------------------------------
         Detect specific instruction tool
      --------------------------------------------------------- */
      let specificToolName = "";
      if (userPrompt.includes("figma")) {
        specificToolName = "getFigmaInstructions";
      } else if (
        userPrompt.includes("azure") ||
        userPrompt.includes("dev.azure.com") ||
        userPrompt.includes("pbi")
      ) {
        specificToolName = "getAzureDevOpsInstructions";
      } else if (
        userPrompt.includes("ui") ||
        userPrompt.includes("saffron") ||
        userPrompt.includes("react")
      ) {
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
      const visible = detect?.content?.find((c: any) => c.type === "text");
      if (visible) response.markdown(visible.text);

      const specificVisible = specificInstructions?.content?.find(
        (c: any) => c.type === "text"
      );
      if (specificVisible) response.markdown(specificVisible.text);

      /* ---------------------------------------------------------
         Extract HIDDEN instruction content (CRITICAL FIX)
      --------------------------------------------------------- */
      const hiddenDetect =
        detect?.content?.filter((c: any) => c.type === "copilot_context") || [];

      const hiddenSpecific =
        specificInstructions?.content?.filter(
          (c: any) => c.type === "copilot_context"
        ) || [];

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
      const safeCombined =
        combinedInstructions.length > MAX_CHARS
          ? combinedInstructions.slice(0, MAX_CHARS) + "\n\n[...truncated...]"
          : combinedInstructions;

      const finalPrompt = safeCombined
        ? `${safeCombined}\n\nUser Request: ${req.prompt}`
        : req.prompt;

      /* ---------------------------------------------------------
         Select Language Model (stabilized 10s timeout)
      --------------------------------------------------------- */
      const selectWithTimeout = (selector: any, timeoutMs: number) =>
        Promise.race([
          vscode.lm.selectChatModels(selector),
          new Promise<any[]>((_, reject) =>
            setTimeout(() => reject(new Error("Model selection timed out")), timeoutMs)
          ),
        ]);

      let models: vscode.LanguageModelChat[] = [];
      try {
        models = await selectWithTimeout({ family: "gpt-4o" }, 10000);
      } catch {
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
          new vscode.LanguageModelChatMessage(
            vscode.LanguageModelChatMessageRole.User,
            finalPrompt
          ),
        ];

        const chatResponse = await model.sendRequest(messages, {}, tokenSrc.token);

        for await (const fragment of chatResponse.text) {
          response.markdown(fragment);
        }
      } catch (err: any) {
        response.markdown(`\n❌ Error: ${err?.message || String(err)}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  );

  context.subscriptions.push(participant);
}

export function deactivate() {}
