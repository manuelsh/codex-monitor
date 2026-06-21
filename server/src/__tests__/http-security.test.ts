import { isAllowedBrowserOrigin } from "../http-security";

describe("isAllowedBrowserOrigin", () => {
  it("allows missing and loopback browser origins", () => {
    expect(isAllowedBrowserOrigin(undefined)).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.42.0.1:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://[::1]:5173")).toBe(true);
  });

  it("rejects non-loopback and non-http origins", () => {
    expect(isAllowedBrowserOrigin("https://example.com")).toBe(false);
    expect(isAllowedBrowserOrigin("http://127.0.0.1.example.com")).toBe(false);
    expect(isAllowedBrowserOrigin("file://local-dashboard")).toBe(false);
    expect(isAllowedBrowserOrigin("null")).toBe(false);
    expect(isAllowedBrowserOrigin("not a url")).toBe(false);
  });
});
