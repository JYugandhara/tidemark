/**
 * Session bootstrap.
 *
 * Called once when the app loads. Returns the existing workspace if the cookie
 * is valid, otherwise mints a new one and seeds it with a starter watchlist so
 * a first-time visitor lands on a working product rather than an empty state
 * with a search box.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { handler, json, parseBody } from "@/server/http";
import {
  SESSION_COOKIE,
  cookieOptions,
  createUser,
  currentUser,
  issueToken,
  listDevices,
  registerDevice,
  touchUser,
} from "@/server/session";
import { seedStarterWatchlist } from "@/server/services/onboarding";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({ deviceLabel: z.string().min(1).max(60).optional() })
  .optional();

export const GET = handler(async () => {
  const existing = await currentUser();
  if (existing) {
    await touchUser(existing.id);
    return json({
      user: existing,
      isNew: false,
      devices: await listDevices(existing.id),
    });
  }
  const user = await createUser();
  await seedStarterWatchlist(user.id);
  const res = NextResponse.json({ user, isNew: true, devices: [] });
  res.cookies.set(SESSION_COOKIE, issueToken(user.id), cookieOptions);
  return res;
});

/** Same as GET, but lets the client name the device it is running on. */
export const POST = handler(async (req: Request) => {
  const body = (await parseBody(req, BodySchema)) ?? {};
  const label = body.deviceLabel ?? "this device";
  const ua = req.headers.get("user-agent");

  const existing = await currentUser();
  if (existing) {
    await touchUser(existing.id);
    await registerDevice(existing.id, label, ua);
    return json({ user: existing, isNew: false, devices: await listDevices(existing.id) });
  }
  const user = await createUser();
  await seedStarterWatchlist(user.id);
  await registerDevice(user.id, label, ua);
  const res = NextResponse.json({ user, isNew: true, devices: await listDevices(user.id) });
  res.cookies.set(SESSION_COOKIE, issueToken(user.id), cookieOptions);
  return res;
});
