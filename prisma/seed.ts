/**
 * Seeds reference data (instruments) and, optionally, a demo user.
 *   npm run db:seed
 *   SEED_DEMO_USER=true SEED_DEMO_PASSWORD=... npm run db:seed
 * Idempotent: safe to run repeatedly.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const instruments = [
  {
    symbol: "XAUUSD",
    displayName: "Gold / US Dollar",
    assetClass: "metal",
    exchange: "FX",
    provider: "twelvedata",
    providerSymbol: "XAU/USD",
    decimals: 2,
  },
  {
    symbol: "XAGUSD",
    displayName: "Silver / US Dollar",
    assetClass: "metal",
    exchange: "FX",
    provider: "twelvedata",
    providerSymbol: "XAG/USD",
    decimals: 3,
  },
  {
    symbol: "BTCUSD",
    displayName: "Bitcoin / US Dollar",
    assetClass: "crypto",
    exchange: "Binance",
    provider: "binance",
    providerSymbol: "BTCUSDT",
    decimals: 2,
  },
  {
    symbol: "ETHUSD",
    displayName: "Ethereum / US Dollar",
    assetClass: "crypto",
    exchange: "Binance",
    provider: "binance",
    providerSymbol: "ETHUSDT",
    decimals: 2,
  },
  {
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    assetClass: "forex",
    exchange: "FX",
    provider: "twelvedata",
    providerSymbol: "EUR/USD",
    decimals: 5,
  },
  {
    symbol: "GBPUSD",
    displayName: "British Pound / US Dollar",
    assetClass: "forex",
    exchange: "FX",
    provider: "twelvedata",
    providerSymbol: "GBP/USD",
    decimals: 5,
  },
  {
    symbol: "USDJPY",
    displayName: "US Dollar / Japanese Yen",
    assetClass: "forex",
    exchange: "FX",
    provider: "twelvedata",
    providerSymbol: "USD/JPY",
    decimals: 3,
  },
  {
    symbol: "NAS100",
    displayName: "Nasdaq 100",
    assetClass: "index",
    exchange: "NASDAQ",
    provider: "twelvedata",
    providerSymbol: "NDX",
    decimals: 2,
  },
  {
    symbol: "US30",
    displayName: "Dow Jones 30",
    assetClass: "index",
    exchange: "NYSE",
    provider: "twelvedata",
    providerSymbol: "DJI",
    decimals: 2,
  },
  {
    symbol: "SPX500",
    displayName: "S&P 500",
    assetClass: "index",
    exchange: "NYSE",
    provider: "twelvedata",
    providerSymbol: "SPX",
    decimals: 2,
  },
  {
    symbol: "FIXEDVOL100",
    displayName: "Fixed Volatility 100 Index",
    assetClass: "synthetic index",
    exchange: "Deriv",
    provider: "webhook",
    providerSymbol: null,
    decimals: 2,
  },
];

async function main() {
  for (const i of instruments) {
    await db.instrument.upsert({ where: { symbol: i.symbol }, create: i, update: i });
  }
  console.log(`Seeded ${instruments.length} instruments`);

  if (process.env.SEED_DEMO_USER === "true") {
    const email = process.env.SEED_DEMO_EMAIL ?? "demo@example.com";
    const password = process.env.SEED_DEMO_PASSWORD;
    if (!password || password.length < 10) throw new Error("Set SEED_DEMO_PASSWORD (min 10 chars) to create the demo user");
    await db.user.upsert({
      where: { email },
      create: { email, name: "Demo Trader", passwordHash: await bcrypt.hash(password, 12) },
      update: {},
    });
    console.log(`Demo user ready: ${email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
