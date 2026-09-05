"use client";

/**
 * Add a name to the list.
 *
 * Search is debounced, keyboard navigable, and shows each candidate's daily
 * sigma next to it — a small thing that quietly teaches the reader what the
 * ranking is going to do before they even add the instrument.
 */

import { useEffect, useRef, useState } from "react";
import { api, type SearchResultDTO } from "@/lib/api";

interface Props {
  watchlistId: string | null;
  onAdded: () => void;
  onError: (message: string) => void;
}

export function AddInstrument({ watchlistId, onAdded, onError }: Props) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchResultDTO[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 1) return;
    const t = setTimeout(async () => {
      try {
        const res = await api.search(q);
        setResults(res.results);
        setActive(0);
      } catch {
        setResults([]);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [term]);

  // Derived rather than synchronised: an empty box shows nothing without a
  // state write, so clearing the field cannot cause a cascading render.
  const visible = term.trim().length > 0 ? results : [];

  // "/" focuses search from anywhere, the way it does in every tool built for
  // people who use it all day.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function add(result: SearchResultDTO) {
    if (!watchlistId || busy) return;
    setBusy(true);
    try {
      await api.addItem(watchlistId, { instrumentId: result.id });
      setTerm("");
      setResults([]);
      onAdded();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add that instrument");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="search-wrap">
      <input
        ref={inputRef}
        className="input"
        placeholder="Add a ticker  ( / )"
        value={term}
        disabled={!watchlistId}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, visible.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && visible[active]) {
            e.preventDefault();
            void add(visible[active]);
          } else if (e.key === "Escape") {
            setTerm("");
            setResults([]);
            inputRef.current?.blur();
          }
        }}
        aria-label="Search instruments"
      />
      {visible.length > 0 && (
        <div className="search-results" role="listbox">
          {visible.map((r, i) => (
            <button
              key={r.id}
              className="search-result"
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => void add(r)}
              role="option"
              aria-selected={i === active}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <b style={{ color: "var(--text)" }}>{r.symbol}</b>{" "}
                <span style={{ color: "var(--text-faint)" }}>{r.name}</span>
              </span>
              <span style={{ color: "var(--text-ghost)", fontSize: 10, whiteSpace: "nowrap" }}>
                1σ {r.dailySigmaPct}%
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
