// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { axe } from "vitest-axe";
import "@testing-library/jest-dom";
import type { ChatMessage } from "../types.js";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

import { MessageBubble } from "./MessageBubble.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: "msg-auth-error",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

// Builds an assistant message whose tool_result is optionally linked to a
// tool_use block (so the component can resolve the originating tool name).
function makeToolResult(
  content: string,
  opts: { toolName?: string; isError?: boolean } = {},
): ChatMessage {
  const { toolName, isError = true } = opts;
  const blocks: NonNullable<ChatMessage["contentBlocks"]> = [];
  if (toolName) {
    blocks.push({ type: "tool_use", id: "tu-1", name: toolName, input: {} });
  }
  blocks.push({
    type: "tool_result",
    tool_use_id: "tu-1",
    content,
    is_error: isError,
  });
  return makeMessage({ role: "assistant", contentBlocks: blocks });
}

describe("MessageBubble auth-related tool errors", () => {
  it("renders a concise authentication block instead of raw provider JSON", () => {
    // Mirrors the provider payload from failed web-search/tool auth so the
    // user sees the actionable message rather than an opaque JSON blob.
    const msg = makeToolResult(
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_123"}',
    );

    render(<MessageBubble message={msg} />);

    expect(screen.getAllByText("Authentication failed").length).toBeGreaterThan(0);
    expect(screen.getByText("Invalid authentication credentials (API 401)")).toBeTruthy();
    expect(screen.getByText("Request ID: req_123")).toBeTruthy();
    // Raw JSON is hidden behind the disclosure, not rendered inline.
    expect(screen.queryByText(/"type":"authentication_error"/)).toBeNull();
  });

  it("keeps non-auth tool errors unchanged", () => {
    // Guardrail: only auth-shaped payloads get special formatting.
    const msg = makeToolResult("Error: file not found");

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Error: file not found")).toBeTruthy();
    expect(screen.queryByText("Request ID: req_123")).toBeNull();
  });

  // The error nature must not depend on the red color token alone (WCAG 1.4.1);
  // role="status" + the labelled heading carry the meaning for AT users. The
  // axe scan guards the whole card per CLAUDE.md's mandatory a11y gate.
  it("passes axe and exposes the error semantically without relying on color", async () => {
    const msg = makeToolResult(
      'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Forbidden"},"request_id":"req_xyz"}',
    );

    const { container } = render(<MessageBubble message={msg} />);

    const status = screen.getByRole("status");
    expect(status).toHaveAccessibleName("Authentication failed");

    expect(await axe(container)).toHaveNoViolations();
  });

  // The raw payload stays available for debugging but is collapsed by default,
  // toggled via an aria-expanded button (a11y disclosure pattern).
  it("toggles the raw payload via the Show raw disclosure", () => {
    const raw =
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"bad key"},"request_id":"req_9"}';
    const msg = makeToolResult(raw);

    render(<MessageBubble message={msg} />);

    const toggle = screen.getByRole("button", { name: "Show raw" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/"authentication_error"/)).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/"authentication_error"/)).toBeTruthy();
  });

  // False-positive guard (P1 #4): a filesystem/search tool whose body merely
  // mentions auth strings (e.g. a grep over source) must NOT be reframed.
  it("does not reframe a non-provider tool body that merely mentions auth", () => {
    const msg = makeToolResult(
      'match: throw new Error("authentication_error: invalid api key")',
      { toolName: "Grep" },
    );

    render(<MessageBubble message={msg} />);

    expect(screen.queryByText("Authentication failed")).toBeNull();
    expect(screen.getByText(/authentication_error: invalid api key/)).toBeTruthy();
  });

  // Plaintext OpenAI/codex shape with no JSON envelope: a high-signal full
  // phrase still triggers the card; there is no request id or status to show.
  it("reframes a plaintext provider auth phrase with no envelope", () => {
    const msg = makeToolResult("Incorrect API key provided: sk-***. You can find your API key…");

    render(<MessageBubble message={msg} />);

    // No envelope message → heading and body both read "Authentication failed".
    expect(screen.getAllByText("Authentication failed").length).toBeGreaterThan(0);
    // No request_id in this body → the Request ID line is absent.
    expect(screen.queryByText(/Request ID:/)).toBeNull();
  });

  // Envelope-only auth (error.type matches) with no numeric status: the message
  // renders without an "(API NNN)" suffix.
  it("reframes an envelope auth error that carries no status code", () => {
    const msg = makeToolResult(
      '{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
    );

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Authentication failed")).toBeTruthy();
    // Message has no "(API …)" suffix because no status was present.
    expect(screen.getByText("OAuth token has expired")).toBeTruthy();
    expect(screen.queryByText(/\(API/)).toBeNull();
  });

  // Robustness (Willison F5): a provider envelope that arrives as an escaped /
  // stringified object (extra prefix + trailing text) is still parsed by the
  // bounded JSON extractor.
  it("extracts an envelope embedded in surrounding text", () => {
    const msg = makeToolResult(
      'tool failed -> {"type":"error","error":{"type":"invalid_api_key","message":"Invalid x-api-key"},"request_id":"req_embed"} (see logs)',
    );

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Authentication failed")).toBeTruthy();
    expect(screen.getByText("Request ID: req_embed")).toBeTruthy();
  });
});
