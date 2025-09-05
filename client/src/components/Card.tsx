import { motion } from "framer-motion";
// TODO: The suit glyphs used in this component appear garbled on some systems.
// Consider replacing with inline SVGs for ♠ ♥ ♦ ♣ to ensure consistency.

type Props = { rank: string; suit: "S"|"H"|"D"|"C"; flipped?: boolean; faceDown?: boolean };

const suitMap = { S: "♠", H: "♥", D: "♦", C: "♣" } as const;

export default function Card({ rank, suit, flipped, faceDown }: Props) {
  const color = suit === "H" || suit === "D" ? "text-red-400" : "text-white";
  return (
    <div className={`card-3d w-16 h-24`}>
      <motion.div
        initial={false}
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="card-3d-inner relative w-full h-full"
      >
        <div className="card-face absolute inset-0 rounded-xl bg-card border border-white/10 grid place-items-center">
          {faceDown ? (
            <div className="w-full h-full rounded-xl bg-gradient-to-br from-accent/30 to-accent/5" />
          ) : (
            <div className={`text-xl ${color}`}>{rank}{suitMap[suit]}</div>
          )}
        </div>
        <div className="card-face card-back absolute inset-0 rounded-xl bg-card border border-white/10 grid place-items-center">
          <div className="w-full h-full rounded-xl bg-gradient-to-br from-accent/30 to-accent/5" />
        </div>
      </motion.div>
    </div>
  );
}
    
