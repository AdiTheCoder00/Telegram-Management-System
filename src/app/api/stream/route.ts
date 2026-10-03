import { route } from "@/lib/api";
import { logger } from "@/lib/logger";
import { monitorSnapshot } from "@/lib/services/monitor";

export const dynamic = "force-dynamic";

const INTERVAL_MS = 2_000;
const MAX_LIFETIME_MS = 10 * 60_000; // the browser's EventSource reconnects automatically

/**
 * GET /api/stream — Server-Sent Events for the live monitor. Sends a `snapshot` event every 2 s (only when it
 * changed) and a comment heartbeat otherwise. Read-only; closes when the client disconnects.
 */
export const GET = route(async ({ req, user }) => {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const started = Date.now();
      let last = "";
      let busy = false;
      const close = () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          if (req.signal.aborted || Date.now() - started > MAX_LIFETIME_MS) return close();
          const snap = await monitorSnapshot(user.id);
          const { at, ...rest } = snap;
          const body = JSON.stringify(rest);
          if (body !== last) {
            last = body;
            controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ at, ...rest })}\n\n`));
          } else controller.enqueue(encoder.encode(`: ${at}\n\n`));
        } catch (err) {
          logger.warn("Monitor stream tick failed", { err: String(err) });
        } finally {
          busy = false;
        }
      };
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      void tick();
      timer = setInterval(tick, INTERVAL_MS);
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
