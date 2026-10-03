/**
 * Plan / quota hook. Today every user gets the same limits (configurable by env); when subscriptions or
 * team accounts are added, resolve limits from the user's plan here — callers don't need to change.
 */
export interface PlanLimits {
  maxAlerts: number;
  maxBots: number;
  minCooldownSeconds: number;
}

export async function getLimits(_userId: string): Promise<PlanLimits> {
  return {
    maxAlerts: Number(process.env.MAX_ALERTS_PER_USER ?? 500),
    maxBots: Number(process.env.MAX_BOTS_PER_USER ?? 20),
    minCooldownSeconds: 0,
  };
}
