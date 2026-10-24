"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fmtK, fmtN, seededRandom } from "../../lib/pricing";
import { useGridNavigation } from "../../lib/hooks/useGridNavigation";
import { EmptyState, ErrorState, SkeletonRegion, Skeleton } from "../../components/states";
import { Term } from "../onboarding/Term";
import type { ChainResult, ChainRow } from "./useChain";

export type TradeSide = "call" | "put";
export type TradeMode = "buy" | "write";

interface Props {
  chain: ChainResult;
  sym: string;
  expiryLabel: string;
  onTrade: (row: ChainRow, side: TradeSide, mode: TradeMode) => void;
  /** Set while the order ticket is open; focus returns to the last traded cell when it closes. */
  ticketOpen?: boolean;
}

// Wide-layout grid columns, left to right. Trade columns are the bid/ask buttons.
const GRID_COLS = 11;

// Display-only mock volume/OI — deterministic so SSR and client agree.
const mockVol = (strike: number) => Math.round(seededRandom(strike * 1000) * 200 + 20);
const mockOi = (strike: number) => Math.round(seededRandom(strike * 1000 + 7) * 5000 + 100);
const spread = (row: ChainRow, side: TradeSide) => Math.max(0.00001, row[side].premium * 0.003);

const DESKTOP_ROWS = 21;

function ChainSkeleton() {
  return (
    <SkeletonRegion label="Loading options chain" testId="chain-skeleton">
      <div className="chain-desktop">
        <div className="chain-header" />
        {Array.from({ length: DESKTOP_ROWS }, (_, i) => (
          <div key={i} className="chain-row">
            {Array.from({ length: 11 }, (_, j) => (
              <span key={j} style={{ padding: "0 6px" }}><Skeleton height={9} style={{ opacity: j === 5 ? 0.9 : 0.5 }} /></span>
            ))}
          </div>
        ))}
      </div>
      <div className="chain-mobile">
        <div className="side-toggle" aria-hidden><span style={{ flex: 1, minHeight: 44 }} /></div>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="chain-m-row" style={{ minWidth: 0 }}>
            {Array.from({ length: 6 }, (_, j) => <span key={j}><Skeleton height={10} /></span>)}
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/**
 * The options chain in all of its states. Wide containers get the classic
 * calls | strike | puts grid; narrow ones (≤640px, via container query)
 * show one side at a time with a sticky strike column and a Calls/Puts
 * toggle. Both are always rendered and CSS picks one, so there's no
 * hydration mismatch and no layout jump when the width is known.
 */
export function ChainView({ chain, sym, expiryLabel, onTrade, ticketOpen = false }: Props) {
  const [mobileSide, setMobileSide] = useState<TradeSide>("call");
  const [announcement, setAnnouncement] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const lastTrade = useRef<{ row: number; col: number } | null>(null);
  const { query, rows, source } = chain;
  const rowKeys = useMemo(() => rows.map(r => r.strike), [rows]);
  const { getCellProps, onKeyDown: navKeyDown, focusCell } = useGridNavigation({
    containerRef: gridRef, rowKeys, colCount: GRID_COLS,
  });

  // Hand focus back to the cell that opened the ticket, unless the user has already moved elsewhere.
  const wasTicketOpen = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    if (wasTicketOpen.current && !ticketOpen && lastTrade.current && (!active || active === document.body)) {
      focusCell(lastTrade.current.row, lastTrade.current.col);
    }
    wasTicketOpen.current = ticketOpen;
  }, [ticketOpen, focusCell]);

  if (source === "none") {
    return <div className="chain-container" data-tour="chain"><ChainSkeleton /></div>;
  }

  const atmIdx = rows.findIndex(r => !r.itmCall);

  // Enter/Space on a bid or ask button fires its click; remember the cell so focus can return to it.
  const trade = (row: number, col: number, fn: () => void) => () => {
    lastTrade.current = { row, col };
    fn();
  };

  // "Q" reads the focused cell's label aloud on demand. Ticks never announce on their own.
  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "q" || e.key === "Q") {
      e.preventDefault();
      setAnnouncement((e.target as HTMLElement).getAttribute("aria-label") ?? "");
      return;
    }
    navKeyDown(e);
  };

  return (
    <div className="chain-container" data-tour="chain" data-testid="chain" data-source={source}>
      {source === "model" && (
        <div style={{ padding: 8 }}>
          <ErrorState
            compact
            title="Live chain unavailable, showing model prices"
            error={query.error}
            onRetry={query.refetch}
            retrying={query.isFetching}
            testId="chain-error"
          />
        </div>
      )}
      {source === "backend" && query.status === "error" && (
        <div style={{ padding: 8 }}>
          <ErrorState compact title="Couldn't refresh the chain" error={query.error} onRetry={query.refetch} retrying={query.isFetching} testId="chain-error" />
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={`No strikes listed for ${sym} ${expiryLabel}`}
          description="There are no series open for this expiry yet. Try another expiry."
          testId="chain-empty"
        />
      ) : (
        <>
          {/* ── Wide: both sides ─────────────────────────────────────── */}
          <div className="chain-desktop" role="grid" ref={gridRef} aria-label={`${sym} ${expiryLabel} options chain`}
            aria-rowcount={rows.length + 1} aria-colcount={GRID_COLS} onKeyDown={onGridKeyDown}>
            <div className="chain-header" role="row" aria-rowindex={1}>
              <div className="ch call" role="columnheader"><Term id="volume">Vol</Term></div>
              <div className="ch call" role="columnheader"><Term id="oi">OI</Term></div>
              <div className="ch call" role="columnheader"><Term id="bid">Bid</Term></div>
              <div className="ch call" role="columnheader"><Term id="ask">Ask</Term></div>
              <div className="ch call" role="columnheader"><Term id="iv">IV</Term></div>
              <div className="ch center" role="columnheader"><Term id="strike">Strike</Term></div>
              <div className="ch put" role="columnheader"><Term id="iv">IV</Term></div>
              <div className="ch put" role="columnheader"><Term id="ask">Ask</Term></div>
              <div className="ch put" role="columnheader"><Term id="bid">Bid</Term></div>
              <div className="ch put" role="columnheader"><Term id="oi">OI</Term></div>
              <div className="ch put" role="columnheader"><Term id="volume">Vol</Term></div>
            </div>
            {rows.map((row, i) => {
              const isAtm = i === atmIdx;
              const vol = mockVol(row.strike);
              const oi = mockOi(row.strike);
              const k = fmtK(row.strike);
              const atm = isAtm ? ", at the money" : "";
              const callBid = Math.max(0, row.call.premium - spread(row, "call"));
              const callAsk = row.call.premium + spread(row, "call");
              const putBid = Math.max(0, row.put.premium - spread(row, "put"));
              const putAsk = row.put.premium + spread(row, "put");
              const metric = (col: number, side: TradeSide, text: string, label: string, className: string) => (
                <div role="gridcell" className={className} aria-label={`${sym} ${k} ${side}${atm}, ${label} ${text}`}
                  {...getCellProps(i, col)}>{text}</div>
              );
              return (
                <div key={row.strike} role="row" aria-rowindex={i + 2}
                  className={`chain-row${row.itmCall ? " itm-call" : ""}${row.itmPut ? " itm-put" : ""}`}
                  style={{ background: isAtm ? "var(--atm-dim)" : undefined }}>
                  {metric(0, "call", String(vol), "volume", "cc")}
                  {metric(1, "call", oi.toLocaleString(), "open interest", "cc")}
                  <div role="gridcell" style={{ display: "contents" }}>
                    <button type="button" className="cc tradeable call" title="Click to write (sell)" {...getCellProps(i, 2)}
                      aria-label={`Write ${sym} ${k} call at bid ${fmtN(callBid)}, delta ${row.call.delta.toFixed(2)}${atm}`}
                      onClick={trade(i, 2, () => onTrade(row, "call", "write"))}>
                      {fmtN(callBid)}
                    </button>
                  </div>
                  <div role="gridcell" style={{ display: "contents" }}>
                    <button type="button" className="cc tradeable call" title="Click to buy" {...getCellProps(i, 3)}
                      aria-label={`Buy ${sym} ${k} call at ask ${fmtN(callAsk)}, delta ${row.call.delta.toFixed(2)}${atm}`}
                      onClick={trade(i, 3, () => onTrade(row, "call", "buy"))}>
                      {fmtN(callAsk)}
                    </button>
                  </div>
                  {metric(4, "call", (row.call.iv * 100).toFixed(1), "implied volatility percent", "cc brand")}
                  <div role="gridcell" className={`strike-cell${isAtm ? " atm" : ""}`}
                    aria-label={`${sym} strike ${k}${atm}`} {...getCellProps(i, 5)}>
                    {k}
                    {isAtm && <div style={{ fontSize: 7, marginTop: 1, opacity: 0.6 }}>ATM</div>}
                  </div>
                  {metric(6, "put", (row.put.iv * 100).toFixed(1), "implied volatility percent", "cc brand")}
                  <div role="gridcell" style={{ display: "contents" }}>
                    <button type="button" className="cc tradeable put" title="Click to buy" {...getCellProps(i, 7)}
                      aria-label={`Buy ${sym} ${k} put at ask ${fmtN(putAsk)}, delta ${row.put.delta.toFixed(2)}${atm}`}
                      onClick={trade(i, 7, () => onTrade(row, "put", "buy"))}>
                      {fmtN(putAsk)}
                    </button>
                  </div>
                  <div role="gridcell" style={{ display: "contents" }}>
                    <button type="button" className="cc tradeable put" title="Click to write (sell)" {...getCellProps(i, 8)}
                      aria-label={`Write ${sym} ${k} put at bid ${fmtN(putBid)}, delta ${row.put.delta.toFixed(2)}${atm}`}
                      onClick={trade(i, 8, () => onTrade(row, "put", "write"))}>
                      {fmtN(putBid)}
                    </button>
                  </div>
                  {metric(9, "put", oi.toLocaleString(), "open interest", "cc")}
                  {metric(10, "put", String(vol), "volume", "cc")}
                </div>
              );
            })}
          </div>
          <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

          {/* ── Narrow: one side, sticky strike ──────────────────────── */}
          <div className="chain-mobile" data-testid="chain-mobile">
            <div className="side-toggle" role="group" aria-label="Show calls or puts">
              <button type="button" className="call" aria-pressed={mobileSide === "call"} onClick={() => setMobileSide("call")}>CALLS</button>
              <button type="button" className="put" aria-pressed={mobileSide === "put"} onClick={() => setMobileSide("put")}>PUTS</button>
            </div>
            <div className="chain-mobile-scroll" data-swipe-ignore>
              <div className="chain-m-row head">
                <span className="m-strike"><Term id="strike">Strike</Term></span>
                <span><Term id="bid">Bid</Term></span>
                <span><Term id="ask">Ask</Term></span>
                <span><Term id="iv">IV</Term></span>
                <span><Term id="delta">Δ</Term></span>
                <span><Term id="oi">OI</Term></span>
              </div>
              {rows.map((row, i) => {
                const g = row[mobileSide];
                const itm = mobileSide === "call" ? row.itmCall : row.itmPut;
                const sp = spread(row, mobileSide);
                const k = fmtK(row.strike);
                const sideLabel = mobileSide === "call" ? "call" : "put";
                return (
                  <div key={row.strike}
                    className={`chain-m-row${i === atmIdx ? " atm" : ""}${itm ? " itm" : ""}${mobileSide === "put" ? " put-side" : ""}`}>
                    <span className="m-strike">
                      {k}{i === atmIdx && <small style={{ fontSize: 8, marginLeft: 4, opacity: 0.7 }}>ATM</small>}
                    </span>
                    <button type="button" className="m-trade" aria-label={`Write ${sym} ${k} ${sideLabel} at bid ${fmtN(Math.max(0, g.premium - sp))}`}
                      onClick={() => onTrade(row, mobileSide, "write")}>{fmtN(Math.max(0, g.premium - sp))}</button>
                    <button type="button" className="m-trade" aria-label={`Buy ${sym} ${k} ${sideLabel} at ask ${fmtN(g.premium + sp)}`}
                      onClick={() => onTrade(row, mobileSide, "buy")}
                      style={{ color: mobileSide === "call" ? "var(--call)" : "var(--put)" }}>{fmtN(g.premium + sp)}</button>
                    <span style={{ color: "var(--brand)" }}>{(g.iv * 100).toFixed(1)}</span>
                    <span>{g.delta.toFixed(2)}</span>
                    <span>{mockOi(row.strike).toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
