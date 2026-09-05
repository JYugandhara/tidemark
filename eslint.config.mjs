/**
 * Flat config. eslint-config-next 16 ships flat configs directly, so there is
 * no FlatCompat shim here — the old `compat.extends(...)` route trips over the
 * plugin object graph on this version.
 */
import next from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...(Array.isArray(next) ? next : [next]),
  ...(Array.isArray(nextCoreWebVitals) ? nextCoreWebVitals : [nextCoreWebVitals]),
  ...(Array.isArray(nextTypescript) ? nextTypescript : [nextTypescript]),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "AGENTS.md",
      "AGENT_NOTES.md",
    ],
  },
  {
    rules: {
      // The load and smoke scripts talk to a JSON API whose shapes are the
      // thing under test; `any` there is honest rather than lazy.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default config;
