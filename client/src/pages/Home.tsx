import { motion } from "framer-motion";

type Game = {
  slug: "blackjack" | "roulette" | "poker" | "slots";
  title: string;
  image: string; // path under public/
  badge?: string;
  featured?: boolean;
};

const GAMES: Game[] = [
  { slug: "blackjack", title: "Blackjack", image: "/games/blackjack.webp", badge: "Popular", featured: true },
  { slug: "roulette", title: "Roulette", image: "/games/roulette.webp", badge: "New" },
  { slug: "poker", title: "Texas Hold'em", image: "/games/poker.webp", badge: "Main table" },
  { slug: "slots", title: "Slots", image: "/games/slots.webp" },
];

export default function Home() {
  return (
    <div className="p-4 md:p-10">
      <header className="max-w-6xl mx-auto mb-8 md:mb-12">
        <div className="text-3xl md:text-4xl font-extrabold tracking-tight">Casino Hub</div>
        <div className="text-white/70 mt-1">Pick a table and let the chips fly.</div>
      </header>

      <main className="max-w-6xl mx-auto grid gap-5 md:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-[200px] md:auto-rows-[240px]">
        {GAMES.map((g, idx) => (
          <GameCard key={g.slug} game={g} index={idx} />
        ))}
      </main>
    </div>
  );
}

function GameCard({ game, index }: { game: Game; index: number }) {
  const spanClasses = game.featured ? "lg:col-span-2 lg:row-span-2" : "";
  return (
    <motion.a
      href={`#/${game.slug}`}
      className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-card/60 ${spanClasses}`}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 0.05 + index * 0.05, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -6 }}
    >
      {/* Glow ring */}
      <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-white/5 group-hover:ring-accent transition-colors"></div>

      {/* Background image */}
      <div className="absolute inset-0">
        <img
          src={game.image}
          alt={game.title}
          className="w-full h-full object-cover opacity-70 group-hover:opacity-80 transition-opacity duration-300"
          onError={(e) => { (e.currentTarget.style.visibility = "hidden"); }}
        />
        {/* Fallback gradient if image missing */}
        <div className="absolute inset-0 bg-gradient-to-br from-black/30 via-transparent to-black/50" />
      </div>

      {/* Shine sweep */}
      <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent group-hover:translate-x-full transition-transform duration-700" />

      {/* Content */}
      <div className="relative z-10 h-full p-5 md:p-6">
        {/* Badge in top-left if present */}
        {game.badge && (
          <div className="absolute top-3 left-3">
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-accent/20 text-accent border border-accent/40 backdrop-blur">
              {game.badge}
            </span>
          </div>
        )}

        {/* Bottom bar: title left, play right */}
        <div className="absolute left-0 right-0 bottom-0 p-5 md:p-6 flex items-end justify-between">
          <div className="text-xl md:text-2xl font-extrabold drop-shadow-[0_1px_0_rgba(0,0,0,0.45)]">
            {game.title}
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="rounded-xl bg-bg/70 border border-white/10 px-3 py-1.5 text-sm hover:border-accent">
              Play
            </div>
          </div>
        </div>
      </div>

      {/* Bottom gradient glow */}
      <div className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 w-[120%] h-24 bg-[radial-gradient(60%_60%_at_50%_100%,rgba(122,162,247,0.35),transparent_60%)] opacity-0 group-hover:opacity-100 transition-opacity" />
    </motion.a>
  );
}
