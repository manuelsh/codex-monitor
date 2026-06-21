import { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useParams } from "react-router-dom";
import type {
  CodexUsageSnapshot,
  CodexUsageWindow,
  MonitorSnapshot,
  ThreadNode,
  TurnSummary
} from "../../shared/monitor";
import { api } from "./api";
import { HistoryPanel } from "./components/HistoryPanel";
import { ThreadTree } from "./components/ThreadTree";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { TurnInspector } from "./components/TurnInspector";
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
          <div>
            <p className="eyebrow">Local supervision layer</p>
            <h1>Codex Monitor</h1>
          </div>
          <div className="status-strip">
            <StatusPill
              tone={safeSnapshot.server.initialized ? "good" : "warn"}
              label={`Socket ${connectionLabel}`}
            />
            <StatusPill
              tone={isShutdownScheduled(safeSnapshot) ? "alert" : "neutral"}
              label={shutdownStatusLabel(safeSnapshot, nowMs)}
            />
          </div>
        </header>

        {error ? <div className="banner banner-error">{error}</div> : null}
        {safeSnapshot.server.lastError ? (
          <div className="banner banner-muted">{safeSnapshot.server.lastError}</div>
        ) : null}

        <Routes>
          <Route
            path="/"
            element={<DashboardPage snapshot={safeSnapshot} nowMs={nowMs} />}
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
  nowMs
}: {
  snapshot: MonitorSnapshot;
  nowMs: number;
}) {
  return (
    <main className="dashboard-page">
      <section className="dashboard-overview">
        <CodexUsageCard usage={snapshot.codexUsage} nowMs={nowMs} />
        <AutomationCard snapshot={snapshot} nowMs={nowMs} />
      </section>

      <section className="surface sessions-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Now</p>
            <h3>Active Codex sessions</h3>
          </div>
          <span className="panel-meta">{snapshot.activeSessions.length} running now</span>
        </div>

        <div className="run-list">
          {snapshot.activeSessions.length === 0 ? (
            <div className="empty-state">
              <p>No active Codex sessions right now.</p>
              <span>
                Only work that is still in progress appears here. Finished sessions
                are hidden automatically.
              </span>
            </div>
          ) : (
            snapshot.activeSessions.map((session) => {
              const linkedRun =
                snapshot.runs.find((run) => run.rootThreadId === session.id) ?? null;
              const cardContent = (
                <>
                  <div className="run-card-status" aria-hidden="true">
                    <span />
                  </div>
                  <div className="run-card-main">
                    <div className="run-card-title-row">
                      <strong>{session.name ?? "Untitled session"}</strong>
                      <span className="run-state">
                        {linkedRun ? "tracked" : "external"}
                      </span>
                    </div>
                    <p className="run-prompt">
                      {session.preview ?? "No preview available yet."}
                    </p>
                    <div className="run-card-footer">
                      <span title={session.cwd ?? undefined}>
                        {session.cwd ?? "unknown cwd"}
                      </span>
                      <time dateTime={session.updatedAt}>
                        {formatTime(session.updatedAt)}
                      </time>
                    </div>
                  </div>
                </>
              );

              return linkedRun ? (
                <Link key={session.id} to={`/runs/${linkedRun.id}`} className="run-card">
                  {cardContent}
                </Link>
              ) : (
                <article key={session.id} className="run-card">
                  {cardContent}
                </article>
              );
            })
          )}
        </div>
      </section>

      <HistoryPanel />
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
  const limit = usage.primaryLimit;
  const windows = [limit?.primary, limit?.secondary].filter(
    (window): window is CodexUsageWindow => Boolean(window)
  );

  return (
    <section className="surface usage-card">
      <div className="usage-heading">
        <div>
          <span className="panel-meta">Codex remaining</span>
          <strong>{limit?.name ?? "Overall Codex"}</strong>
        </div>
        <StatusPill
          tone={toneFromUsage(usage)}
          label={usageStatusLabel(usage)}
          title={usageStatusTitle(usage)}
        />
      </div>

      {usage.status === "available" && limit ? (
        <div className="usage-windows">
          {windows.map((window) => (
            <UsageWindowCard
              key={`${window.label}-${window.resetsAt ?? "unknown"}`}
              nowMs={nowMs}
              window={window}
            />
          ))}
        </div>
      ) : (
        <p className="usage-message">{usageMessage(usage)}</p>
      )}
    </section>
  );
}

function UsageWindowCard({
  window,
  nowMs
}: {
  window: CodexUsageWindow;
  nowMs: number;
}) {
  const elapsedPercent = getWindowElapsedPercent(window, nowMs);
  const elapsedLabel =
    elapsedPercent === null ? "elapsed unknown" : `${formatPercent(elapsedPercent)} elapsed`;

  return (
    <div className="usage-window">
      <div className="usage-window-top">
        <span>{window.label}</span>
        <strong>{formatPercent(window.usedPercent)} used</strong>
      </div>
      <div
        className="usage-meter"
        aria-label={`${formatPercent(window.usedPercent)} used, ${
          elapsedPercent === null ? "elapsed unknown" : elapsedLabel
        }`}
      >
        <span
          className="usage-meter-fill"
          style={{ width: `${clampMeterPercent(window.usedPercent)}%` }}
        />
        {elapsedPercent === null ? null : (
          <span
            className="usage-meter-marker"
            style={{ left: `${elapsedPercent}%` }}
            title={elapsedLabel}
          />
        )}
      </div>
      <div className="usage-window-bottom">
        <span>{formatResetLabel(window.resetsAt, nowMs)}</span>
        <span>{elapsedLabel}</span>
      </div>
    </div>
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

function toneFromUsage(
  usage: CodexUsageSnapshot
): "good" | "warn" | "alert" | "neutral" {
  if (usage.status === "error") {
    return "alert";
  }

  if (usage.status !== "available" || !usage.primaryLimit) {
    return "neutral";
  }

  if (usage.primaryLimit.rateLimitReachedType) {
    return "alert";
  }

  const remaining = Math.min(
    ...[usage.primaryLimit.primary, usage.primaryLimit.secondary]
      .map((window) => window?.remainingPercent)
      .filter((value): value is number => value !== null && value !== undefined)
  );

  if (!Number.isFinite(remaining)) {
    return "neutral";
  }

  if (remaining <= 10) {
    return "alert";
  }

  if (remaining <= 25) {
    return "warn";
  }

  return "good";
}

function usageStatusLabel(usage: CodexUsageSnapshot): string {
  if (usage.status === "available") {
    return usage.primaryLimit?.planType ?? "available";
  }

  if (usage.status === "loading") {
    return "loading";
  }

  return usage.status;
}

function usageStatusTitle(usage: CodexUsageSnapshot): string | undefined {
  if (usage.status === "available" && usage.primaryLimit?.planType) {
    return `Codex plan: ${usage.primaryLimit.planType}`;
  }

  return undefined;
}

function usageMessage(usage: CodexUsageSnapshot): string {
  if (usage.status === "loading") {
    return "Loading Codex usage.";
  }

  return usage.error ?? "Codex usage is unavailable.";
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--%";
  }

  return `${Math.round(value)}%`;
}

function getWindowElapsedPercent(
  window: CodexUsageWindow,
  nowMs: number
): number | null {
  if (
    !window.resetsAt ||
    window.windowDurationMins === null ||
    !Number.isFinite(window.windowDurationMins) ||
    window.windowDurationMins <= 0
  ) {
    return null;
  }

  const resetsAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) {
    return null;
  }

  const durationMs = window.windowDurationMins * 60000;
  const startsAtMs = resetsAtMs - durationMs;
  return clampMeterPercent(((nowMs - startsAtMs) / durationMs) * 100);
}

function clampMeterPercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

function formatResetLabel(isoValue: string | null, nowMs: number): string {
  if (!isoValue) {
    return "reset unknown";
  }

  return `resets in ${formatCompactDuration(Date.parse(isoValue) - nowMs)}`;
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
  return new Intl.DateTimeFormat(undefined, {
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
    return "Dry-run mode is on. Countdown will not shut down Windows.";
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
