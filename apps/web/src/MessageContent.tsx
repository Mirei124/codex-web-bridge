import { Fragment, type ReactNode } from "react";

type PlanStatus = "pending" | "in_progress" | "completed";
type PlanItem = { step: string; status: PlanStatus };
type Plan = { explanation: string | null; plan: PlanItem[] };

function parsePlan(text: string): Plan | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      !("explanation" in value) ||
      !("plan" in value) ||
      !Array.isArray(value.plan) ||
      (value.explanation !== null && typeof value.explanation !== "string") ||
      !value.plan.every(
        (item) =>
          item &&
          typeof item === "object" &&
          "step" in item &&
          "status" in item &&
          typeof item.step === "string" &&
          (item.status === "pending" || item.status === "in_progress" || item.status === "completed"),
      )
    )
      return undefined;
    return value as Plan;
  } catch {
    return undefined;
  }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableDivider(line: string, columns: number): boolean {
  const cells = splitTableRow(line);
  return cells.length === columns && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\[[^\]]+\]\([^\s)]+\))/g);
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__")))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("~~") && part.endsWith("~~")) return <del key={index}>{part.slice(2, -2)}</del>;
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link && /^(https?:|mailto:)/i.test(link[2]))
      return (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(
        <pre key={blocks.length} className="markdown-code" data-language={language || undefined}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const tableHeader = splitTableRow(line);
    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1], tableHeader.length)) {
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = splitTableRow(lines[index]);
        if (row.length !== tableHeader.length) break;
        rows.push(row);
        index++;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={blocks.length} tabIndex={0}>
          <table className="markdown-table">
            <thead>
              <tr>
                {tableHeader.map((cell, cellIndex) => (
                  <th key={cellIndex}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={blocks.length}>{inline(heading[2])}</Tag>);
      index++;
      continue;
    }
    const list = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (list) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*[-*+]\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index++;
      }
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !/^#{1,6}\s+/.test(lines[index])
    )
      paragraph.push(lines[index++]);
    blocks.push(
      <p key={blocks.length}>
        {paragraph.map((part, partIndex) => (
          <Fragment key={partIndex}>
            {partIndex > 0 && <br />}
            {inline(part)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="markdown-content">{blocks}</div>;
}

const statusText: Record<PlanStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
};

function PlanCard({ plan }: { plan: Plan }) {
  const completed = plan.plan.filter((item) => item.status === "completed").length;
  const progress = plan.plan.length ? Math.round((completed / plan.plan.length) * 100) : 0;
  return (
    <section className="plan-card" aria-label="执行计划">
      <div className="plan-card-header">
        <div>
          <span aria-hidden="true">🗺️</span>
          <strong>执行计划</strong>
        </div>
        <span>
          {completed}/{plan.plan.length} 已完成
        </span>
      </div>
      {plan.explanation && <p className="plan-explanation">{plan.explanation}</p>}
      <div
        className="plan-progress"
        role="progressbar"
        aria-label="计划完成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <ol className="plan-steps">
        {plan.plan.map((item, index) => (
          <li key={`${item.step}-${index}`} className={`plan-step ${item.status}`}>
            <span className="plan-status" aria-label={statusText[item.status]}>
              {item.status === "completed" ? "✓" : item.status === "in_progress" ? "•" : "○"}
            </span>
            <span>{item.step}</span>
            <small>{statusText[item.status]}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function MessageContent({ text }: { text: string }) {
  const plan = parsePlan(text.trim());
  return plan ? <PlanCard plan={plan} /> : <Markdown text={text} />;
}
