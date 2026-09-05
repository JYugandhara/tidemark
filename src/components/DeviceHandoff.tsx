"use client";

/**
 * Moving a workspace between devices.
 *
 * The watermark — what you have already seen — lives on the server, so once
 * two devices share a workspace they genuinely agree about what is new. This
 * panel is the door between them: a six-character, single-use, five-minute
 * code, hashed at rest.
 *
 * No passwords, because an account system was not the problem worth solving
 * here; continuity was.
 */

import { useState } from "react";
import { api } from "@/lib/api";

interface Props {
  handle: string;
  onAdopted: () => void;
  onToast: (m: string) => void;
}

export function DeviceHandoff({ handle, onAdopted, onToast }: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [entered, setEntered] = useState("");
  const [busy, setBusy] = useState(false);

  async function issue() {
    setBusy(true);
    try {
      const res = await api.handoff();
      setCode(res.code);
      setExpiresIn(res.validForSeconds);
      const t = setInterval(() => {
        setExpiresIn((s) => {
          if (s <= 1) {
            clearInterval(t);
            setCode(null);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Could not issue a code");
    } finally {
      setBusy(false);
    }
  }

  async function adopt() {
    setBusy(true);
    try {
      await api.adopt(entered.trim().toUpperCase());
      setEntered("");
      onToast("This device now shares that workspace.");
      onAdopted();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "That code did not work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="module">
      <div className="module-head">
        <span className="label">workspace</span>
        <span className="num" style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-faint)" }}>
          {handle}
        </span>
      </div>
      <div className="module-body">
      <p>
        Your lists and your read position live on the server, so a second device
        sees the same &ldquo;since you last checked&rdquo; rather than starting over.
      </p>

      {code ? (
        <div style={{ marginBottom: 12 }}>
          <span className="dial-readout" style={{ letterSpacing: "0.18em", fontSize: 24 }}>
            {code}
          </span>
          <span className="label" style={{ display: "block", marginTop: 5 }}>
            enter on the other device · {expiresIn}s left
          </span>
        </div>
      ) : (
        <button className="btn" style={{ width: "100%" }} onClick={() => void issue()} disabled={busy}>
          Get a handoff code
        </button>
      )}

      <div style={{ marginTop: 10 }}>
        <input
          className="input"
          placeholder="Have a code? Enter it"
          value={entered}
          maxLength={8}
          onChange={(e) => setEntered(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && entered.length >= 4) void adopt();
          }}
          aria-label="Handoff code"
          style={{ letterSpacing: "0.14em" }}
        />
      </div>
      </div>
    </div>
  );
}
