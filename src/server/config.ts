/**
 * Configuration, validated once at module load.
 *
 * A missing or malformed environment variable should fail loudly at boot, not
 * as `undefined` three layers down inside a request that a user is waiting on.
 */

import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required — see .env.example")
    .default("postgresql://pulse:pulse@127.0.0.1:5432/pulse"),
  PGSSL: bool(false),

  /** Secret used to sign the session cookie. Must be set in any real deploy. */
  SESSION_SECRET: z.string().min(16).default("dev-only-secret-change-me-please"),

  /** Ordered provider preference, first is primary. */
  MARKET_PROVIDERS: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.split(",").map((s) => s.trim()) : ["simulated"])),

  /** Optional real-feed credentials. Absent means that provider is skipped. */
  FINNHUB_API_KEY: z.string().optional(),

  /** Seed for the deterministic simulator; same seed gives the same market. */
  SIM_SEED: int(20260904),
  /** Multiplier on simulated volatility, for demos. */
  SIM_VOLATILITY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 1 : Number(v)))
    .pipe(z.number().min(0).max(20)),
  /** Force the simulator to behave as if the market were open, for demos. */
  SIM_ALWAYS_OPEN: bool(true),

  /** Poll cadences in milliseconds, per tier. */
  POLL_HOT_MS: int(5_000, 1_000),
  POLL_WARM_MS: int(60_000, 1_000),
  POLL_COLD_MS: int(900_000, 1_000),

  /** Max symbols per upstream request. */
  QUOTE_BATCH_SIZE: int(50, 1, 500),
  /** Worker loop tick. */
  WORKER_TICK_MS: int(1_000, 200),
  /** Run the ingestion loop inside the web process (convenient in dev). */
  RUN_WORKER_IN_WEB: bool(true),

  /** Circuit breaker tuning. */
  BREAKER_FAILURE_THRESHOLD: int(5, 1),
  BREAKER_OPEN_MS: int(30_000, 1_000),
  PROVIDER_TIMEOUT_MS: int(4_000, 100),
  PROVIDER_MAX_RETRIES: int(2, 0, 6),

  /** Rows of tape kept per instrument for sparklines. */
  TAPE_LENGTH: int(180, 10, 5_000),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = load();

export const isProd = config.NODE_ENV === "production";
