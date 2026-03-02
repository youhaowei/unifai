import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { resolve, join, delimiter } from "node:path";
import { existsSync } from "node:fs";

// --- JSON-RPC types ---

type RequestId = string | number;

interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg && !("result" in msg) && !("error" in msg);
}

// --- Pending request bookkeeping ---

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

// --- Types for notification/request handlers ---

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (id: RequestId, params: unknown) => void;
type ServerRequestFilter = (id: RequestId, params: unknown) => boolean;

// --- Singleton app-server manager ---

let instance: CodexAppServer | null = null;

export class CodexAppServer {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private refcount = 0;
  private nextId = 1;
  private pending = new Map<RequestId, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private serverRequestHandlers = new Map<string, Array<{ handler: ServerRequestHandler; filter?: ServerRequestFilter }>>();
  private initPromise: Promise<void> | null = null;
  private disposed = false;

  static acquire(): CodexAppServer {
    if (!instance || instance.disposed) {
      instance = new CodexAppServer();
    }
    instance.refcount++;
    return instance;
  }

  release() {
    this.refcount--;
    if (this.refcount <= 0) {
      this.dispose();
      if (instance === this) instance = null;
    }
  }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error("CodexAppServer has been disposed");
    this.initPromise ??= this.start();
    return this.initPromise;
  }

  private async start(): Promise<void> {
    const codexPath = findCodexBinary();
    this.process = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error("Failed to spawn codex app-server: no stdio");
    }

    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on("line", (line) => this.handleLine(line));

    this.process.on("exit", (code) => {
      if (!this.disposed) {
        // Allow re-initialization on next ensureRunning()
        this.initPromise = null;
        this.process = null;
        this.readline = null;
        // Reject all pending requests
        for (const [, pending] of this.pending) {
          pending.reject(new Error(`codex app-server exited with code ${code}`));
        }
        this.pending.clear();
      }
    });

    // Initialize the connection
    await this.request("initialize", {
      clientInfo: { name: "unifai", title: "unifai", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });

    // Send initialized notification
    this.notify("initialized", undefined);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureRunning();
    const id = this.nextId++;
    const msg: JsonRpcRequest = { id, method, ...(params !== undefined && { params }) };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(msg);
    });
  }

  notify(method: string, params: unknown) {
    const msg: JsonRpcNotification = { method, ...(params !== undefined && { params }) };
    this.write(msg);
  }

  respond(id: RequestId, result: unknown) {
    const msg: JsonRpcResponse = { id, result };
    this.write(msg);
  }

  respondError(id: RequestId, code: number, message: string) {
    const msg: JsonRpcResponse = { id, error: { code, message } };
    this.write(msg);
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler, filter?: ServerRequestFilter): () => void {
    let arr = this.serverRequestHandlers.get(method);
    if (!arr) {
      arr = [];
      this.serverRequestHandlers.set(method, arr);
    }
    const entry = { handler, filter };
    arr.push(entry);
    return () => {
      const list = this.serverRequestHandlers.get(method);
      if (list) {
        const idx = list.indexOf(entry);
        if (idx !== -1) list.splice(idx, 1);
        if (list.length === 0) this.serverRequestHandlers.delete(method);
      }
    };
  }

  private write(msg: JsonRpcMessage) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Skip non-JSON lines (stderr leaking, etc.)
    }

    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`${msg.error.message} (code: ${msg.error.code})`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (isRequest(msg)) {
      // Server → client request (approval, user input, etc.)
      const handlers = this.serverRequestHandlers.get(msg.method);
      if (handlers && handlers.length > 0) {
        // Find the first handler whose filter matches (or has no filter)
        const match = handlers.find((h) => !h.filter || h.filter(msg.id, msg.params));
        if (match) {
          match.handler(msg.id, msg.params);
        } else {
          // Handlers exist but none matched the filter — use the last registered (fallback)
          handlers[handlers.length - 1].handler(msg.id, msg.params);
        }
      } else {
        // No handler registered — respond with error
        this.respondError(msg.id, -32601, `No handler for server request: ${msg.method}`);
      }
    } else {
      // Notification
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params);
        }
      }
    }
  }

  private dispose() {
    this.disposed = true;
    this.readline?.close();
    this.readline = null;
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");
      this.process = null;
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error("CodexAppServer disposed"));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.serverRequestHandlers.clear();
    this.initPromise = null;
  }
}

// --- Binary resolution ---

function findCodexBinary(): string {
  // 1. Check PATH
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) return candidate;
  }

  // 2. Check @openai/codex npm package vendor directory
  try {
    const pkgDir = resolve(require.resolve("@openai/codex/package.json"), "..");
    const { platform, arch } = process;
    const target = `${platform}-${arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch}`;
    const vendorPath = join(pkgDir, "vendor", target, "codex", "codex");
    if (existsSync(vendorPath)) return vendorPath;
  } catch {
    // Package not installed
  }

  // 3. Fallback — assume it's on PATH and let spawn fail with a clear error
  return "codex";
}
