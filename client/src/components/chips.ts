// Centralized chip configuration and helpers

// Include high-denomination chips so orange/yellow appear for large pots
export const CHIP_DENOMS = [5000, 1000, 500, 100, 25, 10, 5, 1] as const;
export type Denomination = (typeof CHIP_DENOMS)[number];

// Standard casino mapping; adjust as your art set requires
export const DENOM_TO_COLOR: Record<number, string> = {
  1: "white",
  5: "red",
  10: "blue",
  25: "green",
  100: "black",
  500: "purple",
  1000: "orange",
  5000: "yellow",
};

export function chipColorFor(denom: number): string {
  if (DENOM_TO_COLOR[denom]) return DENOM_TO_COLOR[denom];
  // Choose nearest lower known denom color as a sensible fallback
  for (const d of [5000, 1000, 500, 100, 25, 10, 5, 1]) if (denom >= d) return DENOM_TO_COLOR[d];
  return "white";
}

export function chipSrc(color: string): string {
  // Use Vite base in case app mounts under a sub-path
  const base = import.meta.env.BASE_URL ?? "/";
  return `${base}chips/${color}_chip.webp`;
}

// Expand an amount in cents into chip denominations (dollars only)
export function amountCentsToDenoms(amountCents: number, maxChips = Infinity): number[] {
  const dollars = Math.max(0, Math.floor(amountCents / 100));
  const out: number[] = [];
  let remain = dollars;
  for (const d of CHIP_DENOMS) {
    while (remain >= d && out.length < maxChips) { out.push(d); remain -= d; }
  }
  if (out.length === 0 && dollars > 0) out.push(1);
  return out;
}

// Geometry helpers for image-based chips
export function chipImageHeight(size: number) { return Math.round(size / 2); }
// Tighter vertical spacing for a denser, realistic stack
export function chipStackStep(size: number) {
  const imgH = chipImageHeight(size);
  return Math.max(1, Math.round(imgH * 0.16));
}
