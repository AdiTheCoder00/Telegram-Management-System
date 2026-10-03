import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Optional here so `prisma generate` works in CI/Docker builds without a database;
  // migrate/seed commands require DATABASE_URL to be set.
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
