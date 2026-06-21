import type { ThreadNode } from "../../../shared/monitor";

export function ThreadTree({
  rootThreadId,
  threads,
  selectedThreadId,
  onSelect
}: {
  rootThreadId: string;
  threads: Record<string, ThreadNode>;
  selectedThreadId: string | null;
  onSelect: (threadId: string) => void;
}) {
  const root = threads[rootThreadId];

  return (
    <section className="panel thread-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Thread tree</p>
          <h3>Root plus spawned agents</h3>
        </div>
      </div>

      {root ? (
        <div className="thread-tree">
          <TreeBranch
            thread={root}
            threads={threads}
            selectedThreadId={selectedThreadId}
            depth={0}
            onSelect={onSelect}
          />
        </div>
      ) : (
        <div className="empty-state">Waiting for thread data…</div>
      )}
    </section>
  );
}

function TreeBranch({
  thread,
  threads,
  selectedThreadId,
  depth,
  onSelect
}: {
  thread: ThreadNode;
  threads: Record<string, ThreadNode>;
  selectedThreadId: string | null;
  depth: number;
  onSelect: (threadId: string) => void;
}) {
  return (
    <div className="thread-branch">
      <button
        type="button"
        className={`thread-card ${selectedThreadId === thread.id ? "selected" : ""}`}
        style={{ paddingLeft: `${depth * 18 + 16}px` }}
        onClick={() => onSelect(thread.id)}
      >
        <div className="thread-card-top">
          <span className={`status-pill ${toneFromBucket(thread.runtimeStatus.bucket)}`}>
            {thread.runtimeStatus.bucket}
          </span>
          <span className="panel-meta">{thread.sourceKind}</span>
        </div>
        <strong>{thread.name ?? thread.id}</strong>
        <span>{thread.latestMessagePreview ?? thread.lastCommandSummary ?? "No recent preview yet."}</span>
      </button>

      {thread.childIds.map((childId) => {
        const child = threads[childId];
        if (!child) {
          return null;
        }

        return (
          <TreeBranch
            key={child.id}
            thread={child}
            threads={threads}
            selectedThreadId={selectedThreadId}
            depth={depth + 1}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

function toneFromBucket(bucket: string) {
  switch (bucket) {
    case "idle":
      return "good";
    case "error":
      return "alert";
    case "waiting_on_human":
      return "warn";
    default:
      return "neutral";
  }
}
