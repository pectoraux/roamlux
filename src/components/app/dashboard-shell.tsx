"use client";
import { useSession, signOut } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useUI, type DashTab } from "@/lib/store";
import { api } from "@/lib/api-client";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Network, Users, ListChecks, ShieldAlert, Activity,
  RadioTower, KeyRound, LogOut, ScrollText,
} from "lucide-react";
import { ControlPlaneDemo } from "./control-plane-demo";
import { WaitlistPanel } from "./admin/waitlist-panel";
import { UsersPanel } from "./admin/users-panel";
import { AuditPanel } from "./admin/audit-panel";
import { SessionsPanel } from "./admin/sessions-panel";
import { ProvidersPanel } from "./admin/providers-panel";
import { EntitlementsPanel } from "./admin/entitlements-panel";
import { RoleOverview } from "./role-overview";

interface MeResponse { user: { userId: string; email: string; role: string; isDemo: boolean } | null; permissions: string[] }

export function DashboardShell() {
  const { data: session } = useSession();
  const { dashTab, setDashTab } = useUI();
  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<MeResponse>("/api/me"),
  });
  const role = (session?.user?.role ?? meQ.data?.user?.role) as string | undefined;
  const perms = new Set(meQ.data?.permissions ?? []);
  const isDemo = session?.user?.isDemo ?? meQ.data?.user?.isDemo;

  const nav: { key: DashTab; label: string; icon: any; perm?: string; roles?: string[] }[] = [
    { key: "overview", label: "Overview", icon: LayoutDashboard },
    { key: "control-plane", label: "Control Plane", icon: Network, perm: "intent.create" },
    { key: "sessions", label: "Sessions", icon: Activity, perm: "session.view" },
    { key: "entitlements", label: "Entitlements", icon: KeyRound, perm: "intent.create" },
    { key: "providers", label: "Providers", icon: RadioTower, perm: "capability.view" },
    { key: "waitlist", label: "Waitlist", icon: ListChecks, perm: "waitlist.view" },
    { key: "users", label: "Users", icon: Users, perm: "user.view" },
    { key: "audit", label: "Audit Log", icon: ShieldAlert, perm: "audit.view" },
  ];

  const visibleNav = nav.filter((n) => {
    if (n.perm && !perms.has(n.perm)) return false;
    return true;
  });

  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex flex-1">
        <aside className="hidden md:flex w-60 shrink-0 flex-col border-r bg-muted/30">
          <div className="h-16 flex items-center gap-2 px-4 border-b">
            <div className="size-7 rounded-lg bg-primary text-primary-foreground grid place-items-center font-bold text-sm">R</div>
            <span className="font-semibold">RoamLink</span>
          </div>
          <nav className="flex-1 p-2 space-y-1">
            {visibleNav.map((n) => (
              <button
                key={n.key}
                onClick={() => setDashTab(n.key)}
                className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${dashTab === n.key ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                <n.icon className="size-4" />
                {n.label}
              </button>
            ))}
          </nav>
          <div className="p-3 border-t">
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => signOut({ callbackUrl: "/" })}>
              <LogOut className="size-4 mr-2" /> Sign out
            </Button>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-16 border-b flex items-center justify-between px-4 md:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <ScrollText className="size-5 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="font-medium truncate">{session?.user?.name || session?.user?.email}</div>
                <div className="text-xs text-muted-foreground truncate">{session?.user?.email}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isDemo && <Badge variant="secondary">DEMO</Badge>}
              <Badge variant="outline">{role?.replace("_", " ")}</Badge>
            </div>
          </header>

          {/* mobile nav */}
          <div className="md:hidden border-b overflow-x-auto">
            <div className="flex gap-1 p-2 min-w-max">
              {visibleNav.map((n) => (
                <button
                  key={n.key}
                  onClick={() => setDashTab(n.key)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs whitespace-nowrap ${dashTab === n.key ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                >
                  <n.icon className="size-3.5" />
                  {n.label}
                </button>
              ))}
            </div>
          </div>

          <main className="flex-1 p-4 md:p-6">
            {dashTab === "overview" && <RoleOverview role={role} isDemo={!!isDemo} />}
            {dashTab === "control-plane" && <ControlPlaneDemo />}
            {dashTab === "sessions" && <SessionsPanel />}
            {dashTab === "entitlements" && <EntitlementsPanel />}
            {dashTab === "providers" && <ProvidersPanel />}
            {dashTab === "waitlist" && <WaitlistPanel />}
            {dashTab === "users" && <UsersPanel />}
            {dashTab === "audit" && <AuditPanel />}
          </main>
        </div>
      </div>
      <footer className="border-t mt-auto">
        <div className="px-4 md:px-6 py-4 text-xs text-muted-foreground flex items-center justify-between">
          <span>RoamLink · Connectivity OS</span>
          <span className="hidden sm:inline">Intent → Capability → Resource → Entitlement → Decision → Action → Adapter → Session → Measurement</span>
        </div>
      </footer>
    </div>
  );
}
