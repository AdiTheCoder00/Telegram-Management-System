-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('PRICE', 'CONDITIONS');

-- CreateEnum
CREATE TYPE "EvaluationMode" AS ENUM ('EVERY_TICK', 'CANDLE_CLOSE');

-- CreateEnum
CREATE TYPE "BacktestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookKind" AS ENUM ('TRADINGVIEW', 'GENERIC');

-- AlterEnum DeliveryStatus (hand-written; Prisma's generated recreate-and-cast would fail on existing
-- 'PENDING' rows). PENDING is renamed to QUEUED in place, so existing rows keep their meaning; the new
-- states are appended. Postgres enum order is irrelevant here.
ALTER TYPE "DeliveryStatus" RENAME VALUE 'PENDING' TO 'QUEUED';
ALTER TYPE "DeliveryStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "DeliveryStatus" ADD VALUE IF NOT EXISTS 'RETRYING';
ALTER TYPE "DeliveryStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';
ALTER TABLE "AlertEvent" ALTER COLUMN "status" SET DEFAULT 'QUEUED';
ALTER TABLE "TelegramDelivery" ALTER COLUMN "status" SET DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "conditionTree" JSONB,
ADD COLUMN     "configVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "evaluationMode" "EvaluationMode" NOT NULL DEFAULT 'EVERY_TICK',
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "kind" "AlertKind" NOT NULL DEFAULT 'PRICE',
ADD COLUMN     "lastEvaluatedCandle" TIMESTAMPTZ(3),
ADD COLUMN     "lastEvaluationNote" TEXT,
ADD COLUMN     "marketDataState" TEXT,
ADD COLUMN     "pausedByBulk" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timeframe" TEXT NOT NULL DEFAULT '5m';

-- AlterTable
ALTER TABLE "AlertEvent" ADD COLUMN     "alertVersion" INTEGER,
ALTER COLUMN "status" SET DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE "TelegramDelivery" ALTER COLUMN "status" SET DEFAULT 'QUEUED';

-- CreateTable
CREATE TABLE "AlertVersion" (
    "id" TEXT NOT NULL,
    "alertId" TEXT,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerEvidence" (
    "id" TEXT NOT NULL,
    "alertEventId" TEXT NOT NULL,
    "alertId" TEXT,
    "userId" TEXT NOT NULL,
    "alertVersion" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "timeframe" TEXT,
    "evaluationMode" "EvaluationMode" NOT NULL,
    "candleOpenTime" TIMESTAMPTZ(3),
    "candleState" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "marketDataTime" TIMESTAMPTZ(3),
    "providerMeta" JSONB,
    "evaluation" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "evaluationEngineVersion" TEXT NOT NULL,
    "indicatorEngineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriggerEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION,
    "volumeType" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("provider","scope","symbol","timeframe","openTime")
);

-- CreateTable
CREATE TABLE "ProviderHealth" (
    "provider" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastErrorAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderHealth_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "Backtest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alertId" TEXT,
    "alertVersion" INTEGER,
    "status" "BacktestStatus" NOT NULL DEFAULT 'QUEUED',
    "config" JSONB NOT NULL,
    "dataset" JSONB,
    "result" JSONB,
    "error" TEXT,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "engineVersions" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Backtest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "WebhookKind" NOT NULL,
    "secretHash" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertVersion_userId_idx" ON "AlertVersion"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertVersion_alertId_version_key" ON "AlertVersion"("alertId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AlertGroup_userId_name_key" ON "AlertGroup"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerEvidence_alertEventId_key" ON "TriggerEvidence"("alertEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerEvidence_idempotencyKey_key" ON "TriggerEvidence"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TriggerEvidence_alertId_createdAt_idx" ON "TriggerEvidence"("alertId", "createdAt");

-- CreateIndex
CREATE INDEX "TriggerEvidence_userId_createdAt_idx" ON "TriggerEvidence"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Candle_provider_symbol_timeframe_openTime_idx" ON "Candle"("provider", "symbol", "timeframe", "openTime");

-- CreateIndex
CREATE INDEX "Backtest_userId_createdAt_idx" ON "Backtest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Backtest_status_createdAt_idx" ON "Backtest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_secretHash_key" ON "Webhook"("secretHash");

-- CreateIndex
CREATE INDEX "Webhook_userId_idx" ON "Webhook"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_status_kind_idx" ON "Alert"("status", "kind");

-- CreateIndex
CREATE INDEX "Alert_groupId_idx" ON "Alert"("groupId");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AlertGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertVersion" ADD CONSTRAINT "AlertVersion_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertGroup" ADD CONSTRAINT "AlertGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerEvidence" ADD CONSTRAINT "TriggerEvidence_alertEventId_fkey" FOREIGN KEY ("alertEventId") REFERENCES "AlertEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerEvidence" ADD CONSTRAINT "TriggerEvidence_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backtest" ADD CONSTRAINT "Backtest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backtest" ADD CONSTRAINT "Backtest_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every existing alert gets an immutable version-1 snapshot (same keys as alertConfigSnapshot()).
INSERT INTO "AlertVersion" ("id", "alertId", "userId", "version", "config", "createdAt")
SELECT 'av1_' || a."id", a."id", a."userId", 1,
  jsonb_build_object(
    'name', a."name", 'symbol', a."symbol", 'dataProvider', a."dataProvider", 'kind', a."kind",
    'timeframe', a."timeframe", 'evaluationMode', a."evaluationMode", 'conditionType', a."conditionType",
    'targetPrice', a."targetPrice", 'tolerance', a."tolerance", 'conditionTree', a."conditionTree",
    'triggerMode', a."triggerMode", 'cooldownSeconds', a."cooldownSeconds", 'expiryType', a."expiryType",
    'expiresAt', a."expiresAt", 'maxTriggers', a."maxTriggers", 'messageTemplate', a."messageTemplate",
    'parseMode', a."parseMode", 'telegramBotId', a."telegramBotId"),
  a."updatedAt"
FROM "Alert" a
ON CONFLICT DO NOTHING;
