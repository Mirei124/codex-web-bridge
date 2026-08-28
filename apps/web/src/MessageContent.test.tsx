import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageContent } from "./MessageContent";

describe("MessageContent", () => {
  afterEach(cleanup);

  it("renders GFM-style tables as an accessible scrollable table", () => {
    const { container } = render(
      <MessageContent
        text={"| 状态 | 说明 |\n| --- | --- |\n| **完成** | 支持 `code` 和 [链接](https://example.com) |"}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "状态" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "链接" })).toHaveAttribute("href", "https://example.com");
    expect(container.querySelector(".markdown-table-wrap")).toHaveAttribute("tabindex", "0");
  });

  it("turns a complete plan payload into a progress card", () => {
    render(
      <MessageContent
        text={JSON.stringify({
          explanation: null,
          plan: [
            { step: "核对设计", status: "in_progress" },
            { step: "更新文档", status: "pending" },
            { step: "完成验证", status: "completed" },
          ],
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "执行计划" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "计划完成进度" })).toHaveAttribute("aria-valuenow", "33");
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("keeps unrelated JSON as regular message content", () => {
    render(<MessageContent text={'{"unexpected": true}'} />);

    expect(screen.queryByRole("region", { name: "执行计划" })).not.toBeInTheDocument();
    expect(screen.getByText('{"unexpected": true}')).toBeInTheDocument();
  });
});
