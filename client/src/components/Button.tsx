import type { ComponentProps } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";

type MotionButtonProps = ComponentProps<typeof motion.button> & {
  variant?: "primary" | "secondary";
};

export default function Button({ className, children, variant = "primary", ...rest }: MotionButtonProps) {
  const isPrimary = variant === "primary";
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      whileHover={{ y: -1 }}
      className={clsx(
        "ripple rounded-lg px-4 py-2 font-medium disabled:opacity-50",
        isPrimary
          ? "bg-accent/90 text-black hover:bg-accent shadow-glow"
          : "bg-card text-white border border-white/10 hover:border-accent shadow-none",
        className
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
