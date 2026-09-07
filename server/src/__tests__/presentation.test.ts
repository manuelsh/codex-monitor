import { describe, expect, it } from 'vitest';
import { overallUsageWindow, quotaPace, relativeActivity, taskTitle, visibleTasks } from '../../../web/src/presentation';
import type { CodexUsageLimit, CodexUsageSnapshot, CodexUsageWindow, HistoryJob } from '../../../shared/monitor';

const week: CodexUsageWindow = { label: 'Weekly', usedPercent: 23, remainingPercent: 77, windowDurationMins: 10080, resetsAt: '2026-09-12T00:00:00Z' };
const bucket = (id: string, primary: CodexUsageWindow | null, secondary: CodexUsageWindow | null = null): CodexUsageLimit => ({ id, primary, secondary, name: null, planType: null, credits: null, rateLimitReachedType: null });
const snapshot = (limits: CodexUsageLimit[], primaryLimit: CodexUsageLimit | null): CodexUsageSnapshot => ({ limits, primaryLimit, status: 'available', updatedAt: null, error: null });

describe('dashboard quota selection and pace', () => {
  it('selects only the general weekly limit even when Spark is primary and listed first', () => {
    const spark = bucket('codex_bengalfox', { ...week, windowDurationMins: 300 }, week);
    expect(overallUsageWindow(snapshot([spark, bucket('codex', null, week)], spark))).toBe(week);
    expect(overallUsageWindow(snapshot([spark], spark))).toBeNull();
  });
  it('uses the explicit codex map ahead of a stale legacy bucket', () => {
    expect(overallUsageWindow(snapshot([bucket('codex', week)], bucket('codex', { ...week, usedPercent: 90 })))).toBe(week);
  });
  it('does not show expired, invalid or future periods as current pace', () => {
    const reset = Date.parse(week.resetsAt!);
    expect(quotaPace(week, reset).expired).toBe(true);
    expect(quotaPace(week, reset).difference).toBeNull();
    expect(quotaPace({ ...week, resetsAt: 'invalid' }, reset).elapsed).toBeNull();
    expect(quotaPace(week, reset - 8 * 86400000).elapsed).toBeNull();
  });
  it('compares 23% usage to 14% elapsed without a projection', () => {
    const now = Date.parse(week.resetsAt!) - 0.86 * 10080 * 60000;
    expect(quotaPace(week, now).difference).toBeCloseTo(9);
    expect(quotaPace({ ...week, usedPercent: null }, now).difference).toBeNull();
  });
});

describe('task presentation', () => {
  it('preserves authored titles and hides internal-context previews', () => {
    expect(taskTitle({ id: '123456789', name: 'Revisar el capítulo', preview: '<instructions>text</instructions>' })).toBe('Revisar el capítulo');
    expect(taskTitle({ id: 'x', name: '[P1] System design review', preview: null })).toBe('[P1] System design review');
    for (const preview of ['<recommended_plugins>secret context</recommended_plugins>', '[transcription] words', 'You are Codex, an agent', 'The following is the Codex agent history added since your last approval assessment.']) {
      expect(taskTitle({ id: '123456789', name: null, preview })).toBe('Untitled task · 12345678');
    }
    expect(taskTitle({ id: 'x', name: null, preview: '# Improve monitor\nDetails' })).toBe('Improve monitor');
  });
  it('filters before sorting and keeps unknown usage below measured zero', () => {
    const jobs = [
      { id: 'a', name: 'Active', updatedAt: '2026-09-05T10:00:00Z', estimatedUsagePercentSinceReset: null },
      { id: 'b', name: 'Today', updatedAt: '2026-09-07T10:00:00Z', estimatedUsagePercentSinceReset: 0 },
      { id: 'c', name: 'Old', updatedAt: '2026-09-05T10:00:00Z', estimatedUsagePercentSinceReset: 9 }
    ] as HistoryJob[];
    const now = new Date(2026, 8, 7, 12).getTime();
    expect(visibleTasks(jobs, new Set(['a']), 'today', '', 'usage', now).map(j => j.id)).toEqual(['b', 'a']);
    expect(visibleTasks(jobs, new Set(['a']), 'active', '', 'usage', now).map(j => j.id)).toEqual(['a']);
    expect(visibleTasks(jobs, new Set(), 'all', 'Old', 'usage', now).map(j => j.id)).toEqual(['c']);
  });
  it('formats activity in English with an unknown-data fallback', () => {
    expect(relativeActivity('2026-09-07T10:00:00Z', Date.parse('2026-09-07T10:03:00Z'))).toBe('3 min ago');
    expect(relativeActivity('bad', Date.now())).toBe('Unknown');
  });
});
