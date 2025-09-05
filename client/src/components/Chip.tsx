import { memo } from "react";
import clsx from "clsx";
import { chipColorFor, chipSrc, chipImageHeight } from "./chips";

export type ChipProps = {
  denom: number;
  size?: number; // pixel width of the chip image
  className?: string;
  alt?: string;
};

/**
 * Image-based casino chip.
 * Looks for a WebP in /public/chips named `${color}_chip.webp`.
 */
function Chip({ denom, size = 48, className, alt }: ChipProps) {
  const color = chipColorFor(denom);
  const src = chipSrc(color);
  const h = chipImageHeight(size);
  // Decorative by default; the dollar value is conveyed elsewhere in text
  const isDecorative = !alt;
  return (
    <img
      src={src}
      alt={alt ?? ""}
      aria-hidden={isDecorative}
      width={size}
      height={h}
      draggable={false}
      loading="eager"
      className={clsx("select-none pointer-events-none", className)}
      style={{ display: "block", width: size, height: h }}
    />
  );
}

export default memo(Chip);
