"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { fmtDate, fmtMoney } from "@/lib/store";
import { KeyRound, RefreshCw } from "lucide-react";

export function EntitlementsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["entitlements"], queryFn: () => api.get<{ entitlements: any[] }>("/api/entitlements") });
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Entitlements</h1>
          <p className="text-muted-foreground text-sm">Your right to consume connectivity. Origin may be purchase, subscription, allocation, promotion, or trial.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="size-4 mr-1" /> Refresh</Button>
      </div>
      <div className="space-y-2">
        {q.data?.entitlements.map((e) => (
          <Card key={e.id}>
            <CardContent className="p-4 flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4 text-primary" />
                  <span className="font-medium">{e.offer?.name ?? "Trial entitlement"}</span>
                  <Badge variant="outline" className="text-[10px]">{e.origin}</Badge>
                  <Badge variant={e.active ? "default" : "secondary"} className="text-[10px]">{e.active ? "active" : "inactive"}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {e.offer ? fmtMoney(e.offer.priceCents) + " · " : ""}quota {JSON.stringify(e.quota)}
                </div>
                <div className="text-xs text-muted-foreground">created {fmtDate(e.createdAt)}</div>
              </div>
            </CardContent>
          </Card>
        ))}
        {q.data?.entitlements.length === 0 && (
          <Card><CardContent className="p-8 text-center text-muted-foreground">No entitlements yet. The control plane grants a TRIAL entitlement automatically when you activate a session.</CardContent></Card>
        )}
      </div>
    </div>
  );
}
