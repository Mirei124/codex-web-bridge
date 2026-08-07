import { describe, expect, it } from "vitest";
import { serverEventThreadId } from "./index.js";

describe("server event routing", () => {
  it("routes model updates by their direct thread id", () => {
    expect(serverEventThreadId({ type: "thread.model.updated", threadId: "thread-1", model: "gpt-5.6-sol" })).toBe(
      "thread-1",
    );
  });
});
