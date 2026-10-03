-- AlterEnum (values are appended, mirroring prisma/schema.prisma)
ALTER TYPE "AlertStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "AlertStatus" ADD VALUE IF NOT EXISTS 'COOLDOWN';
