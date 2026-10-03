import { after } from "next/server";
import { logger } from "@/lib/logger";
import { processDelivery } from "@/lib/notifications/delivery";

/**
 * Sends deliveries after the HTTP response has been returned (used by web routes when no Redis queue is
 * configured). If the process dies first, the worker's outbox sweep still delivers them.
 */
export function deliverAfterResponse(ids: string[]) {
  if (!ids.length) return;
  const run = async () => {
    for (const id of ids) {
      try {
        await processDelivery(id);
      } catch (err) {
        logger.error("Background delivery failed", { deliveryId: id, err });
      }
    }
  };
  try {
    after(run);
  } catch {
    void run(); // outside a Next.js request scope (tests, scripts)
  }
}
