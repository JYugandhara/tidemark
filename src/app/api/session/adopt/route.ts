/**
 * Redeem a handoff code on a second device.
 *
 * The code is single-use and expires in five minutes; redemption is a
 * conditional UPDATE, so two devices racing on the same code cannot both end
 * up holding the workspace.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handler, parseBody } from "@/server/http";
import {
  SESSION_COOKIE,
  cookieOptions,
  getUser,
  issueToken,
  redeemHandoffCode,
  registerDevice,
} from "@/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  code: z.string().trim().min(4).max(12),
  deviceLabel: z.string().min(1).max(60).optional(),
});

export const POST = handler(async (req: Request) => {
  const { code, deviceLabel } = await parseBody(req, Body);
  const userId = await redeemHandoffCode(code);
  if (!userId) {
    throw ApiError.invalid("That code is not valid any more. Generate a fresh one.");
  }
  const user = await getUser(userId);
  if (!user) throw ApiError.notFound("workspace");

  await registerDevice(userId, deviceLabel ?? "adopted device", req.headers.get("user-agent"));
  const res = NextResponse.json({ user, adopted: true });
  res.cookies.set(SESSION_COOKIE, issueToken(userId), cookieOptions);
  return res;
});
