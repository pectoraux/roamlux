"use client";
import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUI } from "@/lib/store";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import {
  Radio, Network, ArrowRight, ShieldCheck, Cpu, GitBranch, Activity, Layers,
} from "lucide-react";

const ROLES = [
  { key: "CONSUMER", label: "Consumer" },
  { key: "FAMILY_ADMIN", label: "Family Admin" },
  { key: "ENTERPRISE_ADMIN", label: "Enterprise Admin" },
  { key: "PROVIDER", label: "Provider" },
  { key: "RESELLER", label: "Reseller" },
  { key: "OPERATIONS", label: "Operations" },
] as const;

const PIPELINE = [
  "Intent", "Capability", "Resource", "Entitlement", "Decision",
  "Generic Action", "Adapter", "Connectivity Session", "Measurement", "Re-evaluation",
];

export function LandingView() {
  const { view, setView } = useUI();

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <Hero />
        <ArchitectureSection />
        <AccessSection defaultTab={view === "demo" ? "demo" : view === "login" ? "login" : "signup"} setView={setView} />
        <ProvidersSection />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b bg-background/80 backdrop-blur sticky top-0 z-40">
      <div className="container mx-auto max-w-6xl px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-primary text-primary-foreground grid place-items-center font-bold">R</div>
          <span className="font-semibold text-lg">RoamLink</span>
          <Badge variant="secondary" className="ml-2">Connectivity OS</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => useUI.getState().setView("login")}>Log In</Button>
          <Button size="sm" onClick={() => useUI.getState().setView("signup")}>Sign Up</Button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="container mx-auto max-w-6xl px-4 py-16 md:py-24">
      <div className="max-w-3xl">
        <Badge variant="outline" className="mb-4">Connectivity Operating System</Badge>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-tight">
          Express intent.<br />Provision any connectivity.
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl">
          RoamLink is <strong>not an eSIM marketplace</strong>. It is a protocol-driven
          operating system that discovers, evaluates, acquires, provisions, monitors, switches,
          reconciles, and settles heterogeneous connectivity — WiFi, LTE, eSIM, ISP, satellite —
          behind one stable abstraction.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={() => useUI.getState().setView("signup")}>
            Request Access <ArrowRight className="ml-2 size-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => useUI.getState().setView("demo")}>
            Explore Demo
          </Button>
        </div>
      </div>

      <div className="mt-12 rounded-xl border bg-muted/30 p-4 md:p-6 overflow-x-auto">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-3">The Stable Invariant</div>
        <div className="flex items-center gap-2 flex-wrap">
          {PIPELINE.map((p, i) => (
            <div key={p} className="flex items-center gap-2">
              <span className="px-3 py-1.5 rounded-md bg-background border text-sm font-medium whitespace-nowrap">{p}</span>
              {i < PIPELINE.length - 1 && <ArrowRight className="size-3 text-muted-foreground" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ArchitectureSection() {
  const cards = [
    { icon: Layers, title: "Protocol, not products", desc: "Intent, Capability, Resource, Offer, Entitlement, Session and Measurement are distinct concepts — never collapsed into a universal 'Product'." },
    { icon: Cpu, title: "Deterministic control plane", desc: "Decisions are scored by explicit, testable rules with hysteresis. AI compiles intent; it is never the authority." },
    { icon: GitBranch, title: "Provider-neutral kernel", desc: "Generic actions (DISCOVER, RESERVE, ACTIVATE…) are translated by adapters. No MikroTik or eSIM logic leaks into the kernel." },
    { icon: ShieldCheck, title: "Failure-safe & auditable", desc: "Idempotent reservations, reconciliation hooks, an outbox event log, and full audit trails for every important action." },
    { icon: Network, title: "Waitlist-gated identity", desc: "Public signup creates a waitlist entry — never an account. Admins approve and convert entries into real users." },
    { icon: Activity, title: "Observed vs advertised", desc: "Provider claims are never automatically truth. Measurements are first-class records, distinct from advertised capability." },
  ];
  return (
    <section className="container mx-auto max-w-6xl px-4 py-12">
      <h2 className="text-2xl md:text-3xl font-bold mb-8">Built on first principles</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c) => (
          <Card key={c.title}>
            <CardHeader>
              <c.icon className="size-6 text-primary mb-2" />
              <CardTitle className="text-lg">{c.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>{c.desc}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function AccessSection({ defaultTab, setView }: { defaultTab: string; setView: (v: any) => void }) {
  return (
    <section className="container mx-auto max-w-6xl px-4 py-12">
      <div className="text-center mb-8">
        <h2 className="text-2xl md:text-3xl font-bold">Get started</h2>
        <p className="text-muted-foreground mt-2">Request access, sign in, or explore the platform as a demo identity.</p>
      </div>
      <Tabs defaultValue={defaultTab} className="max-w-2xl mx-auto">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="signup">Sign Up</TabsTrigger>
          <TabsTrigger value="login">Log In</TabsTrigger>
          <TabsTrigger value="demo">Explore Demo</TabsTrigger>
        </TabsList>
        <TabsContent value="signup" className="mt-4"><SignupCard onDone={() => setView("login")} /></TabsContent>
        <TabsContent value="login" className="mt-4"><LoginCard /></TabsContent>
        <TabsContent value="demo" className="mt-4"><DemoPanel /></TabsContent>
      </Tabs>
    </section>
  );
}

function SignupCard({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]["key"]>("CONSUMER");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<{ id: string; status: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await api.post<{ id: string; status: string; message?: string }>("/api/signup", { email, name, requestedRole: role });
      setDone({ id: r.id, status: r.status });
      toast.success("You are on the waitlist!");
    } catch (err: any) {
      toast.error(err.message || "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" /> On the waitlist</CardTitle>
          <CardDescription>Entry <code className="text-xs">{done.id.slice(0, 12)}</code> · status <Badge>{done.status}</Badge></CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Public signup does <strong>not</strong> create an active account. A platform administrator
            will review your request and convert it into a real user account. You will then be able to log in.
          </p>
          <Button variant="outline" size="sm" onClick={onDone}>Go to Log In</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Request access</CardTitle>
        <CardDescription>Join the waitlist. An administrator approves each request.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="su-name">Name</Label>
            <Input id="su-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="su-email">Email</Label>
            <Input id="su-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label>Requested role</Label>
            <div className="grid grid-cols-2 gap-2">
              {ROLES.map((r) => (
                <button
                  type="button"
                  key={r.key}
                  onClick={() => setRole(r.key)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-left transition ${role === r.key ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
                >
                  <Radio className={`size-4 ${role === r.key ? "text-primary" : "text-muted-foreground"}`} />
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Submitting…" : "Join waitlist"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function LoginCard() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    if (res?.error) {
      toast.error("Invalid credentials or account not approved.");
      return;
    }
    toast.success("Welcome back");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log in</CardTitle>
        <CardDescription>Authenticate with an approved account. Waitlisted users cannot log in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="li-email">Email</Label>
            <Input id="li-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="li-pass">Password</Label>
            <Input id="li-pass" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Log in"}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Platform administrator: <code>ekontetevi@gmail</code>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

function DemoPanel() {
  const router = useRouter();
  const [demos, setDemos] = useState<{ email: string; name: string; role: string }[] | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ identities: { email: string; name: string; role: string }[]; password: string }>("/api/demo-login")
      .then((r) => { if (!cancelled) { setDemos(r.identities); setPassword(r.password); } })
      .catch(() => toast.error("Could not load demo identities"));
    return () => { cancelled = true; };
  }, []);

  async function loginAs(email: string, label: string) {
    setLoading(email);
    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(null);
    if (res?.error) { toast.error("Demo login failed"); return; }
    toast.success(`Signed in as ${label} (demo)`);
    router.refresh();
  }

  return (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Badge variant="secondary">DEMO</Badge> Quick login
            </CardTitle>
            <CardDescription>Inspect every major experience without creating accounts.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Demo identities pass through the <strong>normal authentication mechanism</strong> and enforce the
          same authorization model. They are clearly marked <Badge variant="outline" className="text-[10px]">DEMO</Badge> and
          can never become platform admin.
        </p>
        <div className="grid sm:grid-cols-2 gap-2">
          {demos?.map((d) => (
            <button
              key={d.email}
              onClick={() => loginAs(d.email, d.name)}
              disabled={loading !== null}
              className="flex items-center justify-between rounded-md border px-3 py-2.5 text-sm hover:bg-muted transition disabled:opacity-50 text-left"
            >
              <div>
                <div className="font-medium">{d.name}</div>
                <div className="text-xs text-muted-foreground">{d.role.replace("_", " ")}</div>
              </div>
              {loading === d.email ? <span className="text-xs">…</span> : <ArrowRight className="size-4 text-muted-foreground" />}
            </button>
          ))}
          {!demos && <div className="text-sm text-muted-foreground col-span-2">Loading demo identities…</div>}
        </div>
        {password && (
          <p className="text-[11px] text-muted-foreground pt-1">
            Shared demo password: <code className="select-all">{password}</code>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ProvidersSection() {
  return (
    <section className="container mx-auto max-w-6xl px-4 py-12">
      <h2 className="text-2xl md:text-3xl font-bold mb-2">A mock provider ecosystem</h2>
      <p className="text-muted-foreground mb-8 max-w-2xl">
        Three providers with deliberately different coverage, pricing, throughput, latency and failure
        behavior — the canonical integration test environment for the deterministic decision engine.
      </p>
      <div className="grid md:grid-cols-3 gap-4">
        {[
          { name: "Atlas WiFi Co-op", tag: "Cheap · high latency", color: "text-amber-600", cap: "WiFi", lat: "120ms", price: "$0.20/hr", fail: "8% activation failure" },
          { name: "Beacon Mobile (LTE)", tag: "Medium · high reliability", color: "text-emerald-600", cap: "LTE", lat: "55ms", price: "$3.50/GB", fail: "2% activation failure" },
          { name: "Crest eSIM Premium", tag: "Expensive · excellent performance", color: "text-rose-600", cap: "eSIM", lat: "28ms", price: "$15/GB", fail: "0% failure" },
        ].map((p) => (
          <Card key={p.name}>
            <CardHeader>
              <CardTitle className="text-base">{p.name}</CardTitle>
              <CardDescription className={p.color}>{p.tag}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm space-y-1 text-muted-foreground">
              <div>Capability: {p.cap}</div>
              <div>Typical latency: {p.lat}</div>
              <div>From: {p.price}</div>
              <div>Fault profile: {p.fail}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t mt-auto">
      <div className="container mx-auto max-w-6xl px-4 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="size-6 rounded-md bg-primary text-primary-foreground grid place-items-center font-bold text-xs">R</div>
          RoamLink — Connectivity Operating System
        </div>
        <div className="text-xs text-muted-foreground">
          Intent → Protocol → Decision → Action → Adapter → Connectivity
        </div>
      </div>
    </footer>
  );
}
