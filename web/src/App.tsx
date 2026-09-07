import { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useParams } from "react-router-dom";
import type {
  CodexUsageSnapshot,
  MonitorSnapshot,
  ThreadNode
} from "../../shared/monitor";
import { api } from "./api";
import { HistoryPanel } from "./components/HistoryPanel";
import { ThreadTree } from "./components/ThreadTree";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { TurnInspector } from "./components/TurnInspector";
import { overallUsageWindow, quotaPace } from "./presentation";
import { useMonitorState } from "./useMonitorState";

const EMPTY_SNAPSHOT: MonitorSnapshot = {
  generatedAt: "",
  runs: [],
  activeSessions: [],
  threads: {},
  turns: {},
  items: {},
  pendingRequests: {},
  server: {
    connected: false,
    initialized: false,
    lastError: null,
    stderrTail: []
  },
  activeShutdown: {
    scope: null,
    runId: null,
    scheduled: false,
    command: null,
    executeAt: null,
    dryRun: true
  },
  globalAutomation: {
    policy: {
      enabled: false,
      action: "shutdown",
      settleDelayMs: 30000,
      shutdownDelaySeconds: 60,
      cancelOnNewActivity: true
    },
    state: {
      status: "disabled",
      armedAt: null,
      settlesAt: null,
      shutdownAt: null,
      lastAction: null
    }
  },
  codexUsage: {
    status: "loading",
    updatedAt: null,
    error: null,
    primaryLimit: null,
    limits: []
  }
};

export default function App() {
  const { snapshot, error, connectionLabel } = useMonitorState();
  const safeSnapshot = snapshot ?? EMPTY_SNAPSHOT;
  const nowMs = useNow(1000);

  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="topbar">
          <h1>Codex Monitor</h1>
        </header>

        {error ? <div className="banner banner-error">{error}</div> : null}
        {safeSnapshot.server.lastError ? (
          <div className="banner banner-muted">{safeSnapshot.server.lastError}</div>
        ) : null}

        <Routes>
          <Route
            path="/"
            element={<DashboardPage snapshot={safeSnapshot} nowMs={nowMs} connectionLabel={connectionLabel} />}
          />
          <Route
            path="/runs/:runId"
            element={<RunDetailPage snapshot={safeSnapshot} />}
          />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

function DashboardPage({
  snapshot,
  connectionLabel,
  nowMs
}: {
  snapshot: MonitorSnapshot;
  nowMs: number;
  connectionLabel: string;
}) {
  return (
    <main className="dashboard-page">
      <CodexUsageCard usage={snapshot.codexUsage} nowMs={nowMs} />
      <HistoryPanel snapshot={snapshot} nowMs={nowMs} />
      <footer className="monitor-footer">
        <details className="secondary-controls">
          <summary>Auto shutdown · {snapshot.globalAutomation.policy.enabled ? snapshot.activeShutdown.dryRun ? "Dry-run" : "On" : "Off"}{getShutdownCountdown(snapshot, nowMs) ? ` · ${shutdownStatusLabel(snapshot, nowMs)}` : ""}</summary>
          <AutomationCard snapshot={snapshot} nowMs={nowMs} />
        </details>
        <span title={snapshot.server.initialized ? "Codex app-server initialized" : "Waiting for Codex app-server"}>
          {connectionLabel === "live" && snapshot.server.initialized ? "Connected" : `Connection: ${connectionLabel}`} · API-equivalent cost, not a plan charge · Codex Spark excluded
        </span>
      </footer>
    </main>
  );
}

function AutomationCard({
  snapshot,
  nowMs
}: {
  snapshot: MonitorSnapshot;
  nowMs: number;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const globalAutomation = snapshot.globalAutomation;
  const shutdownCountdown = getShutdownCountdown(snapshot, nowMs);
  const phaseCountdown = getPhaseCountdown(snapshot, nowMs);
  const automationEnabled = globalAutomation.policy.enabled;

  return (
    <section className="surface automation-card">
      <div className="automation-main">
        <div className="automation-heading">
          <div>
            <span className="panel-meta">Power</span>
            <strong>Idle shutdown</strong>
          </div>
          <StatusPill
            tone={
              automationEnabled && snapshot.activeShutdown.dryRun
                ? "alert"
                : automationEnabled
                  ? "warn"
                  : "neutral"
            }
            label={
              automationEnabled && snapshot.activeShutdown.dryRun
                ? "dry-run"
                : globalAutomation.state.status
            }
          />
        </div>
        <p>{automationDescription(snapshot, nowMs)}</p>
        {shutdownCountdown || phaseCountdown ? (
          <p className="automation-countdown">
            {phaseCountdown ? `${phaseCountdown}. ` : ""}
            {shutdownCountdown ? `Shutdown in ${shutdownCountdown}.` : ""}
          </p>
        ) : null}
      </div>
      <div className="automation-actions">
        <button
          className={`action-button${automationEnabled ? " ghost" : ""}`}
          onClick={async () => {
            try {
              setActionError(null);
              if (automationEnabled) {
                await api.cancelGlobalNoActiveSessions();
              } else {
                await api.armGlobalNoActiveSessions({});
              }
            } catch (error) {
              setActionError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          {automationEnabled ? "Disable" : "Enable"}
        </button>
      </div>
      {actionError ? <span className="panel-meta error-text">{actionError}</span> : null}
    </section>
  );
}

function CodexUsageCard({
  usage,
  nowMs
}: {
  usage: CodexUsageSnapshot;
  nowMs: number;
}) {
  const window = overallUsageWindow(usage);
  const pace = window ? quotaPace(window, nowMs) : null;
  const unavailable = usage.status !== "available" || !window;
  const expired = pace?.expired;
  const used = unavailable || expired ? null : window.usedPercent;
  const remaining = unavailable || expired ? null : window.remainingPercent;
  const difference = unavailable ? null : pace?.difference ?? null;
  const elapsed = unavailable ? null : pace?.elapsed ?? null;
  const heading = difference === null ? "Pace unavailable" : difference > 1 ? "Usage is ahead of elapsed time" : difference < -1 ? "Usage is below the proportional pace" : "Usage is in line with elapsed time";
  return (
    <section className="surface global-quota" aria-label="Overall Codex usage">
      <div className="global-quota-heading">Overall Codex usage{window ? ` · ${window.label.toLowerCase()}` : ""}</div>
      {unavailable ? <p className="usage-message">{usage.status === "loading" ? "Loading overall Codex usage…" : usage.error ?? "Overall Codex quota is unavailable."}</p> : (
        <div className="global-quota-body">
          <div>
            <div className="quota-number">{formatPercent(remaining)} <span>remaining</span></div>
            <div className="quota-reset">{expired ? "Waiting for the renewed quota" : formatResetLabel(window.resetsAt, nowMs)}</div>
          </div>
          <div className="quota-pace">
            <h2>{heading}</h2>
            <div className="quota-compare"><span>Quota used</span><div className="usage-meter" role="img" aria-label={`${formatPercent(used)} quota used`}><span style={{ width: `${clampMeterPercent(used)}%` }} /></div><b>{formatPercent(used)}</b></div>
            <div className="quota-compare"><span>Time elapsed</span><div className="usage-meter elapsed" role="img" aria-label={`${formatPercent(elapsed)} of period elapsed`}><span style={{ width: `${clampMeterPercent(elapsed)}%` }} /></div><b>{formatPercent(elapsed)}</b></div>
            <p className={`pace-note ${difference !== null && difference > 1 ? "fast" : ""}`}>
              {expired ? "Codex has not reported the new period yet." : difference === null ? "The period or usage data is incomplete." : Math.abs(difference) <= 1 ? "Consumption follows the proportional pace of the period." : `${Math.round(Math.abs(difference))} percentage points ${difference > 0 ? "above" : "below"} the proportional pace.`}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function RunDetailPage({ snapshot }: { snapshot: MonitorSnapshot }) {
  const { runId } = useParams();
  const run = snapshot.runs.find((entry) => entry.id === runId) ?? null;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (run) {
      setSelectedThreadId(run.rootThreadId);
    }
  }, [run?.id, run?.rootThreadId]);

  const threadMap = useMemo(() => {
    if (!run) {
      return {};
    }

    return Object.fromEntries(
      run.trackedThreadIds
        .map((threadId) => snapshot.threads[threadId])
        .filter((thread): thread is ThreadNode => Boolean(thread))
        .map((thread) => [thread.id, thread])
    );
  }, [run, snapshot.threads]);

  const selectedThread =
    (selectedThreadId ? threadMap[selectedThreadId] : null) ??
    (run ? threadMap[run.rootThreadId] : null);
  const selectedTurn =
    selectedThread?.latestTurnId
      ? snapshot.turns[selectedThread.latestTurnId] ?? null
      : null;
  const pendingRequests = Object.values(snapshot.pendingRequests).filter(
    (request) =>
      request.status === "pending" && request.threadId === selectedThread?.id
  );

  if (!run) {
    return (
      <main className="detail-page">
        <div className="panel">
          <p className="eyebrow">Run detail</p>
          <h2>Waiting for this run to appear.</h2>
          <p className="body-copy">
            If you opened a stale URL, go back to the dashboard.
          </p>
          <Link to="/" className="text-link">
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="detail-page">
      <section className="panel detail-banner">
        <div className="detail-banner-header">
          <div>
            <Link to="/" className="text-link">
              Back to dashboard
            </Link>
            <h2>{run.prompt}</h2>
            <p className="body-copy">{run.settings.cwd}</p>
          </div>
          <div className="status-strip">
            <StatusPill tone={toneFromRun(run.status)} label={run.status} />
            <StatusPill
              tone={run.waitingOnHuman ? "warn" : "neutral"}
              label={run.waitingOnHuman ? "waiting on you" : "autonomous"}
            />
            <StatusPill
              tone={run.automationState.status === "scheduled" ? "alert" : "neutral"}
              label={`automation ${run.automationState.status}`}
            />
          </div>
        </div>

        <div className="metrics-row">
          <Metric label="Tracked threads" value={String(run.trackedThreadIds.length)} />
          <Metric label="Root thread" value={run.rootThreadId} />
          <Metric
            label="Shutdown"
            value={
              snapshot.activeShutdown.runId === run.id && snapshot.activeShutdown.executeAt
                ? formatTime(snapshot.activeShutdown.executeAt)
                : "not scheduled"
            }
          />
        </div>

        <div className="banner-actions">
          <button
            className="action-button"
            onClick={async () => {
              try {
                setActionError(null);
                await api.armAutomation(run.id, {});
              } catch (error) {
                setActionError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            Arm shutdown rule
          </button>
          <button
            className="action-button ghost"
            onClick={async () => {
              try {
                setActionError(null);
                await api.cancelShutdown();
              } catch (error) {
                setActionError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            Cancel shutdown
          </button>
          {actionError ? <span className="panel-meta error-text">{actionError}</span> : null}
        </div>
      </section>

      <section className="detail-grid">
        <ThreadTree
          rootThreadId={run.rootThreadId}
          threads={threadMap}
          selectedThreadId={selectedThread?.id ?? null}
          onSelect={setSelectedThreadId}
        />
        <TranscriptPanel
          thread={selectedThread}
          turns={snapshot.turns}
          items={snapshot.items}
        />
        <TurnInspector
          thread={selectedThread}
          turn={selectedTurn}
          items={snapshot.items}
          pendingRequests={pendingRequests}
          activeShutdown={snapshot.activeShutdown}
        />
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({
  tone,
  label,
  title
}: {
  tone: "good" | "warn" | "alert" | "neutral";
  label: string;
  title?: string;
}) {
  return (
    <span className={`status-pill ${tone}`} title={title} aria-label={title}>
      {label}
    </span>
  );
}

function toneFromRun(status: string): "good" | "warn" | "alert" | "neutral" {
  switch (status) {
    case "settled":
      return "good";
    case "error":
      return "alert";
    case "running":
      return "warn";
    default:
      return "neutral";
  }
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--%";
  }

  return `${Math.round(value)}%`;
}

function clampMeterPercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

function formatResetLabel(isoValue: string | null, nowMs: number): string {
  if (!isoValue || !Number.isFinite(Date.parse(isoValue))) {
    return "Reset time unavailable";
  }

  return `Resets in ${formatCompactDuration(Date.parse(isoValue) - nowMs)}`;
}

function formatCompactDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil(durationMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatTime(isoValue: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(isoValue));
}

function automationDescription(snapshot: MonitorSnapshot, nowMs: number): string {
  const automation = snapshot.globalAutomation;
  const activeCount = snapshot.activeSessions.length;
  const idleDelaySeconds = Math.round(automation.policy.settleDelayMs / 1000);
  const shutdownDelaySeconds = automation.policy.shutdownDelaySeconds;

  if (!automation.policy.enabled) {
    return "Off. Enable it to shut down after Codex work finishes.";
  }

  if (snapshot.activeShutdown.dryRun) {
    return "Dry-run mode is on. Countdown will not shut down this computer.";
  }

  if (snapshot.activeShutdown.executeAt || automation.state.shutdownAt) {
    return `Windows shutdown is scheduled. New Codex activity will cancel it.`;
  }

  if (automation.state.settlesAt) {
    return `No active sessions. Scheduling Windows shutdown after ${idleDelaySeconds}s idle.`;
  }

  if (activeCount > 0) {
    return `Waiting for ${activeCount} active Codex session${
      activeCount === 1 ? "" : "s"
    } to finish.`;
  }

  const phaseCountdown = getPhaseCountdown(snapshot, nowMs);
  if (phaseCountdown) {
    return phaseCountdown;
  }

  return `Armed. Shutdown starts after ${idleDelaySeconds}s idle, then Windows waits ${shutdownDelaySeconds}s.`;
}

function useNow(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(handle);
    };
  }, [intervalMs]);

  return nowMs;
}

function shutdownStatusLabel(snapshot: MonitorSnapshot, nowMs: number): string {
  const countdown = getShutdownCountdown(snapshot, nowMs);
  if (countdown) {
    return `Shutdown in ${countdown}`;
  }

  return isShutdownScheduled(snapshot)
    ? `Shutdown ${snapshot.activeShutdown.dryRun ? "dry-run" : "armed"}`
    : "No shutdown scheduled";
}

function isShutdownScheduled(snapshot: MonitorSnapshot): boolean {
  return Boolean(getScheduledShutdownAt(snapshot) ?? snapshot.activeShutdown.scheduled);
}

function getScheduledShutdownAt(snapshot: MonitorSnapshot): string | null {
  return (
    snapshot.activeShutdown.executeAt ??
    snapshot.globalAutomation.state.shutdownAt ??
    snapshot.runs.find((run) => run.automationState.shutdownAt)?.automationState
      .shutdownAt ??
    null
  );
}

function getShutdownCountdown(
  snapshot: MonitorSnapshot,
  nowMs: number
): string | null {
  const scheduledShutdownAt = getScheduledShutdownAt(snapshot);
  if (scheduledShutdownAt) {
    return formatCountdown(scheduledShutdownAt, nowMs);
  }

  const settlesAtMs = Date.parse(snapshot.globalAutomation.state.settlesAt ?? "");
  if (!Number.isFinite(settlesAtMs)) {
    return null;
  }

  const projectedShutdownAt =
    settlesAtMs + snapshot.globalAutomation.policy.shutdownDelaySeconds * 1000;
  return formatCountdown(projectedShutdownAt, nowMs);
}

function getPhaseCountdown(
  snapshot: MonitorSnapshot,
  nowMs: number
): string | null {
  if (getScheduledShutdownAt(snapshot)) {
    const countdown = getShutdownCountdown(snapshot, nowMs);
    return countdown ? `Windows timer ${countdown}` : null;
  }

  if (snapshot.globalAutomation.state.settlesAt) {
    return `Schedules in ${formatCountdown(
      snapshot.globalAutomation.state.settlesAt,
      nowMs
    )}`;
  }

  return null;
}

function formatCountdown(target: string | number, nowMs: number): string {
  const targetMs = typeof target === "number" ? target : Date.parse(target);
  if (!Number.isFinite(targetMs)) {
    return "00:00";
  }

  const totalSeconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
