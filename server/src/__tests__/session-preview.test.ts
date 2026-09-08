import { userPreview } from "../../../shared/session-preview";
import { parseHistorySessionFile } from "../history-jobs";

it("extracts the request after setup before truncating", () => {
  expect(userPreview(`<recommended_plugins>${"setup ".repeat(100)}</recommended_plugins>\nFix the monitor`)).toBe("Fix the monitor");
  expect(userPreview('<realtime_delegation><input>Review my document</input><transcript_delta>context</transcript_delta></realtime_delegation>')).toBe("Review my document");
});

it("does not overwrite a real request with injected context", () => {
  const fileContent = ["Fix the monitor", "<environment_context>setup</environment_context>"].map(text => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })).join("\n");
  expect(parseHistorySessionFile({ sessionId: "task", fileContent, updatedAt: new Date().toISOString(), nowMs: Date.now() })?.preview).toBe("Fix the monitor");
});
