import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const rows = await db.instrument.findMany({ select: { symbol: true, provider: true, exchange: true, assetClass: true }, orderBy: { symbol: "asc" } });
console.log(JSON.stringify(rows, null, 0));
await db.$disconnect();
