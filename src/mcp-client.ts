/**
 * Minimal MCP client over raw JSON-RPC stdio.
 * Keeps the verification harness dependency-free, matching the server.
 */

import { spawn } from "node:child_process";

export interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

export class McpClient {
  private child: ReturnType<typeof spawn>;
  private buffer = "";
  private pending = new Map<number, (v: any) => void>();
  private nextId = 1;

  constructor(serverPath: string, env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdin || !child.stdout) {
      throw new Error("Failed to open stdio pipes for the MCP server process");
    }
    this.child = child;
    child.stdout.on("data", (chunk) => this.onData(chunk.toString()));
    child.stderr.on("data", () => {
      /* server logs go to stderr; keep the harness output clean */
    });
  }

  private onData(text: string) {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
      } catch {
        /* ignore non-JSON noise */
      }
    }
  }

  private stdinWrite(payload: string) {
    const stdin = this.child.stdin;
    if (!stdin) throw new Error("MCP server stdin is closed");
    stdin.write(payload);
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method} -> ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.stdinWrite(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown) {
    this.stdinWrite(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mavis-verify", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async listTools(): Promise<any[]> {
    const res = await this.request("tools/list");
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return this.request("tools/call", { name, arguments: args });
  }

  /** Calls a tool and parses its JSON payload; throws on tool-level errors. */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await this.callTool(name, args);
    const text = (res.content ?? []).map((c) => c.text ?? "").join("");
    if (res.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text);
  }

  close() {
    this.child.stdin?.end();
    this.child.kill();
  }
}
