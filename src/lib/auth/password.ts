import bcrypt from "bcryptjs";

const COST = 12;

export const hashPassword = (password: string) => bcrypt.hash(password, COST);

export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

let dummyHash: Promise<string> | null = null;

/** Burns the same CPU time as a real check when the email does not exist (prevents user enumeration by timing). */
export async function fakeVerify(password: string) {
  dummyHash ??= bcrypt.hash("timing-equaliser", COST);
  await bcrypt.compare(password, await dummyHash);
  return false;
}
