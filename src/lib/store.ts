"use client";
import { create } from "zustand";

export type View =
  | "landing"
  | "login"
  | "signup"
  | "demo";

export type DashTab =
  | "overview"
  | "control-plane"
  | "waitlist"
  | "users"
  | "audit"
  | "sessions"
  | "providers"
  | "entitlements";

interface UIState {
  view: View;
  setView: (v: View) => void;
  dashTab: DashTab;
  setDashTab: (t: DashTab) => void;
  prefillEmail: string | null;
  setPrefillEmail: (e: string | null) => void;
}

export const useUI = create<UIState>((set) => ({
  view: "landing",
  setView: (view) => set({ view }),
  dashTab: "overview",
  setDashTab: (dashTab) => set({ dashTab }),
  prefillEmail: null,
  setPrefillEmail: (prefillEmail) => set({ prefillEmail }),
}));

export const fmtMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export const fmtDate = (d: string | Date) =>
  new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
