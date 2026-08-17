"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { fmtDate } from "@/lib/store";
import { RefreshCw } from "lucide-react";

type User = { id: string; email: string; name: string | null; role: string; status: string; isDemo: boolean; createdAt: string };

const ROLES = ["PLATFORM_ADMIN", "CONSUMER", "FAMILY_ADMIN", "ENTERPRISE_ADMIN", "PROVIDER", "RESELLER", "OPERATIONS"];

export function UsersPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: User[] }>("/api/admin/users") });

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-muted-foreground text-sm">Manage accounts, roles and status. Demo identities can never become PLATFORM_ADMIN.</p>
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
                  <th className="text-left p-3">Role</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-left p-3">Created</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.users.map((u) => <UserRow key={u.id} u={u} onDone={() => qc.invalidateQueries({ queryKey: ["users"] })} />)}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UserRow({ u, onDone }: { u: User; onDone: () => void }) {
  const [role, setRole] = useState(u.role);
  const changeRole = useMutation({
    mutationFn: (r: string) => api.patch("/api/admin/users/" + u.id, { role: r }),
    onSuccess: () => { toast.success("Role updated"); onDone(); },
    onError: (e: any) => { toast.error(e.message); setRole(u.role); },
  });
  const toggle = useMutation({
    mutationFn: (status: string) => api.patch("/api/admin/users/" + u.id, { status }),
    onSuccess: () => { toast.success("Status updated"); onDone(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <tr className="border-b last:border-0 hover:bg-muted/30">
      <td className="p-3 font-medium">
        {u.email}
        {u.isDemo && <Badge variant="secondary" className="ml-2 text-[10px]">DEMO</Badge>}
      </td>
      <td className="p-3">
        <Select value={role} onValueChange={(v) => { setRole(v); changeRole.mutate(v); }} disabled={u.isDemo && role === "PLATFORM_ADMIN"}>
          <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => <SelectItem key={r} value={r} disabled={u.isDemo && r === "PLATFORM_ADMIN"} className="text-xs">{r.replace("_", " ")}</SelectItem>)}
          </SelectContent>
        </Select>
      </td>
      <td className="p-3"><Badge variant={u.status === "ACTIVE" ? "default" : "destructive"}>{u.status}</Badge></td>
      <td className="p-3 text-muted-foreground text-xs">{fmtDate(u.createdAt)}</td>
      <td className="p-3 text-right">
        {u.status === "ACTIVE" ? (
          <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate("DISABLED")}>Disable</Button>
        ) : (
          <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate("ACTIVE")}>Enable</Button>
        )}
      </td>
    </tr>
  );
}
