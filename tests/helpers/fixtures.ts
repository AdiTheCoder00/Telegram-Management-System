import { db } from "@/lib/db";
import { encrypt, randomToken } from "@/lib/crypto";
import { DEFAULT_TEMPLATE } from "@/lib/constants";
import type { Prisma } from "@/generated/prisma/client";
import { VALID_TOKEN } from "./mock-telegram";

export async function makeUser(email = `u-${randomToken(6)}@test.dev`) {
  return db.user.create({ data: { email, name: "Test", passwordHash: "x" } });
}

export async function makeBot(userId: string, over: Partial<Prisma.TelegramBotUncheckedCreateInput> = {}) {
  return db.telegramBot.create({
    data: {
      userId,
      name: "Bot",
      encryptedToken: encrypt(VALID_TOKEN),
      tokenHint: VALID_TOKEN.slice(-4),
      chatId: "-1001234567890",
      status: "CONNECTED",
      ...over,
    },
  });
}

export async function makeAlert(userId: string, botId: string | null, over: Partial<Prisma.AlertUncheckedCreateInput> = {}) {
  return db.alert.create({
    data: {
      userId,
      telegramBotId: botId,
      name: "Gold Breakout Alert",
      symbol: `T${randomToken(4)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "X")}`,
      dataProvider: "webhook",
      conditionType: "PRICE_ABOVE",
      targetPrice: 3900,
      messageTemplate: DEFAULT_TEMPLATE,
      triggerMode: "REARM",
      cooldownSeconds: 0,
      ...over,
    },
  });
}
