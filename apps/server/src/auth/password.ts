import { hash, verify, type Options } from "@node-rs/argon2";

const options: Options = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 6) {
    throw new Error("Password must contain at least 6 characters");
  }
  return hash(password, options);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password, options);
  } catch {
    return false;
  }
}
