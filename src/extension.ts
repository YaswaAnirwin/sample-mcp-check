import * as vscode from "vscode";
import { spawn } from "child_process";

/**
 * 🧩 Snap MCP Instruction Loader Test
 * Shows all markdown files fetched by the MCP before Copilot generation.
 */
export function activate(context: vscode.ExtensionContext) {
  const mcpPath =
    "C:/Users/DuddeYaswaAnirwin/snap-mcp-plugin/mcp/instructions-remote-mcp.mjs";

  const loadedFiles: string[] = [];
  let mcpOutput = "";

  // --- 1️⃣ Start MCP server manually ---
  const mcpProc = spawn("node", [mcpPath], { stdio: ["pipe", "pipe", "pipe"] });
  const outChannel = vscode.window.createOutputChannel("Snap MCP Debug");
  outChannel.show(true);

  mcpProc.stdout.on("data", (d: Buffer) => {
    const text = d.toString();
    mcpOutput += text;
    outChannel.append(text);

    // capture all "✅ Loaded:" lines within this chunk
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/✅\s+Loaded:\s*(.+)/);
      if (match) {
        const file = match[1].trim();
        if (!loadedFiles.includes(file)) {
          loadedFiles.push(file);
        }
      }
    }
  });

  mcpProc.stderr.on("data", (d: Buffer) => {
    outChannel.appendLine("[MCP Error] " + d.toString());
  });

  mcpProc.on("close", (code: number | null) => {
    outChannel.appendLine(`[MCP] exited with code ${code}`);
  });

  // --- 2️⃣ Chat participant for @snap ---
  const snapParticipant = vscode.chat.createChatParticipant(
    "snap",
    async (request, chatCtx, response) => {
      response.markdown("🧩 **Snap MCP Instruction Loader Active…**");

      // small delay to allow late stdout lines to finish
      await new Promise(r => setTimeout(r, 500));

      if (loadedFiles.length > 0) {
        response.markdown(
          `✅ **Files loaded into Copilot context:**\n\n${loadedFiles
            .map(f => `- ${f}`)
            .join("\n")}`
        );
      } else {
        response.markdown(
          "⚠️ MCP is still loading or no files were detected. Check the 'Snap MCP Debug' output."
        );
      }

      response.markdown(`🕒 Last update: ${new Date().toLocaleTimeString()}`);
    }
  );

  context.subscriptions.push(snapParticipant);
  context.subscriptions.push({ dispose: () => mcpProc.kill() });
}

export function deactivate() {}
