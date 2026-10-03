/** An error whose message is safe to show to end users. */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Resource") => new AppError(404, `${what} not found.`, "not_found");
export const unauthorized = () => new AppError(401, "Please sign in to continue.", "unauthorized");
export const forbidden = (msg = "You do not have permission to do that.") => new AppError(403, msg, "forbidden");
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, "bad_request", details);
export const tooManyRequests = (retryAfterSec: number) =>
  new AppError(429, `Too many requests. Please try again in ${retryAfterSec}s.`, "rate_limited", { retryAfterSec });
