import { useEffect, useState } from "react";
import AuthModal from "./features/auth/AuthModal";
import Home from "./pages/Home";
import Profile from "./pages/Profile";

export default function App() {
  const [authOpen, setAuthOpen] = useState(false);
  const [route, setRoute] = useState<"home"|"profile">("home");

  useEffect(() => {
    const sync = () => setRoute(location.hash === "#/profile" ? "profile" : "home");
    window.addEventListener("hashchange", sync); sync();
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-10 bg-bg/70 backdrop-blur border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <div className="font-bold">♠︎ BJ</div>
        <div className="flex items-center gap-3">
          <a href="#/" className="text-white/80 hover:text-white">Table</a>
          <a href="#/profile" className="text-white/80 hover:text-white">Profile</a>
          <button onClick={()=>setAuthOpen(true)} className="rounded-lg bg-card px-3 py-2 border border-white/10 hover:border-accent">Login</button>
        </div>
      </nav>
      {route==="home" ? <Home /> : <Profile />}
      <AuthModal open={authOpen} onClose={()=>setAuthOpen(false)} onAuthed={()=>setAuthOpen(false)} />
    </div>
  );
}
