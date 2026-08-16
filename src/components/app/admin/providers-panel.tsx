"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { fmtMoney } from "@/lib/store";
import { Gauge, Zap, Activity, RefreshCw } from "lucide-react";

export function ProvidersPanel() {
  const q = useQuery({ queryKey: ["providers"], queryFn: () => api.get<{ providers: any[] }>("/api/providers") });
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Providers</h1>
          <p className="text-muted-foreground text-sm">Independent connectivity providers with published capabilities, resources and offers.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="size-4 mr-1" /> Refresh</Button>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        {q.data?.providers.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{p.name}</CardTitle>
                <Badge variant="outline" className="text-[10px]">{p.code}</Badge>
              </div>
              <CardDescription className="font-mono text-[10px]">{p.supportedActions.join(" · ")}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Capabilities</span><span>{p._count?.capabilities ?? 0}</span></div>
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Resources</span><span>{p._count?.resources ?? 0}</span></div>
              <div className="flex justify-between text-xs"><span className="text-muted-foreground">Offers</span><span>{p._count?.offers ?? 0}</span></div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
