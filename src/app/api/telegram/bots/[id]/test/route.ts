import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { sendBotTestMessage } from "@/lib/services/bots";

const schema = z.object({ message: z.string().max(1000).optional() });

export const POST = route<{ id: string }>(
  async ({ req, user, params }) => {
    const { message } = await parseBody(req, schema);
    return { result: await sendBotTestMessage(user.id, params.id, message) };
  },
  { rateLimit: [10, 60_000], bucket: "bot-test" },
);
