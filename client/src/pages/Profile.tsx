import { useEffect, useState } from "react";
import { api } from "../api/client";

type Me = { id: number; email?: string | null; username: string; balance_cents: number };

export default function Profile() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api<Me>("/me").then(setMe).catch(() => setMe(null));
  }, []);

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">Profile</h2>
      {me && (
        <div className="rounded-xl bg-card border border-white/10 p-4">
          <div>Username: <b>{me.username}</b></div>
          <div>Email: <b>{me.email}</b></div>
          <div>Balance: <b>${(me.balance_cents/100).toFixed(2)}</b></div>
        </div>
      )}
      <div className="mt-6 rounded-xl bg-card border border-white/10 p-4">
        <h3 className="font-semibold mb-2">Lifetime Stats</h3>
        <ul className="text-white/70 text-sm list-disc pl-5">
          <li>Lifetime money bet</li>
          <li>Lifetime net won or lost</li>
          <li>Card distribution by rank and suit</li>
        </ul>
        <div className="text-white/50 text-xs mt-2">Wire this to an endpoint when ready.</div>
      </div>
    </div>
  );
}
