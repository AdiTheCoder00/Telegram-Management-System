"use client";

import { ConditionDebugger } from "@/components/alerts/condition-debugger";

export function AlertDebugger({ alertId }: { alertId: string }) {
  return <ConditionDebugger body={() => ({ alertId })} />;
}
