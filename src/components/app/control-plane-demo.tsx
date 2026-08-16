"use client";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { fmtMoney } from "@/lib/store";
import {
  ArrowRight, CheckCircle2, XCircle, Gauge, Zap, Activity, DollarSign,
  Network, Cpu, Play, RefreshCw, Power, Pause,
} from "lucide-react";

type Intent = { id: string; capability: string; location: any; usage: any; constraints: any; preferences: any };
type Candidate = {
  resourceId: string; providerId: string; providerCode: string; providerName: string;
  offerId?: string; rawScore: number; switchingCost: number; effectiveScore: number;
  latencyMs: number; downlinkMbps: number; reliability: number; priceCents: number;
  meetsPolicy: boolean; reasons: string[];
};
type Decision = {
  decisionType: string; targetResourceId?: string; targetProviderId?: string; targetOfferId?: string;
  scoreCurrent?: number; scoreTarget?: number; switchingCost?: number; effectiveDelta?: number;
  reasonCodes: string[]; policyMet: boolean; candidates: Candidate[];
};
type Capability = { id: string; type: string; advertised: any; provider: any; resources: any[]; offers: any[] };

const REASON_LABEL: Record<string, string> = {
  LOWER_LATENCY: "Lower latency",
  HIGHER_THROUGHPUT: "Higher throughput",
  LOWER_COST: "Lower cost",
  HIGHER_RELIABILITY: "Higher reliability",
  MEETS_POLICY: "Policy satisfied",
  POLICY_VIOLATION: "Policy violation",
  BETTER_SCORE_AFTER_SWITCHING_COST: "Better score after switching cost",
  INSUFFICIENT_IMPROVEMENT: "Insufficient improvement (hysteresis)",
  NO_CANDIDATES: "No candidates",
  ENTITLEMENT_VALID: "Entitlement valid",
  ENTITLEMENT_MISSING: "Entitlement missing",
  AVAILABILITY_OK: "Available",
  AVAILABILITY_NONE: "Unavailable",
};

export function ControlPlaneDemo() {
  const [intentId, setIntentId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [activeSession, setActiveSession] = useState<any | null>(null);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Network className="size-6" /> Control Plane</h1>
        <p className="text-muted-foreground mt-1">
          The deterministic golden path: <strong>Intent → Discover → Decision → Action → Adapter → Session → Measurement</strong>.
        </p>
      </div>

      <Stepper intentId={intentId} decision={decision} activeSession={activeSession} />

      <IntentStep onCreated={(id) => { setIntentId(id); setDecision(null); setActiveSession(null); }} active={!!intentId} />

      {intentId && (
        <DiscoverStep intentId={intentId} />
      )}

      {intentId && (
        <DecisionStep
          intentId={intentId}
          onDecided={(d) => setDecision(d)}
          decision={decision}
        />
      )}

      {decision && decision.decisionType !== "RELEASE" && decision.targetResourceId && (
        <ActionStep
          decision={decision}
          intentId={intentId!}
          onActivated={(s) => setActiveSession(s)}
        />
      )}

      {activeSession && (
        <SessionStep sessionId={activeSession.sessionId} />
      )}
    </div>
  );
}

function Stepper({ intentId, decision, activeSession }: { intentId: string | null; decision: Decision | null; activeSession: any }) {
  const steps = [
    { label: "Intent", done: !!intentId },
    { label: "Discover", done: !!intentId },
    { label: "Decision", done: !!decision },
    { label: "Action", done: !!activeSession },
    { label: "Session", done: !!activeSession },
  ];
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-1">
          <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${s.done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
            {s.done ? <CheckCircle2 className="size-3" /> : <span className="size-3 rounded-full border" />}
            {s.label}
          </div>
          {i < steps.length - 1 && <ArrowRight className="size-3 text-muted-foreground" />}
        </div>
      ))}
    </div>
  );
}

function IntentStep({ onCreated, active }: { onCreated: (id: string) => void; active: boolean }) {
  const [capability, setCapability] = useState("internet");
  const [country, setCountry] = useState("GH");
  const [downlink, setDownlink] = useState(10);
  const [maxLatency, setMaxLatency] = useState(150);
  const [prioritize, setPrioritize] = useState("cost");

  const m = useMutation({
    mutationFn: (body: any) => api.post<{ intent: Intent }>("/api/intents", body),
    onSuccess: (r) => { toast.success("Intent created"); onCreated(r.intent.id); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card className={active ? "opacity-70" : ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Cpu className="size-5" /> 1 · Connectivity Intent</CardTitle>
        <CardDescription>What the consumer wants. The intent does <strong>not</strong> select a provider.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => { e.preventDefault(); m.mutate({ capability, location: { country }, timeWindow: { start: new Date().toISOString() }, usage: { downlinkMbps: Number(downlink) }, constraints: { maxLatencyMs: Number(maxLatency) }, preferences: { prioritize } }); }}
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3"
        >
          <Field label="Capability">
            <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={capability} onChange={(e) => setCapability(e.target.value)}>
              <option value="internet">internet</option>
              <option value="wifi">wifi</option>
              <option value="lte">lte</option>
              <option value="esim_data">esim_data</option>
            </select>
          </Field>
          <Field label="Country"><Input value={country} onChange={(e) => setCountry(e.target.value)} /></Field>
          <Field label="Min downlink (Mbps)"><Input type="number" value={downlink} onChange={(e) => setDownlink(+e.target.value)} /></Field>
          <Field label="Max latency (ms)"><Input type="number" value={maxLatency} onChange={(e) => setMaxLatency(+e.target.value)} /></Field>
          <Field label="Prioritize">
            <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={prioritize} onChange={(e) => setPrioritize(e.target.value)}>
              <option value="cost">cost</option>
              <option value="quality">quality</option>
              <option value="reliability">reliability</option>
            </select>
          </Field>
          <div className="sm:col-span-2 lg:col-span-3 flex items-center gap-2">
            <Button type="submit" disabled={m.isPending}><Play className="size-4 mr-1" /> {m.isPending ? "Creating…" : "Create intent"}</Button>
            {active && <Badge variant="secondary">intent active</Badge>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function DiscoverStep({ intentId }: { intentId: string }) {
  const q = useQuery({
    queryKey: ["capabilities", intentId],
    queryFn: () => api.get<{ capabilities: Capability[] }>("/api/capabilities?intentId=" + intentId),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Network className="size-5" /> 2 · Discover Capabilities</CardTitle>
        <CardDescription>Published capabilities matching the intent. Capability ≠ Offer.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading && <div className="text-sm text-muted-foreground">Discovering…</div>}
        <div className="grid md:grid-cols-3 gap-3">
          {q.data?.capabilities.map((c) => {
            const a = c.advertised;
            const offer = c.offers[0];
            return (
              <div key={c.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-sm">{c.provider.name}</div>
                  <Badge variant="outline" className="text-[10px]">{c.provider.code}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">type: {c.type}</div>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <Metric icon={Gauge} label="Latency" value={`${a.typicalLatencyMs}ms`} />
                  <Metric icon={Zap} label="Down" value={`${a.maxDownlinkMbps}Mbps`} />
                  <Metric icon={Activity} label="Reliab." value={`${(a.reliability * 100).toFixed(0)}%`} />
                  <Metric icon={DollarSign} label="From" value={offer ? fmtMoney(offer.priceCents) : "—"} />
                </div>
                <div className="text-[10px] text-muted-foreground">{c.resources.length} resource(s) · {c.offers.length} offer(s)</div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="size-3 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function DecisionStep({ intentId, onDecided, decision }: { intentId: string; onDecided: (d: Decision) => void; decision: Decision | null }) {
  const m = useMutation({
    mutationFn: () => api.post<{ decision: Decision }>("/api/decisions", { intentId }),
    onSuccess: (r) => { onDecided(r.decision); toast.success(`Decision: ${r.decision.decisionType}`); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Cpu className="size-5" /> 3 · Deterministic Decision</CardTitle>
        <CardDescription>Scored by explicit weights + hysteresis. Not AI. Reason codes explain <em>why</em>.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          <RefreshCw className={`size-4 mr-1 ${m.isPending ? "animate-spin" : ""}`} /> {m.isPending ? "Evaluating…" : "Evaluate decision"}
        </Button>

        {decision && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Decision</div>
                  <div className="text-2xl font-bold">{decision.decisionType}</div>
                </div>
                <div className="text-right text-sm">
                  {decision.scoreCurrent != null && <div>Current score: <strong>{decision.scoreCurrent}</strong></div>}
                  {decision.scoreTarget != null && <div>Target score: <strong>{decision.scoreTarget}</strong></div>}
                  {decision.switchingCost != null && <div className="text-muted-foreground">Switching cost: {decision.switchingCost}</div>}
                  {decision.effectiveDelta != null && <div className="text-muted-foreground">Effective Δ: {decision.effectiveDelta}</div>}
                </div>
              </div>
              <Separator className="my-3" />
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Why</div>
              <div className="flex flex-wrap gap-2">
                {decision.reasonCodes.map((r) => (
                  <Badge key={r} variant={r.includes("VIOLATION") || r.includes("MISSING") || r.includes("NONE") ? "destructive" : "secondary"}>
                    {REASON_LABEL[r] ?? r}
                  </Badge>
                ))}
              </div>
              {decision.decisionType === "RETAIN" && (
                <p className="text-xs text-muted-foreground mt-3">
                  Hysteresis: the alternative does not beat the current session by ≥ 10 points, so the
                  system <strong>stays connected</strong> to avoid flapping.
                </p>
              )}
            </div>

            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Scored candidates</div>
              <div className="space-y-2">
                {decision.candidates
                  .slice()
                  .sort((a, b) => b.effectiveScore - a.effectiveScore)
                  .map((c) => (
                    <div key={c.resourceId} className={`rounded-md border p-3 ${decision.targetResourceId === c.resourceId ? "border-primary bg-primary/5" : ""}`}>
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{c.providerName}</span>
                          <Badge variant="outline" className="text-[10px]">{c.providerCode}</Badge>
                          {decision.targetResourceId === c.resourceId && <Badge className="text-[10px]">SELECTED</Badge>}
                          {!c.meetsPolicy && <Badge variant="destructive" className="text-[10px]">POLICY</Badge>}
                        </div>
                        <div className="text-sm font-mono">
                          raw {c.rawScore} · −{c.switchingCost} → <strong>{c.effectiveScore}</strong>
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span><Gauge className="inline size-3" /> {c.latencyMs}ms</span>
                        <span><Zap className="inline size-3" /> {c.downlinkMbps}Mbps</span>
                        <span><Activity className="inline size-3" /> {(c.reliability * 100).toFixed(0)}%</span>
                        <span><DollarSign className="inline size-3" /> {fmtMoney(c.priceCents)}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActionStep({ decision, intentId, onActivated }: { decision: Decision; intentId: string; onActivated: (s: any) => void }) {
  const m = useMutation({
    mutationFn: () => api.post("/api/sessions", {
      intentId, resourceId: decision.targetResourceId, providerId: decision.targetProviderId, offerId: decision.targetOfferId,
    }),
    onSuccess: (r) => {
      if (r.ok) { toast.success("Session ACTIVE · adapter executed"); onActivated(r); }
      else toast.error(r.error || "Activation failed");
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Play className="size-5" /> 4 · Generic Action → Adapter</CardTitle>
        <CardDescription>
          The kernel issues a provider-neutral <code>ACTIVATE</code>. The mock adapter translates it and
          returns an <strong>observed</strong> measurement (distinct from advertised).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          <Power className="size-4 mr-1" /> {m.isPending ? "Provisioning…" : "Execute ACTIVATE"}
        </Button>
        {m.data && !m.data.ok && (
          <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm flex items-center gap-2">
            <XCircle className="size-4 text-destructive" /> Adapter failure: <code>{m.data.error}</code>
            <span className="text-muted-foreground text-xs">(deterministic simulated fault — retry-safe)</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SessionStep({ sessionId }: { sessionId: string }) {
  const q = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.get<{ session: any }>("/api/sessions/" + sessionId),
    refetchInterval: 4000,
  });
  const s = q.data?.session;
  const act = useMutation({
    mutationFn: (action: string) => api.post("/api/sessions/" + sessionId + "/actions", { action }),
    onSuccess: (r) => { if (r.ok) { toast.success(`${r.state}`); q.refetch(); } else toast.error(r.error); },
    onError: (e: any) => toast.error(e.message),
  });
  const m = s?.measurements?.[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Activity className="size-5" /> 5 · Active Connectivity Session</CardTitle>
        <CardDescription>Observed measurement (truth) · generic actions · full transition history.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <div className="text-sm text-muted-foreground">Loading session…</div>}
        {s && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat label="State" value={s.state} />
              <Stat label="Provider" value={s.resource?.capability?.provider?.name ?? s.providerId} />
              <Stat label="Resource" value={s.resource?.identifier} mono />
              <Stat label="Started" value={s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : "—"} />
            </div>

            {m && (
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Observed Measurement (truth, not advertised)</div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  <Stat label="Latency" value={`${m.latencyMs?.toFixed(1)} ms`} icon={Gauge} />
                  <Stat label="Downlink" value={`${m.downlinkMbps?.toFixed(1)} Mbps`} icon={Zap} />
                  <Stat label="Uplink" value={`${m.uplinkMbps?.toFixed(1)} Mbps`} icon={Zap} />
                  <Stat label="Jitter" value={`${m.jitterMs?.toFixed(1)} ms`} icon={Activity} />
                  <Stat label="Packet loss" value={`${m.packetLossPct?.toFixed(2)} %`} icon={Activity} />
                  <Stat label="Availability" value={`${m.availabilityPct?.toFixed(1)} %`} icon={CheckCircle2} />
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => act.mutate("MEASURE")} disabled={act.isPending}><RefreshCw className="size-4 mr-1" /> Measure</Button>
              <Button size="sm" variant="outline" onClick={() => act.mutate("SUSPEND")} disabled={act.isPending}><Pause className="size-4 mr-1" /> Suspend</Button>
              <Button size="sm" variant="outline" onClick={() => act.mutate("RESUME")} disabled={act.isPending}><Play className="size-4 mr-1" /> Resume</Button>
              <Button size="sm" variant="destructive" onClick={() => act.mutate("DEACTIVATE")} disabled={act.isPending}><Power className="size-4 mr-1" /> Deactivate</Button>
            </div>

            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Transition history ({s.transitions?.length})</div>
              <div className="rounded-md border max-h-48 overflow-y-auto">
                {s.transitions?.map((t: any) => (
                  <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b last:border-0">
                    <Badge variant="outline" className="text-[10px]">{t.from}</Badge>
                    <ArrowRight className="size-3" />
                    <Badge variant="outline" className="text-[10px]">{t.to}</Badge>
                    <span className="text-muted-foreground ml-auto">{t.reason} · {new Date(t.at).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, icon: Icon, mono }: { label: string; value: string; icon?: any; mono?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground flex items-center gap-1">{Icon && <Icon className="size-3" />}{label}</div>
      <div className={`font-medium mt-0.5 ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
    </div>
  );
}
