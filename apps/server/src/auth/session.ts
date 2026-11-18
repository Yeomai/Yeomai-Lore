import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "@lore-portal/shared";
import { forbidden, unauthorized } from "@lore-portal/shared";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/index.ts";
import { randomToken, hashToken } from "./random.ts";
import { findUserById } from "./users.ts";
import { nowIso } from "../db/index.ts";

export const SESSION_COOKIE = "lore_portal_session";

interface SessionRow {
  user_id: string;
}

export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(48);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
    await this.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [id, userId, hashToken(token), expiresAt],
    );
    return { token, expiresAt };
  }

  async resolve(token: string | undefined): Promise<SessionUser | null> {
    if (!token) {
      return null;
    }
    const result = await this.db.query<SessionRow>(
      `SELECT user_id
         FROM sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > $2`,
      [hashToken(token), nowIso()],
    );
    const row = result.rows[0];
    return row ? findUserById(this.db, row.user_id) : null;
  }

  async revoke(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    await this.db.query(
      `UPDATE sessions SET revoked_at = $2
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token), nowIso()],
    );
  }

  setCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.publicUrl.startsWith("https://"),
      expires: expiresAt,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}

export async function requireSessionUser(
  request: FastifyRequest,
): Promise<SessionUser> {
  if (!request.sessionUser) {
    throw unauthorized();
  }
  return request.sessionUser;
}

export async function requireAdmin(
  request: FastifyRequest,
): Promise<SessionUser> {
  const user = await requireSessionUser(request);
  if (user.globalRole !== "admin") {
    throw forbidden("Administrator access is required");
  }
  return user;
}
