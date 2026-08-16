"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api-client";
import { fmtDate } from "@/lib/store";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AuditPanel() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ logs: any[] }>("/api/audit") });
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-muted-foreground text-sm">Every important action is recorded: actor, target, result, reason.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="size-4 mr-1" /> Refresh</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left p-3">Action</th>
                  <th className="text-left p-3">Actor</th>
                  <th className="text-left p-3">Target</th>
                  <th className="text-left p-3">Result</th>
                  <th className="text-left p-3">Reason</th>
                  <th className="text-left p-3">At</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.logs.map((l) => (
                  <tr key={l.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3 font-medium font-mono text-xs">{l.action}</td>
                    <td className="p-3 text-muted-foreground">{l.actorType}{l.actorId ? ` · ${l.actorId.slice(0, 8)}` : ""}</td>
                    <td className="p-3 text-muted-foreground text-xs">{l.targetType}{l.targetId ? ` · ${l.targetId.slice(0, 8)}` : ""}</td>
                    <td className="p-3"><Badge variant={l.result === "success" ? "default" : "destructive"} className="text-[10px]">{l.result}</Badge></td>
                    <td className="p-3 text-muted-foreground text-xs">{l.reason || "—"}</td>
                    <td className="p-3 text-muted-foreground text-xs">{fmtDate(l.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
