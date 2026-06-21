import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  HistoryJob,
  HistoryJobSortKey,
  SortDirection,
  TokenUsage
} from "../../../shared/monitor";

const DEFAULT_FILTERS = [
  "appServer",
  "vscode",
  "cli",
  "subAgent",
  "subAgentOther"
];
const PAGE_SIZE = 18;

const SORT_OPTIONS: Array<{ value: HistoryJobSortKey; label: string }> = [
  { value: "updatedAt", label: "Last activity" },
  { value: "createdAt", label: "Created" },
  { value: "lastRunDurationMs", label: "Last run time" },
  { value: "totalDurationMs", label: "Total runtime" },
  { value: "lastRunTokens", label: "Last run tokens" },
  { value: "totalTokens", label: "Total tokens" },
  { value: "runCount", label: "Run count" }
];

export function HistoryPanel() {
  const [sourceKinds, setSourceKinds] = useState<string[]>(DEFAULT_FILTERS);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortKey, setSortKey] = useState<HistoryJobSortKey>("updatedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [history, setHistory] = useState<HistoryJob[]>([]);
  const [totalHistoryCount, setTotalHistoryCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceOptions = useMemo(
    () => [
      "appServer",
      "vscode",
      "cli",
      "exec",
      "subAgent",
      "subAgentReview",
      "subAgentOther"
    ],
    []
  );

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setNextCursor(null);

    void api
      .fetchHistoryJobs({
        sourceKinds,
        searchTerm,
        sortKey,
        sortDirection,
        limit: PAGE_SIZE
      })
      .then((response) => {
        if (!disposed) {
          setHistory(response.data);
          setTotalHistoryCount(response.total);
          setNextCursor(response.nextCursor);
          setError(null);
        }
      })
      .catch((historyError) => {
        if (!disposed) {
          setHistory([]);
          setTotalHistoryCount(0);
          setNextCursor(null);
          setError(
            historyError instanceof Error
              ? historyError.message
              : String(historyError)
          );
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [searchTerm, sortDirection, sortKey, sourceKinds]);

  async function loadMore() {
    if (!nextCursor || loadingMore) {
      return;
    }

    try {
      setLoadingMore(true);
      const response = await api.fetchHistoryJobs({
        sourceKinds,
        searchTerm,
        sortKey,
        sortDirection,
        cursor: nextCursor,
        limit: PAGE_SIZE
      });
      setHistory((current) => [...current, ...response.data]);
      setTotalHistoryCount(response.total);
      setNextCursor(response.nextCursor);
      setError(null);
    } catch (historyError) {
      setError(
        historyError instanceof Error ? historyError.message : String(historyError)
      );
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="surface history-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">History</p>
          <h3>Previous Codex work</h3>
        </div>
        <span className="panel-meta">
          {loading
            ? "Loading sessions"
            : `Showing ${history.length} of ${totalHistoryCount} sessions`}
        </span>
      </div>

      <div className="filter-row">
        <input
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Filter by title, prompt, cwd, or id"
        />
        <div className="chip-row">
          {sourceOptions.map((option) => {
            const enabled = sourceKinds.includes(option);
            return (
              <button
                key={option}
                type="button"
                className={`chip ${enabled ? "selected" : ""}`}
                onClick={() => {
                  setSourceKinds((current) =>
                    current.includes(option)
                      ? current.filter((entry) => entry !== option)
                      : [...current, option]
                  );
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      </div>

      <div className="history-controls">
        <label className="select-field">
          <span>Sort by</span>
          <select
            value={sortKey}
            onChange={(event) =>
              setSortKey(event.target.value as HistoryJobSortKey)
            }
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="chip selected"
          type="button"
          onClick={() =>
            setSortDirection((current) => (current === "desc" ? "asc" : "desc"))
          }
        >
          {sortDirection === "desc" ? "Descending" : "Ascending"}
        </button>
      </div>

      {loading ? <div className="empty-state">Loading job history...</div> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!loading && !error && history.length === 0 ? (
        <div className="empty-state">
          <p>No previous Codex work matched these filters.</p>
          <span>History is read from local Codex session files.</span>
        </div>
      ) : null}

      <div className="history-list">
        {history.map((job) => (
          <article key={job.id} className="history-card">
            <div className="run-card-header">
              <span className="status-pill neutral">{job.sourceKind}</span>
              <span className="panel-meta">{job.runCount} runs</span>
            </div>
            <a
              className="history-title-link"
              href={codexThreadHref(job.id)}
              title="Open in Codex"
            >
              {formatJobTitle(job)}
            </a>
            <p>{job.preview ?? "No preview available."}</p>
            <div className="history-metrics">
              <HistoryMetric
                label="Last run"
                value={formatDuration(job.lastRunDurationMs)}
              />
              <HistoryMetric
                label="Total"
                value={formatDuration(job.totalDurationMs)}
              />
              <HistoryMetric
                label="Last tokens"
                value={formatTokenUsage(job.lastRunUsage)}
                title={formatTokenUsageDetails(job.lastRunUsage)}
              />
              <HistoryMetric
                label="Total tokens"
                value={formatTokenUsage(job.totalUsage)}
                title={formatTokenUsageDetails(job.totalUsage)}
              />
            </div>
            <div className="run-card-footer">
              <span title={job.cwd ?? undefined}>{job.cwd ?? "unknown cwd"}</span>
              <span>{formatDateTime(job.updatedAt)}</span>
            </div>
          </article>
        ))}
      </div>

      {nextCursor ? (
        <div className="history-actions">
          <button
            className="action-button ghost"
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function HistoryMetric({
  label,
  value,
  title
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="history-metric" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatJobTitle(job: HistoryJob): string {
  if (job.name) {
    return job.name;
  }

  if (job.preview) {
    const firstLine = job.preview.split(/\r?\n/).find((line) => line.trim());
    if (firstLine) {
      return firstLine.trim().length <= 72
        ? firstLine.trim()
        : `${firstLine.trim().slice(0, 71)}...`;
    }
  }

  return job.id;
}

function codexThreadHref(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function formatDuration(valueMs: number | null): string {
  if (valueMs === null || !Number.isFinite(valueMs)) {
    return "--";
  }

  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatTokenUsage(usage: TokenUsage | null): string {
  if (!usage) {
    return "--";
  }

  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(usage.totalTokens);
}

function formatTokenUsageDetails(usage: TokenUsage | null): string | undefined {
  if (!usage) {
    return undefined;
  }

  const numberFormat = new Intl.NumberFormat();
  return [
    `${numberFormat.format(usage.totalTokens)} total`,
    `${numberFormat.format(usage.inputTokens)} input`,
    `${numberFormat.format(usage.cachedInputTokens)} cached`,
    `${numberFormat.format(usage.outputTokens)} output`,
    `${numberFormat.format(usage.reasoningOutputTokens)} reasoning`
  ].join(", ");
}

function formatDateTime(isoValue: string): string {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString();
}
