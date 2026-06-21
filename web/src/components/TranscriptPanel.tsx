import type { MonitorItem, ThreadNode, TurnSummary } from "../../../shared/monitor";

export function TranscriptPanel({
  thread,
  turns,
  items
}: {
  thread: ThreadNode | null;
  turns: Record<string, TurnSummary>;
  items: Record<string, MonitorItem>;
}) {
  const threadTurns = thread
    ? thread.turnIds
        .map((turnId) => turns[turnId])
        .filter((turn): turn is TurnSummary => Boolean(turn))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    : [];

  return (
    <section className="panel transcript-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Transcript</p>
          <h3>{thread?.name ?? thread?.id ?? "Select a thread"}</h3>
        </div>
      </div>

      {!thread ? (
        <div className="empty-state">Pick a thread to inspect its stream.</div>
      ) : (
        <div className="transcript-timeline">
          {threadTurns.map((turn) => (
            <article key={turn.id} className="turn-block">
              <header className="turn-header">
                <span className={`status-pill ${toneFromTurn(turn.status)}`}>{turn.status}</span>
                <span className="panel-meta">{new Date(turn.startedAt).toLocaleTimeString()}</span>
              </header>

              {turn.itemIds.map((itemId) => {
                const item = items[itemId];
                if (!item) {
                  return null;
                }

                return (
                  <div key={item.id} className={`stream-item ${item.type}`}>
                    <strong>{item.title}</strong>
                    {item.command ? <code className="command-line">{item.command}</code> : null}
                    {item.text ? <p>{item.text}</p> : null}
                    {item.output ? <pre>{item.output}</pre> : null}
                    {item.toolName ? <span className="panel-meta">tool: {item.toolName}</span> : null}
                  </div>
                );
              })}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function toneFromTurn(status: string) {
  switch (status) {
    case "completed":
      return "good";
    case "failed":
      return "alert";
    case "interrupted":
      return "warn";
    default:
      return "neutral";
  }
}
