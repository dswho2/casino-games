import { motion, AnimatePresence } from "framer-motion";

export default function AnimatedChipStack({ amount }: { amount: number }) {
  const chips = splitChips(amount); // in cents -> convert to dollars visually
  return (
    <div className="relative h-24 w-24">
      <AnimatePresence initial={false}>
        {chips.map((c, i) => (
          <motion.div
            key={`${c.value}-${i}`}
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: -i * 6, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 200, damping: 18 }}
            className="absolute left-1/2 -translate-x-1/2"
          >
            <div className="w-14 h-14 rounded-full ring-4 ring-white/60 bg-chip grid place-items-center">
              <span className="font-bold text-black">${c.value}</span>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function splitChips(amountCents: number) {
  const dollars = Math.max(0, Math.floor(amountCents / 100));
  const denoms = [500, 100, 50, 10, 5, 1];
  const out: { value: number }[] = [];
  let remain = dollars;
  for (const d of denoms) {
    while (remain >= d && out.length < 12) { out.push({ value: d }); remain -= d; }
  }
  return out;
}
