/**
 * Capture the README imagery against a running server.
 *
 *   npm run start          # in another shell
 *   node scripts/shots.mjs docs/screenshots
 *
 * Deliberately a script rather than a manual pass: the screenshots in the
 * README should be reproducible from the same seeded simulator that everything
 * else in this repo is.
 */

import { mkdirSync } from "node:fs";

// Playwright is deliberately NOT a dependency of this project — it would add a
// few hundred megabytes to `npm ci` for something only used to regenerate the
// README imagery. Install it yourself when you want to run this.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "This script needs Playwright, which is not a project dependency.\n" +
      "  npm i -g playwright && npx playwright install chromium\n",
  );
  process.exit(1);
}

const out = process.argv[2] ?? "docs/screenshots";
const base = process.env.BASE_URL ?? "http://localhost:3000";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});

async function shot(name, width, height, fn) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(3500);
  if (fn) await fn(page);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  await ctx.close();
  console.log("wrote", name);
}

const setThreshold = (v) => async (page) => {
  await page.evaluate(
    async (threshold) => {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attentionThreshold: threshold }),
      });
    },
    v,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
};

// The default view: some things above the line, the rest held back.
await shot("active", 1512, 1000);

// The quiet state — the one the product is actually arguing for.
await shot("quiet", 1512, 1000, setThreshold(100));

// The score taking itself apart.
await shot("why", 1512, 1150, async (page) => {
  const b = page.locator("button", { hasText: "why is this here?" }).first();
  if (await b.count()) {
    await b.click();
    await page.waitForTimeout(700);
    await page.locator(".why").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  }
});

await shot("mobile", 420, 900);

await browser.close();
