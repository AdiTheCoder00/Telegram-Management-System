import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { exportAlerts } from "@/lib/services/alert-bulk";

/** GET /api/alerts/export[?ids=a,b] — JSON file of alert configurations (no secrets, no bot tokens/ids). */
export const GET = route(async ({ req, user }) => {
  const ids = req.nextUrl.searchParams.get("ids")?.split(",").filter(Boolean).slice(0, 500);
  const data = await exportAlerts(user.id, ids);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="levels-alerts-${data.exportedAt.slice(0, 10)}.json"`,
    },
  });
});
