import type {
  ActiveShutdownState,
  MonitorItem,
  PendingRequest,
  ThreadNode,
  TurnSummary
} from "../../../shared/monitor";

export function TurnInspector({
  thread,
  turn,
  items,
  pendingRequests,
  activeShutdown
}: {
  thread: ThreadNode | null;
  turn: TurnSummary | null;
  items: Record<string, MonitorItem>;
  pendingRequests: PendingRequest[];
  activeShutdown: ActiveShutdownState;
}) {
  const latestCommands = turn
    ? turn.itemIds
        .map((itemId) => items[itemId])
        .filter((item): item is MonitorItem => Boolean(item))
        .filter((item) => item.type === "commandExecution")
    : [];

  return (
    <section className="panel inspector-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Inspector</p>
          <h3>{thread?.runtimeStatus.bucket ?? "No thread selected"}</h3>
        </div>
      </div>

      {!thread ? (
        <div className="empty-state">Thread metadata appears here.</div>
      ) : (
        <>
          <div className="inspector-section">
            <span className="panel-meta">Latest turn</span>
            <strong>{turn?.status ?? "no turn yet"}</strong>
            <span>{thread.lastCommandSummary ?? thread.latestMessagePreview ?? "No recent activity summary."}</span>
          </div>

          <div className="inspector-section">
            <span className="panel-meta">Plan</span>
            {turn?.plan.length ? (
              <ul className="plan-list">
                {turn.plan.map((step) => (
                  <li key={step.step}>
                    <span className="panel-meta">{step.status}</span>
                    <strong>{step.step}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <span>No plan updates captured for this turn.</span>
            )}
          </div>

          <div className="inspector-section">
            <span className="panel-meta">Diff</span>
            {turn?.diff ? <pre>{turn.diff}</pre> : <span>No diff emitted yet.</span>}
          </div>

          <div className="inspector-section">
            <span className="panel-meta">Commands</span>
            {latestCommands.length ? (
              latestCommands.map((item) => (
                <div key={item.id} className="command-summary">
                  <code className="command-line">{item.command}</code>
                  {item.output ? <pre>{item.output}</pre> : null}
                </div>
              ))
            ) : (
              <span>No command output in this turn yet.</span>
            )}
          </div>

          <div className="inspector-section">
            <span className="panel-meta">Pending requests</span>
            {pendingRequests.length ? (
              pendingRequests.map((request) => (
                <div key={request.id} className="pending-card">
                  <strong>{request.summary}</strong>
                  <span>{request.method}</span>
                </div>
              ))
            ) : (
              <span>No pending human requests for this thread.</span>
            )}
          </div>

          {activeShutdown.scheduled ? (
            <div className="inspector-section">
              <span className="panel-meta">Shutdown timer</span>
              <strong>{activeShutdown.executeAt ? new Date(activeShutdown.executeAt).toLocaleTimeString() : "scheduled"}</strong>
              <span>{activeShutdown.command}</span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
