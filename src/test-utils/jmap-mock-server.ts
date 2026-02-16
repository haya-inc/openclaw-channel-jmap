import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { JMAP_MAIL, JMAP_SUBMISSION } from "../types.js";

type JmapMethodCallTuple = [string, Record<string, unknown>, string];
type JmapMethodResponseTuple = [string, Record<string, unknown>, string];

type JmapSession = {
  apiUrl: string;
  username?: string;
  primaryAccounts: Record<string, string>;
  accounts: Record<string, { accountCapabilities?: Record<string, unknown> }>;
};

type EnqueuedResponse = {
  requestMethod: string;
  requestCallId?: string;
  responseMethod: string;
  payload: Record<string, unknown>;
};

export type JmapCapturedCall = {
  methodName: string;
  callId: string;
  args: Record<string, unknown>;
};

export type JmapCapturedRequest = {
  method: string;
  path: string;
  bodyText: string;
  methodCalls: JmapCapturedCall[];
};

type JmapMockServerOptions = {
  sessionPath?: string;
  apiPath?: string;
};

export class JmapMockServer {
  private readonly sessionPath: string;
  private readonly apiPath: string;
  private readonly server: Server;
  private origin = "";
  private readonly queue: EnqueuedResponse[] = [];
  private readonly calls: JmapCapturedCall[] = [];
  private readonly requests: JmapCapturedRequest[] = [];
  private sessionOverrides: Partial<JmapSession> = {};

  private constructor(options?: JmapMockServerOptions) {
    this.sessionPath = options?.sessionPath ?? "/.well-known/jmap";
    this.apiPath = options?.apiPath ?? "/jmap";
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  static async start(options?: JmapMockServerOptions): Promise<JmapMockServer> {
    const server = new JmapMockServer(options);
    await server.listen();
    return server;
  }

  get sessionUrl(): string {
    return `${this.origin}${this.sessionPath}`;
  }

  get apiUrl(): string {
    return `${this.origin}${this.apiPath}`;
  }

  get pendingResponses(): number {
    return this.queue.length;
  }

  close = async (): Promise<void> => {
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  setSession(overrides: Partial<JmapSession>) {
    this.sessionOverrides = {
      ...this.sessionOverrides,
      ...overrides,
    };
  }

  enqueueMethod(
    requestMethod: string,
    payload: Record<string, unknown>,
    options?: {
      requestCallId?: string;
      responseMethod?: string;
    },
  ) {
    this.queue.push({
      requestMethod,
      requestCallId: options?.requestCallId,
      responseMethod: options?.responseMethod ?? requestMethod,
      payload,
    });
  }

  enqueueError(
    requestMethod: string,
    error: { type: string; description?: string },
    options?: { requestCallId?: string },
  ) {
    this.queue.push({
      requestMethod,
      requestCallId: options?.requestCallId,
      responseMethod: "error",
      payload: {
        type: error.type,
        ...(error.description ? { description: error.description } : {}),
      },
    });
  }

  getCalls(methodName?: string): JmapCapturedCall[] {
    if (!methodName) {
      return [...this.calls];
    }
    return this.calls.filter((entry) => entry.methodName === methodName);
  }

  getRequests(): JmapCapturedRequest[] {
    return [...this.requests];
  }

  private async listen(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("JMAP mock server failed to bind");
    }
    const info = address as AddressInfo;
    this.origin = `http://127.0.0.1:${info.port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && path === this.sessionPath) {
      this.respondJson(res, 200, this.buildSession());
      return;
    }

    if (method !== "POST" || path !== this.apiPath) {
      this.respondJson(res, 404, { error: `Unhandled path: ${method} ${path}` });
      return;
    }

    const bodyText = await this.readBody(req);
    let body: { methodCalls?: unknown };
    try {
      body = bodyText ? (JSON.parse(bodyText) as { methodCalls?: unknown }) : {};
    } catch {
      this.respondJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (!Array.isArray(body.methodCalls)) {
      this.respondJson(res, 400, { error: "JMAP request missing methodCalls" });
      return;
    }

    try {
      const capturedCalls = this.captureCalls(body.methodCalls as unknown[]);
      this.requests.push({
        method,
        path,
        bodyText,
        methodCalls: capturedCalls,
      });

      const methodResponses: JmapMethodResponseTuple[] = capturedCalls.map((call) => {
        const response = this.dequeueResponse(call.methodName, call.callId);
        return [response.responseMethod, response.payload, call.callId];
      });
      this.respondJson(res, 200, {
        methodResponses,
        sessionState: "mock-session-state",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondJson(res, 500, { error: message });
    }
  }

  private captureCalls(rawCalls: unknown[]): JmapCapturedCall[] {
    const calls: JmapCapturedCall[] = [];
    for (const rawEntry of rawCalls) {
      if (!Array.isArray(rawEntry) || rawEntry.length !== 3) {
        throw new Error("Invalid JMAP method call tuple");
      }
      const [methodName, rawArgs, callId] = rawEntry as unknown[];
      if (typeof methodName !== "string" || typeof callId !== "string") {
        throw new Error("Invalid JMAP method call entry");
      }
      if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
        throw new Error(`Invalid JMAP args for method ${methodName}`);
      }
      const call: JmapCapturedCall = {
        methodName,
        callId,
        args: rawArgs as Record<string, unknown>,
      };
      calls.push(call);
      this.calls.push(call);
    }
    return calls;
  }

  private dequeueResponse(methodName: string, callId: string): EnqueuedResponse {
    const index = this.queue.findIndex((entry) => {
      if (entry.requestMethod !== methodName) {
        return false;
      }
      if (entry.requestCallId && entry.requestCallId !== callId) {
        return false;
      }
      return true;
    });

    if (index === -1) {
      const pending = this.queue
        .map((entry) =>
          entry.requestCallId
            ? `${entry.requestMethod}:${entry.requestCallId}`
            : entry.requestMethod,
        )
        .join(", ");
      throw new Error(
        `No queued response for ${methodName} (${callId}). Pending: ${pending || "none"}`,
      );
    }

    const [response] = this.queue.splice(index, 1);
    return response;
  }

  private buildSession(): JmapSession {
    const baseAccountId = "acc-1";
    return {
      apiUrl: this.apiUrl,
      username: "bot@example.com",
      primaryAccounts: {
        [JMAP_MAIL]: baseAccountId,
        [JMAP_SUBMISSION]: baseAccountId,
      },
      accounts: {
        [baseAccountId]: {
          accountCapabilities: {
            [JMAP_MAIL]: {},
            [JMAP_SUBMISSION]: {},
          },
        },
      },
      ...this.sessionOverrides,
    };
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  private respondJson(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
}
