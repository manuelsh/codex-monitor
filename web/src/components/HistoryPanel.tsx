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
  "exec"
];
const PAGE_SIZE = 18;

const SORT_OPTIONS: Array<{ value: HistoryJobSortKey; label: string }> = [
  { value: "updatedAt", label: "Last activity" },
  { value: "createdAt", label: "Created" },
  { value: "last24HoursCostUsd", label: "Rolling 24h API equivalent" },
  { value: "last24HoursTokens", label: "Rolling 24h tokens" },
  { value: "estimatedUsagePercentSinceReset", label: "Estimated usage since reset" },
  { value: "totalDurationMs", label: "Total runtime" },
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
      "exec"
    ],
    []
  );

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setNextCursor(null);

    const refreshHistory = () => {
      void api.fetchHistoryJobs({
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
    };

    refreshHistory();
    const refreshHandle = window.setInterval(refreshHistory, 30_000);

    return () => {
      disposed = true;
      window.clearInterval(refreshHandle);
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
                label="Rolling 24h $"
                value={formatEstimatedCost(job.last24HoursEstimatedCostUsd)}
                title="Estimated at standard API token prices for the recorded model. This is not a ChatGPT plan charge and excludes tool-call fees."
              />
              <HistoryMetric
                label="Rolling 24h tokens"
                value={formatTokenUsage(job.last24HoursUsage)}
                title={formatTokenUsageDetails(job.last24HoursUsage)}
              />
              <HistoryMetric
                label="Since reset (est.)"
                value={formatUsagePercent(job.estimatedUsagePercentSinceReset)}
                title="Estimated share of the observed total Codex usage since the current reset. Allocated across locally recorded tasks; it is not an OpenAI per-task measurement."
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
    `${numberFormat.format(usage.cacheWriteInputTokens ?? 0)} cache writes`,
    `${numberFormat.format(usage.outputTokens)} output`,
    `${numberFormat.format(usage.reasoningOutputTokens)} reasoning`
  ].join(", ");
}

function formatEstimatedCost(costUsd: number | null): string {
  if (costUsd === null || !Number.isFinite(costUsd)) {
    return "--";
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: costUsd < 0.01 ? 3 : 2,
    maximumFractionDigits: costUsd < 0.01 ? 3 : 2
  }).format(costUsd);
}

function formatUsagePercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  return `${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: value > 0 && value < 0.1 ? 2 : 1,
    maximumFractionDigits: value > 0 && value < 0.1 ? 2 : 1
  }).format(value)}%`;
}

function formatDateTime(isoValue: string): string {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString();
}
