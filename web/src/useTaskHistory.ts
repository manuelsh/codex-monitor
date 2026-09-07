import { useEffect, useState } from 'react';
import type { HistoryJob, HistoryUsageAllocation } from '../../shared/monitor';
import { api } from './api';

/** Refresh the complete local list so filters and sorting cover every task. */
export function useTaskHistory() {
  const [state, setState] = useState<{
    jobs: HistoryJob[];
    allocation: HistoryUsageAllocation | null;
    updatedAt: number | null;
    error: string | null;
  }>({ jobs: [], allocation: null, updatedAt: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function refresh() {
      try {
        const jobs = new Map<string, HistoryJob>();
        let cursor: string | null = null;
        let allocation: HistoryUsageAllocation | null = null;
        const cursors = new Set<string>();
        do {
          const response = await api.fetchHistoryJobs({ sourceKinds: [], cursor, limit: 100, sortKey: 'createdAt', sortDirection: 'asc', signal: controller.signal });
          if (controller.signal.aborted) return;
          response.data.forEach(job => jobs.set(job.id, job));
          allocation = response.usageAllocation;
          cursor = response.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('History pagination did not advance.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        setState({ jobs: [...jobs.values()], allocation, updatedAt: Date.now(), error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, 30_000);
      }
    }
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);
  return state;
}
