"use client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useUI } from "@/lib/store";
import { Network, ListChecks, Users, Activity, RadioTower, ScrollText, ArrowRight } from "lucide-react";

const ROLE_INFO: Record<string, { title: string; desc: string; cta: string; tab: any }> = {
  PLATFORM_ADMIN: { title: "Platform Administrator", desc: "Full control: waitlist, users, providers, audit, and the control plane.", cta: "Manage waitlist", tab: "waitlist" },
  OPERATIONS: { title: "Operations Viewer", desc: "Read-only visibility across sessions, intents, providers and audit trails.", cta: "View sessions", tab: "sessions" },
  CONSUMER: { title: "Consumer", desc: "Express connectivity intent and watch the deterministic control plane provision a session.", cta: "Open control plane", tab: "control-plane" },
  FAMILY_ADMIN: { title: "Family Administrator", desc: "Provision connectivity for a household with shared entitlements.", cta: "Open control plane", tab: "control-plane" },
  ENTERPRISE_ADMIN: { title: "Enterprise Administrator", desc: "Provision and govern connectivity for an organization.", cta: "Open control plane", tab: "control-plane" },
  PROVIDER: { title: "Provider", desc: "Publish capabilities, resources and offers to the RoamLink ecosystem.", cta: "View providers", tab: "providers" },
  RESELLER: { title: "Reseller", desc: "Inspect available capabilities and offers across providers.", cta: "View providers", tab: "providers" },
};

export function RoleOverview({ role, isDemo }: { role?: string; isDemo: boolean }) {
  const setDashTab = useUI((s) => s.setDashTab);
  const info = ROLE_INFO[role || "CONSUMER"] ?? ROLE_INFO.CONSUMER;
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">{info.title}</h1>
          {isDemo && <Badge variant="secondary">DEMO</Badge>}
        </div>
        <p className="text-muted-foreground mt-1">{info.desc}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">The RoamLink invariant</CardTitle>
          <CardDescription>Every flow preserves this pipeline. Provider-specific logic never leaks into the kernel.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            {["Intent", "Capability", "Resource", "Entitlement", "Decision", "Action", "Adapter", "Session", "Measurement"].map((p, i, arr) => (
              <div key={p} className="flex items-center gap-1.5">
                <span className="px-2.5 py-1 rounded-md bg-muted font-medium">{p}</span>
                {i < arr.length - 1 && <ArrowRight className="size-3 text-muted-foreground" />}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4">
        <QuickLink icon={Network} title="Control Plane" desc="Intent → Decision → Session" onClick={() => setDashTab("control-plane")} />
        <QuickLink icon={Activity} title="Sessions" desc="Active & historical connectivity sessions" onClick={() => setDashTab("sessions")} />
        <QuickLink icon={RadioTower} title="Providers" desc="Discover capabilities & offers" onClick={() => setDashTab("providers")} />
        {(role === "PLATFORM_ADMIN" || role === "OPERATIONS") && (
          <QuickLink icon={ListChecks} title="Waitlist" desc="Review & approve access requests" onClick={() => setDashTab("waitlist")} />
        )}
        {(role === "PLATFORM_ADMIN" || role === "OPERATIONS") && (
          <QuickLink icon={Users} title="Users" desc="Manage accounts & roles" onClick={() => setDashTab("users")} />
        )}
        {(role === "PLATFORM_ADMIN" || role === "OPERATIONS") && (
          <QuickLink icon={ScrollText} title="Audit Log" desc="Every important action, recorded" onClick={() => setDashTab("audit")} />
        )}
      </div>

      <Card className="bg-muted/30">
        <CardContent className="pt-6 text-sm text-muted-foreground">
          <strong className="text-foreground">Why this matters:</strong> RoamLink is a Connectivity Operating
          System, not a marketplace. The stable abstraction means WiFi, LTE, eSIM, ISP and satellite can all
          be replaced without changing the protocol/kernel model. Start with the Control Plane to see the
          deterministic decision engine in action.
        </CardContent>
      </Card>
    </div>
  );
}

function QuickLink({ icon: Icon, title, desc, onClick }: { icon: any; title: string; desc: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-left rounded-lg border p-4 hover:bg-muted transition">
      <Icon className="size-5 text-primary mb-2" />
      <div className="font-medium">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
    </button>
  );
}
