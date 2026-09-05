/** Formatting helpers shared across the UI. Presentation only, no logic. */

const inr = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compact = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function money(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `₹${inr.format(x)}`;
}

export function signedPct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const v = x * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}

export function sigma(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${x.toFixed(1)}σ`;
}

export function volume(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return compact.format(x);
}

export function direction(x: number | null | undefined): "up" | "down" | "flat" {
  if (x === null || x === undefined || !Number.isFinite(x) || Math.abs(x) < 1e-9) return "flat";
  return x > 0 ? "up" : "down";
}

export function relative(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "moments ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** "PRICE_MOVE" -> "Price move" */
export function humanKind(kind: string): string {
  const s = kind.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function humanEvidenceKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/Pct/g, "%");
}

/** Epoch-millisecond fields must not be formatted as if they were quantities. */
const TIMESTAMP_KEYS = /(^|[a-z])(asOf|At|Time)$/;

export function formatEvidenceValue(v: unknown, key = ""): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (TIMESTAMP_KEYS.test(key) && v > 1e12) {
      return new Date(v).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    if (Math.abs(v) >= 1e6) return compact.format(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(v);
}
