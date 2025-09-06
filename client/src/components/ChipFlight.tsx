import { memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ChipStack from "./ChipStack";
import { amountCentsToDenoms } from "./chips";

export type ChipFlight = { id:number; x:number; y:number; dx:number; dy:number; delay:number; value:number };

export function getNavBalanceTarget(): HTMLElement | null {
  return (document.getElementById('nav-balance-target')
    || document.querySelector('.nav-balance-target')
    || document.querySelector('[data-nav-balance-target]')) as HTMLElement | null;
}

export function buildChipFlights(
  amountCents: number,
  startRect: DOMRect,
  targetEl: HTMLElement,
  opts?: { chipSize?: number; interDelay?: number; baseDelay?: number; maxChips?: number },
): { flights: ChipFlight[]; totalDelay: number } {
  const chipSize = opts?.chipSize ?? 24;
  const interDelay = opts?.interDelay ?? 80;
  const baseDelay = opts?.baseDelay ?? 0;
  const maxChips = opts?.maxChips ?? 12;
  const r = targetEl.getBoundingClientRect();
  const startX = startRect.left + startRect.width / 2 - chipSize / 2;
  const startY = startRect.top + startRect.height / 2 - chipSize / 2;
  const endX = r.left + r.width / 2 - chipSize / 2;
  const endY = r.top + r.height / 2 - chipSize / 2;
  const dx = endX - startX; const dy = endY - startY;
  const denoms = amountCentsToDenoms(amountCents, maxChips);
  const flights: ChipFlight[] = denoms.map((val, i) => ({
    id: Date.now() + i,
    x: startX,
    y: startY,
    dx,
    dy,
    delay: baseDelay + i * interDelay,
    value: val,
  }));
  const totalDelay = denoms.length > 0 ? (denoms.length - 1) * interDelay : 0;
  return { flights, totalDelay };
}

export const ChipFlightOverlay = memo(function ChipFlightOverlay({ flights, chipSize = 32, durationMs = 500 }: { flights: ChipFlight[]; chipSize?: number; durationMs?: number }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      <AnimatePresence initial={false}>
        {flights.map(ch => (
          <motion.div
            key={ch.id}
            initial={{ x: ch.x, y: ch.y, opacity: 0, scale: 0.9 }}
            animate={{ x: ch.x + ch.dx, y: ch.y + ch.dy, opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.18 } }}
            transition={{ delay: ch.delay/1000, duration: durationMs/1000, ease: "easeOut" }}
            className="absolute"
          >
            <ChipStack amountCents={ch.value * 100} chipSize={chipSize} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});

