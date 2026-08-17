"use client";
import { useSession } from "next-auth/react";
import { LandingView } from "./landing-view";
import { DashboardShell } from "./dashboard-shell";

export function AppRoot() {
  const { data: session, status } = useSession();
  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading RoamLink…</div>
      </div>
    );
  }
  if (session?.user) return <DashboardShell />;
  return <LandingView />;
}
