"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { fmtDate, fmtMoney } from "@/lib/store";
import { Activity, RefreshCw } from "lucide-react";

export function SessionsPanel() {
  const q = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<{ sessions: any[] }>("/api/sessions"), refetchInterval: 5000 });
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Connectivity Sessions</h1>
          <p className="text-muted-foreground text-sm">Active and historical sessions with observed measurements.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="size-4 mr-1" /> Refresh</Button>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        {q.data?.sessions.map((s) => {
          const m = s.measurements?.[0];
          return (
            <Card key={s.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2"><Activity className="size-4" /> {s.resource?.capability?.provider?.name ?? s.providerId}</CardTitle>
                  <Badge variant={s.state === "ACTIVE" ? "default" : s.state === "FAILED" ? "destructive" : "secondary"}>{s.state}</Badge>
                </div>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="text-xs text-muted-foreground font-mono">{s.resource?.identifier}</div>
                {m && (
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Latency</span><div className="font-medium">{m.latencyMs?.toFixed(0)}ms</div></div>
                    <div><span className="text-muted-foreground">Down</span><div className="font-medium">{m.downlinkMbps?.toFixed(1)}Mbps</div></div>
                    <div><span className="text-muted-foreground">Avail</span><div className="font-medium">{m.availabilityPct?.toFixed(0)}%</div></div>
                  </div>
                )}
                <div className="text-xs text-muted-foreground">{fmtDate(s.createdAt)}</div>
              </CardContent>
            </Card>
          );
        })}
        {q.data?.sessions.length === 0 && (
          <Card className="md:col-span-2"><CardContent className="p-8 text-center text-muted-foreground">No sessions yet. Create one from the Control Plane.</CardContent></Card>
        )}
      </div>
    </div>
  );
}
