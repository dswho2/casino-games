import { memo, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import Chip from "./Chip";
import { amountCentsToDenoms, chipImageHeight, chipStackStep } from "./chips";

type Props = {
  amountCents: number;
  chipSize?: number;        // visual diameter
  maxPerColumn?: number;    // chips per column before starting a new column
  columnGap?: number;       // gap between columns
  align?: "left" | "center" | "right";
  maxColumns?: number;      // limit number of piles rendered
  className?: string;
};

export default memo(function ChipStack({
  amountCents,
  chipSize = 28,
  maxPerColumn = 12,
  columnGap = 12,
  align = "center",
  maxColumns = 3,
  className,
}: Props) {
  // Expand into chip denominations
  const chips = useMemo(
    () => amountCentsToDenoms(amountCents, maxColumns * maxPerColumn),
    [amountCents, maxColumns, maxPerColumn]
  );

  // Geometry for image-based chip (image height ~ size/2). Step controls vertical overlap.
  const imgH = chipImageHeight(chipSize);
  const step = chipStackStep(chipSize);
  const chipH = imgH;

  // Split into columns
  const columns = useMemo(() => {
    const cols: number[][] = [];
    for (let i = 0; i < chips.length; i += maxPerColumn) cols.push(chips.slice(i, i + maxPerColumn));
    return cols;
  }, [chips, maxPerColumn]);

  const visibleColumnsRaw = columns.slice(0, Math.max(1, maxColumns));
  const visibleColumns = reorderForMiddleLowest(visibleColumnsRaw);

  // Container size (no clipping)
  const colW = chipSize * 0.55; // slightly narrower to encourage overlap
  const baseOverlap = Math.round(chipSize * 0.28);
  // Slightly less overlap than original (was -baseOverlap)
  const gap = visibleColumns.length > 1 ? -Math.round(baseOverlap * 0.9) : columnGap;
  // Very small outward nudge for side piles
  const sideSpread = visibleColumns.length === 3 ? Math.round(chipSize * 0.06) : 0;
  const totalColsWidth =
    visibleColumns.length * colW + Math.max(0, visibleColumns.length - 1) * gap + (sideSpread ? sideSpread * 2 : 0);
  const width = Math.max(colW, totalColsWidth);
  const height = visibleColumns.reduce((h, col) => Math.max(h, chipH + (col.length - 1) * step), chipH);

  // Starting X based on align
  const startX =
    align === "left" ? 0 :
    align === "right" ? (width - totalColsWidth) :
    (width - totalColsWidth) / 2;

  return (
    <div
      className={clsx("relative inline-block", className)}
      style={{ width, height, overflow: "visible", zIndex: 1 }}
    >
      <AnimatePresence initial={false}>
        {visibleColumns.map((col, ci) => {
          const spreadOffset = visibleColumns.length === 3 ? (ci === 0 ? -sideSpread : ci === 2 ? sideSpread : 0) : 0;
          const left = startX + ci * (colW + gap) + spreadOffset;
          const mid = Math.floor(visibleColumns.length / 2);
          const z = ci === mid ? 3 : 2; // middle pile above others
          const yOffset = ci === mid ? Math.round(chipSize * 0.10) : 0; // drop middle slightly for depth

          // Give the column a measurable width for easier devtools inspection
          return (
            <div key={ci} className="absolute bottom-0 left-0" style={{ left, width: colW, zIndex: z, transform: `translateY(${yOffset}px)` }}>
              {/* draw from bottom up */}
              {col.map((denom, i) => {
                const y = i * step; // vertical step per chip
                const jitter = jitterFor(ci, i, denom, chipSize);
                return (
                  <motion.div
                    key={`${ci}-${i}-${denom}`}
                    initial={{ y: chipH, opacity: 0 }}
                    animate={{ y: -y, opacity: 1 }}
                    exit={{ y: chipH, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 24 }}
                    style={{ position: "absolute", bottom: 0, left: jitter, width: chipSize, height: chipH }}
                  >
                    <Chip denom={denom} size={chipSize} />
                  </motion.div>
                );
              })}
            </div>
          );
        })}
      </AnimatePresence>
    </div>
  );
});

function jitterFor(ci: number, i: number, denom: number, chipSize: number) {
  // Pseudo-random but stable per chip: avoids flicker while looking natural
  const unit = Math.max(1, Math.round(chipSize * 0.02)); // ~2% of size
  let s = (ci + 1) * 374761393 + (i + 1) * 668265263 + (denom + 1) * 2147483647;
  s = (s ^ (s >>> 13)) * 1274126177;
  s ^= s >>> 16;
  const r = (s >>> 0) / 4294967295; // 0..1
  const maxUnits = 3; // up to ~3 * unit px left/right
  const offset = Math.round((r * 2 - 1) * maxUnits) * unit; // symmetric [-3..+3] * unit
  return offset;
}

function reorderForMiddleLowest<T>(cols: T[]): T[] {
  if (cols.length === 3) return [cols[0], cols[2], cols[1]];
  return cols;
}
