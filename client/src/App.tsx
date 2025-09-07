import { useEffect, useState } from "react";
import AuthModal from "./features/auth/AuthModal";
import Home from "./pages/Home";
import Profile from "./pages/Profile";
import BlackjackTable from "./features/game/BlackjackTable";
import RouletteTable from "./features/game/RouletteTable";
import PokerTable from "./features/game/PokerTable";
import Wallet from "./pages/Wallet";
import { useAuthStore } from "./store/auth";
import ChipStack from "./components/ChipStack";

type Route = "home" | "profile" | "blackjack" | "roulette" | "poker" | "slots" | "wallet";

export default function App() {
  const [authOpen, setAuthOpen] = useState(false);
  const [route, setRoute] = useState<Route>("home");
  const me = useAuthStore(s => s.me);
  const fetchMe = useAuthStore(s => s.fetchMe);
  const logout = useAuthStore(s => s.logout);
  const [displayBalance, setDisplayBalance] = useState<number>(me?.balance_cents ?? 0);
  const [balanceTint, setBalanceTint] = useState<"none" | "up" | "down">("none");
  const formatMoney = (cents: number) => (cents/100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  useEffect(() => {
    const sync = () => {
      const hash = location.hash || "#/";
      const path = hash.replace(/^#/, "");
      // simple hash routing
      if (path === "/" || path === "/home") setRoute("home");
      else if (path === "/profile") setRoute("profile");
      else if (path === "/blackjack") setRoute("blackjack");
      else if (path === "/roulette") setRoute("roulette");
      else if (path === "/poker") setRoute("poker");
      else if (path === "/slots") setRoute("slots");
      else if (path === "/wallet") setRoute("wallet");
      else setRoute("home");
    };
    window.addEventListener("hashchange", sync);
    sync();
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => { fetchMe(); }, [fetchMe]);
  
  // Animate navbar balance number when store balance changes
  useEffect(() => {
    const target = me?.balance_cents ?? 0;
    const from = displayBalance;
    if (target === from) return;
    setBalanceTint(target > from ? "up" : "down");
    let raf = 0;
    const start = performance.now();
    const duration = 600;
    function tick(now: number){
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(from + (target - from) * eased);
      setDisplayBalance(value);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setTimeout(() => setBalanceTint("none"), 120);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [me?.balance_cents]);

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-10 bg-bg/70 backdrop-blur border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href="#/" className="font-bold select-none text-white hover:text-white/90">
            Casino
          </a>
          <a href="#/blackjack" className={`px-2 py-1 rounded-md transition-colors ${route === "blackjack" ? "text-white bg-card" : "text-white/80 hover:text-white"}`}>
            Blackjack
          </a>
          <a href="#/roulette" className={`px-2 py-1 rounded-md transition-colors ${route === "roulette" ? "text-white bg-card" : "text-white/80 hover:text-white"}`}>
            Roulette
          </a>
          <a href="#/poker" className={`px-2 py-1 rounded-md transition-colors ${route === "poker" ? "text-white bg-card" : "text-white/80 hover:text-white"}`}>
            Poker
          </a>
          <a href="#/slots" className={`px-2 py-1 rounded-md transition-colors ${route === "slots" ? "text-white bg-card" : "text-white/80 hover:text-white"}`}>
            Slots
          </a>
        </div>
        <div className="flex items-center gap-4">
          <a href="#/wallet" role="button" className="flex items-center gap-2 rounded-lg bg-card px-2 py-1 border border-white/10 transition-shadow hover:shadow-[0_0_24px_rgba(122,162,247,0.45)] focus:outline-none">
            <div id="nav-balance-target" className="relative" style={{ top: -1, left: -4 }}>
              <ChipStack amountCents={500} chipSize={24} className="overflow-visible" />
            </div>
            <span className="text-sm text-white/80">Balance:</span>
            <span className={`font-semibold transition-colors duration-300 ${balanceTint === 'up' ? 'text-success' : balanceTint === 'down' ? 'text-danger' : 'text-white'}`}>
              ${formatMoney(displayBalance)}
            </span>
          </a>
          <a href="#/profile" className={`px-2 py-1 rounded-md transition-colors ${route === "profile" ? "text-white bg-card" : "text-white/80 hover:text-white"}`}>
            {me ? me.username : "Profile"}
          </a>
          {me ? (
            <button onClick={logout} className="rounded-lg bg-card px-3 py-2 border border-white/10 hover:border-accent">
              Logout
            </button>
          ) : (
            <button onClick={() => setAuthOpen(true)} className="rounded-lg bg-card px-3 py-2 border border-white/10 hover:border-accent">
              Login
            </button>
          )}
        </div>
      </nav>
      {route === "home" && <Home />}
      {route === "blackjack" && (
        <div className="p-4 md:p-8">
          <BlackjackTable />
        </div>
      )}
      {route === "roulette" && (
        <div className="p-4 md:p-8">
          <RouletteTable />
        </div>
      )}
      {route === "poker" && (
        <div className="p-4 md:p-8">
          <PokerTable />
        </div>
      )}
      {route === "slots" && (
        <div className="p-6">
          <div className="max-w-3xl mx-auto rounded-2xl bg-card/70 border border-white/10 p-8 text-center">
            <div className="text-2xl font-bold mb-2">Slots</div>
            <div className="text-white/70">Coming soon</div>
          </div>
        </div>
      )}
      {route === "profile" && <Profile />}
      {route === "wallet" && <Wallet />}
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} onAuthed={() => { setAuthOpen(false); fetchMe(); }} />
    </div>
  );
}
