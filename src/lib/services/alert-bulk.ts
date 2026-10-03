import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { alertInputSchema } from "@/lib/validation";
import { configSnapshot, createAlert, deleteAlert, pauseAlert, resumeAlert } from "@/lib/services/alerts";
import { audit } from "@/lib/services/audit";

/**
 * Groups, bulk actions and JSON import/export (M18). Bulk actions run per alert through the same service
 * functions as single actions (so activation validation still applies) and report per-alert results.
 */

// ─── groups ──────────────────────────────────────────────────────────────────

export async function listGroups(userId: string) {
  const groups = await db.alertGroup.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: { _count: { select: { alerts: true } } },
  });
  return groups.map((g) => ({ id: g.id, name: g.name, alerts: g._count.alerts }));
}

export async function createGroup(userId: string, name: string) {
  const exists = await db.alertGroup.findFirst({ where: { userId, name: { equals: name, mode: "insensitive" } } });
  if (exists) throw badRequest("A group with that name already exists.");
  const g = await db.alertGroup.create({ data: { userId, name } });
  return { id: g.id, name: g.name, alerts: 0 };
}

export async function deleteGroup(userId: string, id: string) {
  const g = await db.alertGroup.findFirst({ where: { id, userId } });
  if (!g) throw notFound("Group");
  await db.alertGroup.delete({ where: { id } }); // alerts keep existing (groupId set null)
}

// ─── bulk ────────────────────────────────────────────────────────────────────

export const bulkSchema = z.object({
  ids: z.array(z.string().max(40)).min(1).max(500),
  action: z.enum(["pause", "resume", "delete", "group"]),
  groupId: z.string().max(40).nullable().optional(),
});

export async function bulkAction(userId: string, input: z.infer<typeof bulkSchema>) {
  const owned = await db.alert.findMany({ where: { userId, id: { in: input.ids } }, select: { id: true, name: true } });
  const results: { id: string; name: string; ok: boolean; error?: string }[] = [];
  if (input.action === "group") {
    if (input.groupId) {
      const g = await db.alertGroup.findFirst({ where: { id: input.groupId, userId } });
      if (!g) throw notFound("Group");
    }
    await db.alert.updateMany({ where: { userId, id: { in: owned.map((a) => a.id) } }, data: { groupId: input.groupId ?? null } });
    for (const a of owned) results.push({ ...a, ok: true });
    return { results };
  }
  for (const a of owned) {
    try {
      if (input.action === "pause") await pauseAlert(userId, a.id);
      else if (input.action === "resume") await resumeAlert(userId, a.id);
      else await deleteAlert(userId, a.id);
      results.push({ ...a, ok: true });
    } catch (err) {
      results.push({ ...a, ok: false, error: err instanceof AppError ? err.message : "Failed" });
    }
  }
  await audit(userId, `alerts.bulk_${input.action}`, null, { count: owned.length, failed: results.filter((r) => !r.ok).length });
  return { results };
}

// ─── export / import ─────────────────────────────────────────────────────────

export const EXPORT_FORMAT = "levels-alerts";
export const EXPORT_VERSION = 1;

export async function exportAlerts(userId: string, ids?: string[]) {
  const alerts = await db.alert.findMany({
    where: { userId, ...(ids?.length ? { id: { in: ids } } : {}) },
    include: { group: { select: { name: true } }, bot: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    alerts: alerts.map((a) => {
      const { telegramBotId: _bot, ...config } = configSnapshot(a);
      void _bot;
      return { ...config, group: a.group?.name ?? null, botName: a.bot?.name ?? null };
    }),
  };
}

const importItem = z
  .object({ group: z.string().max(60).nullable().optional(), botName: z.string().max(100).nullable().optional() })
  .passthrough();
export const importSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  alerts: z.array(importItem).min(1).max(200),
});

/**
 * Imports alerts from an export file. Every alert is validated with the same schema and service checks as the
 * form; nothing is imported unless all are valid. Imported alerts start PAUSED (review, then resume), are
 * matched to a Telegram bot by name when possible, and get fresh version history (v1).
 */
export async function importAlerts(userId: string, file: z.infer<typeof importSchema>) {
  const bots = await db.telegramBot.findMany({ where: { userId }, select: { id: true, name: true } });
  const parsed = file.alerts.map((raw, i) => {
    const { group, botName, ...rest } = raw as Record<string, unknown> & { group?: string | null; botName?: string | null };
    const botId = bots.find((b) => b.name === botName)?.id ?? null;
    const r = alertInputSchema.safeParse({ ...rest, telegramBotId: botId, status: "PAUSED", expiresAt: rest.expiresAt ?? null });
    return { i, group: group ?? null, result: r };
  });
  const errors = parsed
    .filter((p) => !p.result.success)
    .map((p) => `Alert ${p.i + 1}: ${p.result.error!.issues[0]?.path.join(".")} ${p.result.error!.issues[0]?.message}`);
  if (errors.length)
    throw new AppError(400, `The file has ${errors.length} invalid alert(s). Nothing was imported.`, "validation_error", {
      issues: errors.slice(0, 20),
    });

  const created: string[] = [];
  const failures: string[] = [];
  const groupIds = new Map<string, string>();
  for (const p of parsed) {
    try {
      const a = await createAlert(userId, p.result.data!);
      created.push(a.id);
      if (p.group) {
        let gid = groupIds.get(p.group);
        if (!gid) {
          const g =
            (await db.alertGroup.findFirst({ where: { userId, name: p.group } })) ??
            (await db.alertGroup.create({ data: { userId, name: p.group } }));
          gid = g.id;
          groupIds.set(p.group, gid);
        }
        await db.alert.update({ where: { id: a.id }, data: { groupId: gid } });
      }
    } catch (err) {
      failures.push(`Alert ${p.i + 1}: ${(err as Error).message}`);
    }
  }
  if (failures.length) {
    // All-or-nothing: roll back what was created.
    await db.alert.deleteMany({ where: { id: { in: created } } });
    throw new AppError(400, `Import failed; nothing was imported. ${failures[0]}`, "validation_error", { issues: failures.slice(0, 20) });
  }
  logger.info("Alerts imported", { userId, count: created.length });
  await audit(userId, "alerts.import", null, { count: created.length });
  return { imported: created.length };
}
