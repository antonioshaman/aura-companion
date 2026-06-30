// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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

describe("MessageBubble auth-related tool errors", () => {
  it("renders a concise authentication block instead of raw provider JSON", () => {
    // Mirrors the provider payload from failed web-search/tool auth so the
    // user sees the actionable message rather than an opaque JSON blob.
    const msg = makeMessage({
      role: "assistant",
      contentBlocks: [
        {
          type: "tool_result",
          tool_use_id: "tu-auth",
          content:
            'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_123"}',
          is_error: true,
        },
      ],
    });

    render(<MessageBubble message={msg} />);

    expect(screen.getAllByText("Authentication failed").length).toBeGreaterThan(0);
    expect(screen.getByText("Invalid authentication credentials (API 401)")).toBeTruthy();
    expect(screen.getByText("Request ID: req_123")).toBeTruthy();
    expect(screen.queryByText(/"type":"authentication_error"/)).toBeNull();
  });

  it("keeps non-auth tool errors unchanged", () => {
    // Guardrail: only auth-shaped payloads get special formatting.
    const msg = makeMessage({
      role: "assistant",
      contentBlocks: [
        {
          type: "tool_result",
          tool_use_id: "tu-generic",
          content: "Error: file not found",
          is_error: true,
        },
      ],
    });

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Error: file not found")).toBeTruthy();
    expect(screen.queryByText("Request ID: req_123")).toBeNull();
  });
});
