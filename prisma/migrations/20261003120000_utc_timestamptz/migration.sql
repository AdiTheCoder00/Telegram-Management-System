-- Timestamp integrity: convert every timestamp column to TIMESTAMPTZ(3).
--
-- Why: columns were `timestamp without time zone`. Prisma writes UTC wall-time into them, but raw SQL
-- (NOW(), driver-serialised Dates) used the *session* time zone. On a non-UTC server (e.g. Asia/Calcutta)
-- Quote."updatedAt" was stored 5h30m ahead, making cached prices look fresh when they were stale.
--
-- Existing values written by Prisma are UTC wall-time, so they are converted with
-- `AT TIME ZONE 'UTC'` (value-preserving, independent of the session time zone).
-- Quote."updatedAt" was written by NOW() in the session zone and cannot be trusted; it is reset to
-- "sourceTime" below (Quote is a cache and is refreshed on the next price update).

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "ApiKey" ALTER COLUMN "lastUsedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastUsedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "revokedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "revokedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "TelegramBot" ALTER COLUMN "lastCheckedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastCheckedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Instrument" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Quote" ALTER COLUMN "sourceTime" SET DATA TYPE TIMESTAMPTZ(3) USING "sourceTime" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "WebhookReceipt" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Alert" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
ALTER COLUMN "lastTriggeredAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastTriggeredAt" AT TIME ZONE 'UTC',
ALTER COLUMN "lastEvaluatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastEvaluatedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "AlertEvent" ALTER COLUMN "triggeredAt" SET DATA TYPE TIMESTAMPTZ(3) USING "triggeredAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "TelegramDelivery" ALTER COLUMN "nextAttemptAt" SET DATA TYPE TIMESTAMPTZ(3) USING "nextAttemptAt" AT TIME ZONE 'UTC',
ALTER COLUMN "lockedUntil" SET DATA TYPE TIMESTAMPTZ(3) USING "lockedUntil" AT TIME ZONE 'UTC',
ALTER COLUMN "sentAt" SET DATA TYPE TIMESTAMPTZ(3) USING "sentAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "WorkerHeartbeat" ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "startedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "lastSeenAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastSeenAt" AT TIME ZONE 'UTC';


-- Repair cache timestamps written in the session time zone.
UPDATE "Quote" SET "updatedAt" = "sourceTime";
