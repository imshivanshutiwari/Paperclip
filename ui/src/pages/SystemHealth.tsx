import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, CircleDot, RefreshCw, XCircle } from "lucide-react";
import { nexusHealthApi, type NexusAgentHealthScore, type NexusEscalationLevel } from "../api/nexus-health";
import { cn } from "../lib/utils";

const NEXUS_HEALTH_QUERY_KEY = ["nexus-health"] as const;

function EscalationBadge({ level }: { level: NexusEscalationLevel }) {
  const map: Record<NexusEscalationLevel, { label: string; className: string }> = {
    none:      { label: "Healthy",   className: "badge-success" },
    warning:   { label: "Warning",   className: "badge-queued" },
    critical:  { label: "Critical",  className: "badge-failed" },
    suspended: { label: "Suspended", className: "badge-failed" },
  };
  const { label, className } = map[level];
  return (
    <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium", className)}>
      {label}
    </span>
  );
}

function HealthScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 80 ? "bg-[oklch(0.75_0.18_160)]"
    : pct >= 50 ? "bg-[oklch(0.80_0.17_90)]"
    : "bg-[oklch(0.62_0.25_25)]";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="glass-card rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function AgentHealthRow({ agent }: { agent: NexusAgentHealthScore }) {
  return (
    <tr className="border-t border-border text-sm">
      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground truncate max-w-[160px]">
        {agent.agentId.slice(0, 8)}…
      </td>
      <td className="py-2 pr-4">
        <HealthScoreBar score={agent.score} />
      </td>
      <td className="py-2 pr-4 tabular-nums">{(agent.orphanRate * 100).toFixed(1)}%</td>
      <td className="py-2 pr-4 tabular-nums">{agent.recentOrphans}</td>
      <td className="py-2 pr-4 tabular-nums">{agent.totalRuns}</td>
      <td className="py-2">
        <EscalationBadge level={agent.escalationLevel} />
      </td>
    </tr>
  );
}

export function SystemHealth() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: NEXUS_HEALTH_QUERY_KEY,
    queryFn: () => nexusHealthApi.get(),
    refetchInterval: 10_000,
  });

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">System Health</h1>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-[oklch(0.62_0.25_25/0.35)] bg-[oklch(0.62_0.25_25/0.08)] p-4 text-sm">
          <XCircle className="h-4 w-4 text-destructive shrink-0" />
          <span>Failed to load nexus health data. Make sure the server is running.</span>
        </div>
      )}

      {isLoading && !data && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      )}

      {data && (
        <>
          {/* Scheduler overview */}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Pulse Scheduler
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Queue Depth" value={data.scheduler.queueDepth} />
              <StatCard label="Active Tasks" value={data.scheduler.activeCount} />
              <StatCard label="Avg Exec (ms)" value={data.scheduler.stats.avgExecutionMs} />
              <StatCard label="Circuit Broken" value={data.scheduler.stats.circuitBroken} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Enqueued" value={data.scheduler.stats.enqueued} />
              <StatCard label="Completed" value={data.scheduler.stats.completed} />
              <StatCard label="Failed" value={data.scheduler.stats.failed} />
              <StatCard label="Dropped" value={data.scheduler.stats.dropped} />
            </div>
          </section>

          {/* Circuit breakers */}
          {data.scheduler.circuitBreakers.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-[oklch(0.80_0.17_90)]" />
                Open Circuit Breakers
              </h2>
              <div className="glass-panel rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Task Key</th>
                      <th className="px-4 py-2 font-medium">Failures</th>
                      <th className="px-4 py-2 font-medium">Backoff Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.scheduler.circuitBreakers.map((cb) => (
                      <tr key={cb.key} className="border-t border-border">
                        <td className="px-4 py-2 font-mono text-xs">{cb.key}</td>
                        <td className="px-4 py-2 tabular-nums">{cb.failures}</td>
                        <td className="px-4 py-2 tabular-nums text-muted-foreground">
                          {cb.backoffRemainingMs > 0 ? `${(cb.backoffRemainingMs / 1000).toFixed(1)}s` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Orphan recovery */}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Orphan Recovery (30-min window)
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <StatCard label="Detected" value={data.orphanRecovery.totalOrphansDetected} />
              <StatCard
                label="Recovered"
                value={data.orphanRecovery.totalOrphansRecovered}
                sub="retry_enqueued"
              />
              <StatCard
                label="Failed"
                value={data.orphanRecovery.totalOrphansFailed}
                sub="terminal or escalated"
              />
            </div>
          </section>

          {/* Agent health scores */}
          {data.orphanRecovery.agentHealthScores.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <CircleDot className="h-4 w-4 text-primary" />
                Agent Health Scores
              </h2>
              <div className="glass-panel rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Agent</th>
                      <th className="px-4 py-2 font-medium">Score</th>
                      <th className="px-4 py-2 font-medium">Orphan Rate</th>
                      <th className="px-4 py-2 font-medium">Recent Orphans</th>
                      <th className="px-4 py-2 font-medium">Total Runs</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.orphanRecovery.agentHealthScores.map((agent) => (
                      <tr key={agent.agentId} className="text-sm">
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground truncate max-w-[160px]">
                          {agent.agentId.slice(0, 8)}…
                        </td>
                        <td className="px-4 py-2">
                          <HealthScoreBar score={agent.score} />
                        </td>
                        <td className="px-4 py-2 tabular-nums">{(agent.orphanRate * 100).toFixed(1)}%</td>
                        <td className="px-4 py-2 tabular-nums">{agent.recentOrphans}</td>
                        <td className="px-4 py-2 tabular-nums">{agent.totalRuns}</td>
                        <td className="px-4 py-2">
                          <EscalationBadge level={agent.escalationLevel} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Escalations */}
          {data.orphanRecovery.escalations.filter((e) => e.level !== "none").length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                Active Escalations
              </h2>
              <div className="flex flex-col gap-2">
                {data.orphanRecovery.escalations
                  .filter((e) => e.level !== "none")
                  .map((esc) => (
                    <div key={esc.agentId} className="glass-panel rounded-lg p-4 flex items-start gap-3">
                      <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{esc.agentId.slice(0, 8)}…</span>
                          <EscalationBadge level={esc.level} />
                        </div>
                        <span className="text-xs text-muted-foreground">{esc.reason}</span>
                      </div>
                      {esc.autoResolvedAt && (
                        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                          <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(0.75_0.18_160)]" />
                          Resolved
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* All-clear */}
          {data.orphanRecovery.escalations.filter((e) => e.level !== "none").length === 0 &&
            data.orphanRecovery.totalOrphansFailed === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-[oklch(0.75_0.18_160/0.35)] bg-[oklch(0.75_0.18_160/0.08)] p-4 text-sm">
              <CheckCircle2 className="h-4 w-4 text-[oklch(0.75_0.18_160)] shrink-0" />
              <span>All systems nominal. No active escalations or orphan failures in the current window.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
