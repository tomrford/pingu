import { config } from "./config";
import { store } from "./store";
import {
  type ServerMessage,
  type ClientMessage,
  type QuestionInfo,
  TimeoutError,
  ShutdownError,
} from "./types";
import index from "../ui/index.html";

const clients = new Set<import("bun").ServerWebSocket>();

function broadcast(message: ServerMessage) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    client.send(data);
  }
}

store.setCallbacks({
  onQuestionAdded: (question: QuestionInfo) => {
    broadcast({ type: "question_added", question });
  },
  onQuestionRemoved: (id: string) => {
    broadcast({ type: "question_removed", id });
  },
});

async function handleAsk(req: Request): Promise<Response> {
  let body: { text?: string; cwd?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request: invalid JSON", { status: 400 });
  }

  const { text, cwd } = body;
  if (!text || typeof text !== "string") {
    return new Response("Bad request: text required", { status: 400 });
  }
  if (!cwd || typeof cwd !== "string") {
    return new Response("Bad request: cwd required", { status: 400 });
  }

  const { promise } = store.create({ text, cwd });

  try {
    const answer = await promise;
    return new Response(answer, { status: 200 });
  } catch (err) {
    if (err instanceof TimeoutError) {
      return new Response("Timed out", { status: 504 });
    }
    if (err instanceof ShutdownError) {
      return new Response("Server unavailable", { status: 503 });
    }
    throw err;
  }
}

export function createServer() {
  return Bun.serve({
    port: config.port,
    hostname: config.host,
    idleTimeout: 0, // disable idle timeout - questions can wait up to config.timeoutMs
    tls: config.tlsEnabled
      ? {
          key: Bun.file(config.tlsKeyPath),
          cert: Bun.file(config.tlsCertPath),
        }
      : undefined,

    routes: {
      "/": index,
      "/ask": {
        POST: handleAsk,
      },
      "/health": new Response("ok"),
    },

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "sync", questions: store.list() } satisfies ServerMessage));
      },

      message(ws, message) {
        let parsed: ClientMessage;
        try {
          parsed = JSON.parse(String(message));
        } catch {
          return;
        }

        if (parsed.type === "answer") {
          const result = store.answer(parsed.id, parsed.text);
          if (result === "answered") {
            ws.send(JSON.stringify({ type: "answer_accepted", id: parsed.id } satisfies ServerMessage));
          } else {
            ws.send(
              JSON.stringify({
                type: "answer_rejected",
                id: parsed.id,
                reason: result,
              } satisfies ServerMessage)
            );
          }
        }
      },

      close(ws) {
        clients.delete(ws);
      },
    },
  });
}

export function shutdown() {
  store.shutdown();
}
