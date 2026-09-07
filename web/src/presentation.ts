import type { CodexUsageSnapshot, CodexUsageWindow, HistoryJob } from '../../shared/monitor';

/** Select the general bucket explicitly; Spark is never a fallback. */
export function overallUsageWindow(usage: CodexUsageSnapshot): CodexUsageWindow | null {
  const limit = usage.limits.find(entry => entry.id === 'codex') ??
    (usage.primaryLimit?.id === 'codex' ? usage.primaryLimit : null);
  const windows = [limit?.primary, limit?.secondary];
  return windows.find(window => window?.windowDurationMins === 10080) ??
    limit?.primary ?? limit?.secondary ?? null;
}

export function quotaPace(window: CodexUsageWindow, nowMs: number) {
  const reset = Date.parse(window.resetsAt ?? '');
  const duration = (window.windowDurationMins ?? 0) * 60_000;
  const expired = Number.isFinite(reset) && reset <= nowMs;
  const elapsed = Number.isFinite(reset) && duration > 0 && reset - duration <= nowMs && !expired
    ? Math.max(0, Math.min(100, (nowMs - (reset - duration)) / duration * 100)) : null;
  const difference = elapsed !== null && window.usedPercent !== null
    ? window.usedPercent - elapsed : null;
  return { expired, elapsed, difference };
}

const INTERNAL_TITLE = /^(?:<|\[(?:transcription|transcript|audio)[\]: ]|```|AGENTS\.md|You are |Here is a list of plugins|The following is the Codex agent history|(?:system instructions|developer instructions|environment_context|recommended_plugins|transcription|audio transcription|user instructions|instructions for)\b)/i;
export function taskTitle(job: Pick<HistoryJob, 'name' | 'preview' | 'id'>): string {
  // Preserve real titles verbatim; only discard obvious injected context labels.
  if (job.name?.trim() && !INTERNAL_TITLE.test(job.name.trim())) return job.name;
  const preview = job.preview?.trim();
  if (preview && !INTERNAL_TITLE.test(preview)) {
    const firstLine = preview.split(/\r?\n/)[0].replace(/^#+\s*/, '').trim();
    if (firstLine && !INTERNAL_TITLE.test(firstLine)) return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
  }
  return `Untitled task · ${job.id.slice(0, 8)}`;
}

export function relativeActivity(value: string, nowMs: number): string {
  const elapsed = nowMs - Date.parse(value);
  if (!Number.isFinite(elapsed)) return 'Unknown';
  if (elapsed < 60_000) return 'Now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  return `${Math.floor(elapsed / 86_400_000)} d ago`;
}

export type TaskFilter = 'active' | 'today' | 'all';
export function visibleTasks(jobs: HistoryJob[], activeIds: Set<string>, filter: TaskFilter, search: string, sort: string, nowMs: number) {
  const day = new Date(nowMs); day.setHours(0, 0, 0, 0);
  const query = search.trim().toLocaleLowerCase('en');
  return jobs.filter(job => filter === 'all' || (filter === 'active' ? activeIds.has(job.id) : activeIds.has(job.id) || Date.parse(job.updatedAt) >= day.getTime()))
    .filter(job => `${taskTitle(job)} ${job.cwd ?? ''} ${job.id}`.toLocaleLowerCase('en').includes(query))
    .sort((a, b) => {
      if (sort === 'usage') {
        const delta = (b.estimatedUsagePercentSinceReset ?? -1) - (a.estimatedUsagePercentSinceReset ?? -1);
        if (delta) return delta;
        const costDelta = (b.totalEstimatedCostUsd ?? -1) - (a.totalEstimatedCostUsd ?? -1);
        if (costDelta) return costDelta;
      }
      return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
    });
}
