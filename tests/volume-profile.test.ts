import { describe, expect, it } from "vitest";
import { VOLUME_BUCKETS, buildBaseline, defaultVolumeProfile } from "@/core/significance/baseline";
import {
  bucketFor,
  foldObservedProfile,
  sessionShares,
} from "@/core/significance/volume-profile";
import { expectedVolumeShare } from "@/core/significance/detect";

/** A U-shaped session: heavy open, quiet midday, heavy close. */
function syntheticSession(total = 1_000_000): Array<number | null> {
  const profile = defaultVolumeProfile();
  const cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < VOLUME_BUCKETS; i++) {
    acc += profile[i] * total;
    cum.push(Math.round(acc));
  }
  return cum;
}

describe("bucketing", () => {
  it("maps session progress onto 25 fifteen-minute buckets", () => {
    expect(bucketFor(0)).toBe(0);
    expect(bucketFor(0.5)).toBe(12);
    expect(bucketFor(1)).toBe(VOLUME_BUCKETS - 1);
    expect(bucketFor(1.7)).toBe(VOLUME_BUCKETS - 1);
    expect(bucketFor(-2)).toBe(0);
    expect(bucketFor(Number.NaN)).toBe(0);
  });
});

describe("turning a session into shares", () => {
  it("recovers the shape it was generated from", () => {
    const shares = sessionShares(syntheticSession())!;
    expect(shares).toHaveLength(VOLUME_BUCKETS);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const expected = defaultVolumeProfile();
    for (let i = 0; i < VOLUME_BUCKETS; i++) {
      expect(shares[i]).toBeCloseTo(expected[i], 3);
    }
  });

  it("carries forward across missing buckets rather than inventing zeros", () => {
    const cum = syntheticSession();
    cum[5] = null;
    cum[6] = null;
    const shares = sessionShares(cum)!;
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(shares.every((s) => s >= 0)).toBe(true);
    // The two missing buckets show nothing traded, and bucket 7 absorbs it.
    expect(shares[5]).toBeCloseTo(0, 9);
    expect(shares[6]).toBeCloseTo(0, 9);
  });

  it("refuses a half-observed session", () => {
    const cum: Array<number | null> = Array(VOLUME_BUCKETS).fill(null);
    for (let i = 0; i < 10; i++) cum[i] = (i + 1) * 1000;
    expect(sessionShares(cum)).toBeNull();
  });

  it("refuses a session with no volume, and a wrong-length input", () => {
    expect(sessionShares(Array(VOLUME_BUCKETS).fill(0))).toBeNull();
    expect(sessionShares(Array(10).fill(5))).toBeNull();
  });

  it("never produces a negative share when a provider resets its counter", () => {
    const cum = syntheticSession();
    cum[15] = 1; // counter reset mid-session
    const shares = sessionShares(cum)!;
    expect(shares.every((s) => s >= 0)).toBe(true);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe("folding sessions into a running mean", () => {
  it("starts from the first session", () => {
    const s = sessionShares(syntheticSession())!;
    const folded = foldObservedProfile(null, s);
    expect(folded.samples).toBe(1);
    expect(folded.shares).toEqual(s);
  });

  it("converges on the truth and stays normalised", () => {
    const truth = defaultVolumeProfile();
    let acc = foldObservedProfile(null, truth);
    for (let i = 0; i < 60; i++) {
      // Noisy sessions around the true shape.
      const noisy = truth.map((x, k) => x * (1 + 0.3 * Math.sin(i * 7 + k)));
      const total = noisy.reduce((a, b) => a + b, 0);
      acc = foldObservedProfile(acc, noisy.map((x) => x / total));
    }
    expect(acc.samples).toBe(61);
    expect(acc.shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (let i = 0; i < VOLUME_BUCKETS; i++) {
      expect(acc.shares[i]).toBeCloseTo(truth[i], 2);
    }
  });

  it("moves by 1/n, so one odd day cannot rewrite the shape", () => {
    const truth = defaultVolumeProfile();
    let acc = foldObservedProfile(null, truth);
    for (let i = 0; i < 99; i++) acc = foldObservedProfile(acc, truth);
    const flat = Array(VOLUME_BUCKETS).fill(1 / VOLUME_BUCKETS);
    const after = foldObservedProfile(acc, flat);
    expect(Math.abs(after.shares[0] - truth[0])).toBeLessThan(truth[0] * 0.02);
  });

  it("caps the sample count so the mean stays adaptive over years", () => {
    let acc = foldObservedProfile(null, defaultVolumeProfile());
    for (let i = 0; i < 800; i++) acc = foldObservedProfile(acc, defaultVolumeProfile());
    expect(acc.samples).toBeLessThanOrEqual(500);
  });

  it("ignores a malformed session", () => {
    const acc = foldObservedProfile(null, [0.5, 0.5]);
    expect(acc.samples).toBe(0);
  });
});

describe("the blend takes over as evidence accumulates", () => {
  const bars = Array.from({ length: 80 }, (_, i) => ({
    date: `2026-0${1 + Math.floor(i / 31)}-${String((i % 28) + 1).padStart(2, "0")}`,
    open: 100,
    high: 101,
    low: 99,
    close: 100 + Math.sin(i),
    volume: 1_000_000,
  }));

  // A deliberately un-U-shaped instrument: it trades evenly all day.
  const flat = Array(VOLUME_BUCKETS).fill(1 / VOLUME_BUCKETS);

  it("leans on the generic curve with three sessions of evidence", () => {
    const b = buildBaseline({
      instrumentId: "x",
      bars,
      observedProfile: { shares: flat, samples: 3 },
      now: 0,
    });
    const generic = defaultVolumeProfile();
    // The opening bucket should still look much more like the U-shape.
    expect(b.volumeProfile[0]).toBeGreaterThan((generic[0] + flat[0]) / 2);
  });

  it("leans on the instrument's own shape after a couple of months", () => {
    const b = buildBaseline({
      instrumentId: "x",
      bars,
      observedProfile: { shares: flat, samples: 200 },
      now: 0,
    });
    const generic = defaultVolumeProfile();
    const blended = b.volumeProfile[0];
    // The blend is capped at 90% observed on purpose — the generic prior is
    // never fully discarded — so assert it has moved decisively towards the
    // instrument's own shape rather than all the way to it.
    expect(Math.abs(blended - flat[0])).toBeLessThan(Math.abs(blended - generic[0]) / 5);
    expect(b.volumeProfile.reduce((a, c) => a + c, 0)).toBeCloseTo(1, 9);
  });

  it("changes what counts as a volume surge", () => {
    const generic = buildBaseline({ instrumentId: "x", bars, now: 0 }).volumeProfile;
    const learned = buildBaseline({
      instrumentId: "x",
      bars,
      observedProfile: { shares: flat, samples: 200 },
      now: 0,
    }).volumeProfile;

    // A tenth of the way through the day, the generic curve expects far more
    // volume to have traded than an evenly-trading instrument would produce.
    expect(expectedVolumeShare(generic, 0.1)).toBeGreaterThan(
      expectedVolumeShare(learned, 0.1) * 1.5,
    );
  });
});
