import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.WEBHOOK_SECRET = "global-webhook-secret-for-tests";
process.env.REDIS_URL = "";
process.env.LOG_LEVEL = "error";
