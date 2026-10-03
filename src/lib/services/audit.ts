import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";

/** Append-only audit log of operational actions (bulk changes, pause-all, reconnects, retries, imports). */
export async function audit(
  userId: string | null,
  action: string,
  target: string | null,
  detail?: Record<string, unknown>,
  ip?: string | null,
) {
  await db.auditLog
    .create({ data: { userId, action, target, detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined, ip: ip ?? null } })
    .catch((err) => logger.warn("Audit log write failed", { action, err: String(err) }));
}

export async function listAudit(userId: string, take = 100) {
  return db.auditLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take });
}
