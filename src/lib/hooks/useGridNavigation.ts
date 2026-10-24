import { useCallback, useState, type KeyboardEvent, type RefObject } from "react";

interface Options {
  /** Container holding the cells; cells are found by `data-cell-row` / `data-cell-col`. */
  containerRef: RefObject<HTMLElement | null>;
  /** Stable identity per row (e.g. strike). Focus follows this key when rows reorder or change. */
  rowKeys: readonly (string | number)[];
  colCount: number;
  /** Rows moved by PageUp / PageDown. */
  pageSize?: number;
}

interface Cursor {
  key: string | number | null;
  row: number;
  col: number;
}

const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), Math.max(max, 0));

/**
 * Roving-tabindex navigation for an ARIA grid (APG grid pattern). Independent of
 * rendering: the caller spreads `getCellProps` onto each focusable cell and
 * wires `onKeyDown` to the grid container. Only the active cell is in the tab order.
 */
export function useGridNavigation({ containerRef, rowKeys, colCount, pageSize = 10 }: Options) {
  const [cursor, setCursor] = useState<Cursor>({ key: null, row: 0, col: 0 });

  // Prefer the row whose key is still present so focus sticks to the same strike.
  const keyIndex = cursor.key === null ? -1 : rowKeys.indexOf(cursor.key);
  const activeRow = keyIndex >= 0 ? keyIndex : clamp(cursor.row, rowKeys.length - 1);
  const activeCol = clamp(cursor.col, colCount - 1);

  const focusCell = useCallback((row: number, col: number) => {
    const r = clamp(row, rowKeys.length - 1);
    const c = clamp(col, colCount - 1);
    containerRef.current?.querySelector<HTMLElement>(`[data-cell-row="${r}"][data-cell-col="${c}"]`)?.focus();
  }, [containerRef, rowKeys.length, colCount]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const last = rowKeys.length - 1;
    let row = activeRow;
    let col = activeCol;
    switch (e.key) {
      case "ArrowUp": row -= 1; break;
      case "ArrowDown": row += 1; break;
      case "ArrowLeft": col -= 1; break;
      case "ArrowRight": col += 1; break;
      case "PageUp": row -= pageSize; break;
      case "PageDown": row += pageSize; break;
      case "Home": if (ctrl) row = 0; col = 0; break;
      case "End": if (ctrl) row = last; col = colCount - 1; break;
      default: return;
    }
    e.preventDefault();
    focusCell(row, col);
  }, [activeRow, activeCol, rowKeys.length, colCount, pageSize, focusCell]);

  const getCellProps = useCallback((row: number, col: number) => ({
    tabIndex: row === activeRow && col === activeCol ? 0 : -1,
    "data-cell-row": row,
    "data-cell-col": col,
    onFocus: () => setCursor({ key: rowKeys[row] ?? null, row, col }),
  }), [activeRow, activeCol, rowKeys]);

  return { getCellProps, onKeyDown, focusCell };
}
