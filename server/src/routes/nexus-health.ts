import { Router } from "express";
import { getNexusPulseSchedulerHealth } from "../services/nexus-pulse-scheduler.js";
import { nexusOrphanRecovery } from "../services/nexus-orphan-recovery.js";

/**
 * Internal observability endpoint for the NexusAI orchestration subsystem.
 *
 * GET /api/health/nexus
 *   Returns a combined snapshot of:
 *     - NexusPulseScheduler queue depth, active tasks, stats, and circuit breaker states
 *     - NexusOrphanRecovery window summary, per-agent health scores, and escalation records
 *
 * No auth required (same policy as GET /api/health). Intended for operator
 * dashboards and automated monitoring.
 */
export function nexusHealthRoutes() {
  const router = Router();

  router.get("/", (_req, res) => {
    const scheduler = getNexusPulseSchedulerHealth();
    const orphanRecovery = nexusOrphanRecovery.getSummary();

    res.json({
      scheduler,
      orphanRecovery,
    });
  });

  return router;
}
