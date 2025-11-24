import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

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

/**
 * Minimal MCP client for VS Code extension
 */
class MCPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private msgId = 1;
  private pending: Map<number, (resp: MCPResponse) => void> = new Map();

  constructor(private command: string, private args: string[]) {}

  start(out: vscode.OutputChannel) {
    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      out.appendLine("[MCP STDOUT] " + text);

      // Parse JSON RPC safely
      try {
        const obj = JSON.parse(text) as MCPResponse;
        if (obj.id && this.pending.has(obj.id)) {
          this.pending.get(obj.id)?.(obj);
          this.pending.delete(obj.id);
        }
      } catch {
        // ignore non-JSON output
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
      const req: MCPRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const json = JSON.stringify(req);
      this.proc?.stdin.write(json + "\n");

      this.pending.set(id, (resp: MCPResponse) => {
        resolve(resp.result);
      });
    });
  }
}

/**
 * VS Code Extension Activation
 */
export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Snap MCP Debug");
  out.show(true);

  const mcpPath =
    "C:/Users/DuddeYaswaAnirwin/snap-mcp-plugin/mcp/instructions-remote-mcp.mjs";

  const client = new MCPClient("node", [mcpPath]);
  client.start(out);

  // === Send initialize sequence ===
  (async () => {
    out.appendLine("➡️ Sending initialize...");
    await client.send("initialize", {});
    await client.send("initialized", {});
    const tools = await client.send("tools/list", {});

    out.appendLine("🧰 Tools discovered:");
    for (const t of tools.tools) out.appendLine(" - " + t.name);
  })();

  /**
   * Chat participant: @snap
   */
  const participant = vscode.chat.createChatParticipant(
    "snap",
    async (req, ctx, res) => {
      const text = req.prompt.toLowerCase();

      if (text.includes("list tools")) {
        const tools = await client.send("tools/list", {});
        res.markdown("### 🧰 Available Tools:");
        res.markdown(tools.tools.map((t: any) => "- " + t.name).join("\n"));
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
    }
  );

  context.subscriptions.push(participant);
}

export function deactivate() {}
