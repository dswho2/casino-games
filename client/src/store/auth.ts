import { create } from "zustand";
import { api } from "../api/client";

export type Me = { id: number; username: string; balance_cents: number; email?: string | null };

type AuthState = {
  me: Me | null;
  loading: boolean;
  fetchMe: () => Promise<void>;
  setMe: (me: Me | null) => void;
  logout: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  me: null,
  loading: false,
  setMe: (me) => set({ me }),
  fetchMe: async () => {
    set({ loading: true });
    try {
      const me = await api<Me>("/me");
      set({ me });
    } catch {
      set({ me: null });
    } finally {
      set({ loading: false });
    }
  },
  logout: async () => {
    await api("/auth/logout", { method: "POST" });
    set({ me: null });
  },
}));

