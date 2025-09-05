import { useState } from "react";
import Button from "./Button";

const PRESETS = [5, 10, 50, 100, 500];

export default function ChipSelector({ onChange }: { onChange: (cents: number) => void }) {
  const [amount, setAmount] = useState(500); // cents
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 flex-wrap">
        {PRESETS.map(v => (
          <Button key={v} onClick={() => { setAmount(v*100); onChange(v*100); }}>
            ${v}
          </Button>
        ))}
        <input
          inputMode="numeric"
          className="rounded-lg bg-card px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent"
          placeholder="Custom $"
          onChange={(e) => {
            const dollars = Number(e.target.value || "0");
            const cents = Math.max(0, Math.floor(dollars * 100));
            setAmount(cents);
            onChange(cents);
          }}
        />
      </div>
      <div className="flex items-end justify-end gap-4 mt-1">
        <div className="text-sm text-white/70">Current Bet: <span className="text-white font-semibold">${(amount/100).toFixed(2)}</span></div>
      </div>
    </div>
  );
}
