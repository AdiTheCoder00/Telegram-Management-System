import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  // Pin every DB session to UTC so server-side time functions and casts never depend on the host time zone.
  const adapter = new PrismaPg({ connectionString, options: "-c TimeZone=UTC" });
  return new PrismaClient({ adapter });
}

/** Lazily-created singleton (reused across hot reloads in development). */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    if (!globalForPrisma.prisma) globalForPrisma.prisma = createClient();
    const value = Reflect.get(globalForPrisma.prisma, prop);
    return typeof value === "function" ? value.bind(globalForPrisma.prisma) : value;
  },
});

export async function disconnectDb() {
  await globalForPrisma.prisma?.$disconnect();
  globalForPrisma.prisma = undefined;
}
