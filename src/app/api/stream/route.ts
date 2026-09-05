/**
 * Server-Sent Events.
 *
 * SSE rather than WebSockets because the traffic is one-directional and
 * bursty, and because SSE reconnects itself and carries a resume cursor
 * (`Last-Event-ID`) in the protocol. Getting resumption right is the part that
 * matters: a phone that loses signal for ninety seconds must come back and be
 * told what it missed, or the "since you last checked" promise quietly breaks
 * for exactly the users most likely to be moving around.
 *
 * If the client asks to resume from an id we no longer hold in the replay
 * buffer, we say so explicitly and it refetches the digest — a visible,
 * handled gap rather than a silent one.
 */

import { hub } from "@/server/events/hub";
import { requireUser } from "@/server/http";
import { errorResponse } from "@/server/http";
import { watchedItems } from "@/server/repo/watchlists";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;
const WATCHSET_REFRESH_MS = 20_000;

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    return errorResponse(err);
  }

  const lastEventId = Number(req.headers.get("last-event-id") ?? "0") || 0;
  const encoder = new TextEncoder();

  let watched = new Set((await watchedItems(user.id)).map((i) => i.instrumentId));
  const topicsFor = () => new Set([...watched].map((id) => `instrument:${id}`));
  let allowed = topicsFor();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const event = (id: number, name: string, data: unknown) =>
        send(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

      // Tell the client how to reconnect and how fast.
      send("retry: 3000\n\n");
      event(hub().currentId, "hello", {
        subscribed: watched.size,
        resumedFrom: lastEventId,
        gap: hub().hasGap(lastEventId),
      });

      // Replay whatever the client missed that we still hold.
      if (lastEventId > 0) {
        for (const m of hub().replay(lastEventId)) {
          if (allowed.has(m.topic) || m.topic === "system") event(m.id, m.event, m.data);
        }
      }

      const unsubscribe = hub().subscribe((m) => {
        if (!allowed.has(m.topic) && m.topic !== "system") return;
        event(m.id, m.event, m.data);
      });

      // A comment line keeps proxies from closing an idle connection, and
      // tells the client we are still alive during a quiet market.
      const heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);

      // The watch set changes while the stream is open; pick that up without
      // forcing a reconnect.
      const refresh = setInterval(async () => {
        try {
          watched = new Set((await watchedItems(user.id)).map((i) => i.instrumentId));
          allowed = topicsFor();
        } catch {
          // Transient database trouble should not kill a live stream.
        }
      }, WATCHSET_REFRESH_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(refresh);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer by default, which turns a live stream into a
      // batch delivery every few kilobytes.
      "x-accel-buffering": "no",
    },
  });
}
