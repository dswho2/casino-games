import { useState } from "react";
import { api } from "../../api/client";
import { motion } from "framer-motion";
import Button from "../../components/Button";

export default function AuthModal({ open, onClose, onAuthed }: { open: boolean; onClose: () => void; onAuthed: () => void; }) {
  const [mode, setMode] = useState<"login"|"register">("login");
  const [identifier, setIdentifier] = useState(""); // login field
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");           // optional on register
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      if (mode === "login") {
        await api("/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
      } else {
        await api("/auth/register", {
          method: "POST",
          body: JSON.stringify({
            username,
            password,
            email: email.trim() ? email : null
          })
        });
      }
      onAuthed(); onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center z-50">
      <motion.div initial={{scale:.9,opacity:0}} animate={{scale:1,opacity:1}} className="w-[92vw] max-w-md rounded-2xl bg-card p-6 border border-white/10 shadow-glow">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold">{mode === "login" ? "Welcome back" : "Create an account"}</h2>
          {/* TODO: Replace close icon with a proper SVG */}
          <button onClick={onClose} className="text-white/60 hover:text-white">×</button>
        </div>

        {mode === "login" ? (
          <div className="space-y-3">
            <input
              className="w-full rounded-lg bg-black/30 px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent"
              placeholder="Email or Username"
              value={identifier}
              onChange={e=>setIdentifier(e.target.value)}
            />
            <input
              type="password"
              className="w-full rounded-lg bg-black/30 px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent"
              placeholder="Password"
              value={password}
              onChange={e=>setPassword(e.target.value)}
            />
            {error && <div className="text-danger text-sm">{error}</div>}
            {/* TODO: Add basic validation + disable during submit to prevent double posts */}
            <Button className="w-full" onClick={submit}>Login</Button>
            <div className="text-center text-sm text-white/60">
              No account? <button className="text-accent" onClick={()=>setMode("register")}>Register</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              className="w-full rounded-lg bg-black/30 px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent"
              placeholder="Username"
              value={username}
              onChange={e=>setUsername(e.target.value)}
            />
            <input
              className="w-full rounded-lg bg-black/30 px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent"
              placeholder="Email (optional)"
              value={email}
              onChange={e=>setEmail(e.target.value)}
            />
            <input
              type="password"
              className="w-full rounded-lg bg-black/30 px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent"
              placeholder="Password"
              value={password}
              onChange={e=>setPassword(e.target.value)}
            />
            {error && <div className="text-danger text-sm">{error}</div>}
            {/* TODO: Confirm password + stronger password requirements */}
            <Button className="w-full" onClick={submit}>Register</Button>
            <div className="text-center text-sm text-white/60">
              Already have an account? <button className="text-accent" onClick={()=>setMode("login")}>Login</button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

