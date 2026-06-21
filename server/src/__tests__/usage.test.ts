import {
  codexUsageFromRateLimitsRead,
  codexUsageFromRateLimitsUpdated,
  emptyCodexUsage
} from "../usage";

describe("Codex usage normalization", () => {
  it("maps Codex primary and weekly windows into remaining percentages", () => {
    const usage = codexUsageFromRateLimitsRead(
      {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: 1777292438
          },
          secondary: {
            usedPercent: 19,
            windowDurationMins: 10080,
            resetsAt: 1777536841
          },
          planType: "prolite"
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: 1777292438
            },
            secondary: {
              usedPercent: 19,
              windowDurationMins: 10080,
              resetsAt: 1777536841
            },
            planType: "prolite"
          }
        }
      },
      "2026-04-27T10:00:00.000Z"
    );

    expect(usage.status).toBe("available");
    expect(usage.primaryLimit?.primary).toMatchObject({
      label: "5-hour",
      usedPercent: 10,
      remainingPercent: 90
    });
    expect(usage.primaryLimit?.secondary).toMatchObject({
      label: "Weekly",
      usedPercent: 19,
      remainingPercent: 81
    });
  });

  it("updates an existing limit from live app-server notifications", () => {
    const usage = codexUsageFromRateLimitsUpdated(
      {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 95,
            windowDurationMins: 300,
            resetsAt: 1777292438
          },
          secondary: {
            usedPercent: 40,
            windowDurationMins: 10080,
            resetsAt: 1777536841
          },
          rateLimitReachedType: "rate_limit_reached"
        }
      },
      emptyCodexUsage(),
      "2026-04-27T10:05:00.000Z"
    );

    expect(usage.primaryLimit?.primary?.remainingPercent).toBe(5);
    expect(usage.primaryLimit?.rateLimitReachedType).toBe("rate_limit_reached");
  });
});
