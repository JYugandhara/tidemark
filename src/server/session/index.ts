/**
 * Identity and cross-device continuity.
 *
 * There is no password here on purpose. What this product needs is a stable
 * *workspace* — a place your watchlists and your read cursor live — not an
 * account system, and building a half-hearted one would have been a worse
 * answer to "how does state persist across sessions and devices" than solving
 * the actual problem.
 *
 * So: an HMAC-signed, httpOnly, SameSite=Lax cookie identifies a workspace and
 * survives restarts; a short-lived, single-use, hashed-at-rest handoff code
 * moves that workspace onto a second device. Because the watermark lives on
 * the server rather than in the browser, both devices then agree on what you
 * have already seen.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { config } from "../config";
import { query, queryOne, withTransaction } from "../db/client";

export const SESSION_COOKIE = "tidemark_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface SessionUser {
  id: string;
  handle: string;
  attentionThreshold: number;
  lastCheckedAt: number;
}

/* ------------------------------------------------------------- signing -- */

function sign(payload: string): string {
  return createHmac("sha256", config.SESSION_SECRET).update(payload).digest("base64url");
}

export function issueToken(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const userId = token.slice(0, idx);
  const provided = token.slice(idx + 1);
  const expected = sign(userId);
  // Constant-time compare so a signature cannot be discovered byte by byte.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE_SECONDS,
  secure: config.NODE_ENV === "production",
};

/* -------------------------------------------------------------- lookup -- */

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const userId = verifyToken(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  return getUser(userId);
}

export async function getUser(userId: string): Promise<SessionUser | null> {
  const row = await queryOne<{
    id: string;
    handle: string;
    attention_threshold: number;
    last_checked_at: Date;
  }>(
    "SELECT id, handle, attention_threshold, last_checked_at FROM users WHERE id = $1",
    [userId],
  );
  return row
    ? {
        id: row.id,
        handle: row.handle,
        attentionThreshold: row.attention_threshold,
        lastCheckedAt: row.last_checked_at.getTime(),
      }
    : null;
}

const ADJECTIVES = ["quiet", "steady", "sharp", "patient", "curious", "calm", "keen"];
const NOUNS = ["desk", "tape", "ledger", "signal", "margin", "float", "spread"];

export async function createUser(): Promise<SessionUser> {
  const handle = `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomInt(100, 999)}`;
  const row = await queryOne<{
    id: string;
    handle: string;
    attention_threshold: number;
    last_checked_at: Date;
  }>(
    `INSERT INTO users (handle) VALUES ($1)
     RETURNING id, handle, attention_threshold, last_checked_at`,
    [handle],
  );
  return {
    id: row!.id,
    handle: row!.handle,
    attentionThreshold: row!.attention_threshold,
    lastCheckedAt: row!.last_checked_at.getTime(),
  };
}

function pick<T>(xs: readonly T[]): T {
  return xs[randomInt(0, xs.length)];
}

export async function touchUser(userId: string): Promise<void> {
  await query("UPDATE users SET last_checked_at = now() WHERE id = $1", [userId]);
}

export async function setAttentionThreshold(userId: string, value: number): Promise<void> {
  await query("UPDATE users SET attention_threshold = $2 WHERE id = $1", [
    userId,
    Math.round(Math.max(0, Math.min(100, value))),
  ]);
}

export async function registerDevice(
  userId: string,
  label: string,
  userAgent: string | null,
): Promise<void> {
  await query(
    `INSERT INTO devices (user_id, label, user_agent) VALUES ($1, $2, $3)`,
    [userId, label.slice(0, 60), userAgent?.slice(0, 300) ?? null],
  );
}

export async function listDevices(userId: string) {
  return query<{ id: string; label: string; last_seen_at: Date }>(
    `SELECT id, label, last_seen_at FROM devices
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC LIMIT 10`,
    [userId],
  );
}

/* ------------------------------------------------------------- handoff -- */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60_000;

function hashCode(code: string): string {
  return createHash("sha256")
    .update(`${config.SESSION_SECRET}:${code.toUpperCase()}`)
    .digest("hex");
}

export async function createHandoffCode(userId: string): Promise<{ code: string; expiresAt: number }> {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  const expiresAt = Date.now() + CODE_TTL_MS;
  await query(
    `INSERT INTO handoff_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (code_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at, consumed_at = NULL`,
    [hashCode(code), userId, new Date(expiresAt)],
  );
  return { code, expiresAt };
}

/**
 * Redeem a handoff code. Single-use is enforced by the UPDATE's WHERE clause,
 * so two devices racing on the same code cannot both win.
 */
export async function redeemHandoffCode(code: string): Promise<string | null> {
  return withTransaction(async (tx) => {
    const row = await tx.queryOne<{ user_id: string }>(
      `UPDATE handoff_codes SET consumed_at = now()
        WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [hashCode(code)],
    );
    return row?.user_id ?? null;
  });
}

export async function purgeExpiredHandoffCodes(): Promise<void> {
  await query("DELETE FROM handoff_codes WHERE expires_at < now() - interval '1 day'");
}
