/**
 * HTTP plumbing shared by every route handler.
 *
 * One place that decides what an error looks like, so the client never has to
 * guess: a stable `{ error: { code, message, details? } }` envelope, a 409 that
 * carries the current server state so an optimistic-concurrency conflict is
 * recoverable without a refetch, and validation that reports the offending
 * field rather than "something went wrong".
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, type SessionUser } from "./session";

export type ApiErrorCode =
  | "unauthenticated"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "rate_limited"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  static unauthenticated() {
    return new ApiError("unauthenticated", "No session. Call GET /api/session first.", 401);
  }
  static notFound(what = "resource") {
    return new ApiError("not_found", `${what} not found`, 404);
  }
  static invalid(message: string, details?: unknown) {
    return new ApiError("invalid_request", message, 400, details);
  }
  static conflict(message: string, current: unknown) {
    return new ApiError("conflict", message, 409, { current });
  }
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status },
    );
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_request",
          message: "Request failed validation",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 },
    );
  }
  console.error("[api] unhandled error:", err);
  return NextResponse.json(
    { error: { code: "internal", message: "Something went wrong on our side." } },
    { status: 500 },
  );
}

/** Wrap a handler so no route ever leaks a stack trace to a client. */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw ApiError.unauthenticated();
  return user;
}

export async function parseBody<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw ApiError.invalid("Body must be valid JSON");
  }
  return schema.parse(raw);
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  const url = new URL(req.url);
  const obj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    obj[k] = v;
  });
  return schema.parse(obj);
}

export const uuid = z.string().uuid("must be a UUID");
