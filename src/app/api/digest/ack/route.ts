/**
 * Acknowledge: "I have seen this."
 *
 * Two things move together, in one transaction:
 *
 *   1. Per-event acknowledgement rows for exactly the events the client
 *      rendered. This is the correctness backstop.
 *   2. The per-instrument cursor, jumped forward only as far as the settling
 *      boundary allows, so an event whose sequence number was allocated before
 *      a higher one but committed after it cannot be skipped.
 *
 * The reference price is taken from the quote the client was actually showing,
 * not from the server's current price, because "since you last checked" has to
 * mean the number that was on the screen.
 */

import { z } from "zod";
import { handler, json, requireUser } from "@/server/http";
import { withTransaction } from "@/server/db/client";
import { acknowledgeEvents, safeAckBoundary } from "@/server/repo/events";
import { advanceWatermarks, type WatermarkAdvance } from "@/server/repo/watermarks";
import { touchUser } from "@/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  entries: z
    .array(
      z.object({
        instrumentId: z.string().uuid(),
        refPrice: z.number().positive().nullable(),
        refAsOf: z.number().int().nonnegative().nullable(),
        refDirection: z.enum(["up", "down", "flat"]).default("flat"),
        seq: z.number().int().nonnegative().default(0),
        eventIds: z.array(z.string().uuid()).max(200).default([]),
      }),
    )
    .max(500),
  /** Also refresh "last checked", which drives the absence boost. */
  touch: z.boolean().default(true),
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = Body.parse(await req.json());

  const result = await withTransaction(async (tx) => {
    const boundary = await safeAckBoundary(tx);
    const eventIds = [...new Set(body.entries.flatMap((e) => e.eventIds))];
    await acknowledgeEvents(tx, user.id, eventIds);

    const advances: WatermarkAdvance[] = body.entries.map((e) => ({
      instrumentId: e.instrumentId,
      refPrice: e.refPrice,
      refAsOf: e.refAsOf,
      refDirection: e.refDirection,
      seq: e.seq,
    }));
    const updated = await advanceWatermarks(tx, user.id, advances, boundary);
    return { boundary, acknowledged: eventIds.length, watermarks: updated };
  });

  if (body.touch) await touchUser(user.id);
  return json(result);
});
