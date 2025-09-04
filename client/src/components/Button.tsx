import type { ComponentProps } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";

type MotionButtonProps = ComponentProps<typeof motion.button>;

export default function Button({ className, children, ...rest }: MotionButtonProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      whileHover={{ y: -1 }}
      className={clsx(
        "ripple rounded-lg bg-accent/90 px-4 py-2 font-medium text-black shadow-glow hover:bg-accent disabled:opacity-50",
        className
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
