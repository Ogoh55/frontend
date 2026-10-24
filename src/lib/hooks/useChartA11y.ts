import { useState, type KeyboardEvent } from "react";

/**
 * Keyboard crosshair for SVG charts.
 *
 * Arrow keys step through `count` data points, Home/End jump to the ends and
 * Escape clears the crosshair. `describe` produces the text announced for the
 * active point. It is only evaluated on key presses, so charts that update
 * frequently stay silent until the user asks for a value.
 */
export function useChartA11y(count: number, describe: (index: number) => string) {
  const [active, setActive] = useState<number | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (count === 0) return;
    const current = active ?? -1;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = Math.min(count - 1, current + 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = Math.max(0, current - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      case "Escape":
        setActive(null);
        return;
      default:
        return;
    }
    e.preventDefault();
    setActive(next);
  };

  return {
    active,
    announcement: active === null ? "" : describe(active),
    onKeyDown,
  };
}
