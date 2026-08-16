"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { fmtDate } from "@/lib/store";
import { Check, X, UserPlus, RefreshCw } from "lucide-react";

type Entry = {
  id: string; email: string; name: string | null; requestedRole: string;
  status: string; createdAt: string; decidedAt: string | null; user?: { id: string; email: string } | null;
};

const STATUS_COLOR: Record<string, any> = {
  PENDING: "secondary", INVITED: "outline", APPROVED: "default", REJECTED: "destructive", CONVERTED: "default",
};

export function WaitlistPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["waitlist"], queryFn: () => api.get<{ entries: Entry[] }>("/api/waitlist") });

  const approve = useMutation({
    mutationFn: (id: string) => api.post("/api/waitlist/" + id + "/approve", { create: false }),
    onSuccess: () => { toast.success("Approved"); qc.invalidateQueries({ queryKey: ["waitlist"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const convert = useMutation({
    mutationFn: (id: string) => api.post("/api/waitlist/" + id + "/approve", { create: true }),
    onSuccess: (r: any) => {
      if (r.onboardToken) toast.success(`User created · onboarding password: ${r.onboardToken}`);
      else toast.success("Converted (already existed)");
      qc.invalidateQueries({ queryKey: ["waitlist"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.post("/api/waitlist/" + id + "/reject", {}),
    onSuccess: () => { toast.success("Rejected"); qc.invalidateQueries({ queryKey: ["waitlist"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Waitlist</h1>
          <p className="text-muted-foreground text-sm">Public signups land here. Approve, then convert into a real user account.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="size-4 mr-1" /> Refresh</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Role</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-left p-3">Created</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.entries.map((e) => (
                  <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3 font-medium">{e.email}{e.user && <Badge variant="outline" className="ml-2 text-[10px]">has account</Badge>}</td>
                    <td className="p-3 text-muted-foreground">{e.name || "—"}</td>
                    <td className="p-3"><Badge variant="outline" className="text-[10px]">{e.requestedRole.replace("_", " ")}</Badge></td>
                    <td className="p-3"><Badge variant={STATUS_COLOR[e.status] ?? "secondary"}>{e.status}</Badge></td>
                    <td className="p-3 text-muted-foreground text-xs">{fmtDate(e.createdAt)}</td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-1">
                        {(e.status === "PENDING" || e.status === "REJECTED") && (
                          <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(e.id)}>
                            <Check className="size-3.5 mr-1" /> Approve
                          </Button>
                        )}
                        {(e.status === "APPROVED" || e.status === "INVITED") && !e.user && (
                          <Button size="sm" disabled={convert.isPending} onClick={() => convert.mutate(e.id)}>
                            <UserPlus className="size-3.5 mr-1" /> Convert
                          </Button>
                        )}
                        {e.status !== "CONVERTED" && e.status !== "REJECTED" && (
                          <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(e.id)}>
                            <X className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {q.data?.entries.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No waitlist entries yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
