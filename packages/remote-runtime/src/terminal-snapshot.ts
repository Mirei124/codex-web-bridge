import canvas from "@napi-rs/canvas";
import xtermHeadless from "@xterm/headless";

const { createCanvas, GlobalFonts } = canvas;
const { Terminal } = xtermHeadless;
const BG = "#1a1b26";
const FG = "#c0caf5";
const CELL_WIDTH = 9;
const CELL_HEIGHT = 18;
const PADDING = 8;
const DEFAULT_FONT_FAMILY = [
  "FiraCode Nerd Font Mono",
  "Fira Code",
  "Noto Sans Mono CJK SC",
  "Noto Sans Mono",
  "DejaVu Sans Mono",
  "Menlo",
  "Consolas",
].filter(family => GlobalFonts.has(family)).map(family => `"${family}"`).join(", ") || "sans-serif";

export interface TerminalSnapshotOptions { cols: number; rows: number; fontFamily?: string; fontSize?: number }
export interface RenderedTerminalSnapshot { png: Buffer; text: string; cols: number; rows: number }

/** Stateless rendering avoids ANSI parser drift between captures. */
export class TerminalSnapshotRenderer {
  static readonly minCols = 20; static readonly maxCols = 240;
  static readonly minRows = 5; static readonly maxRows = 100;

  async render(ansi: string, options: TerminalSnapshotOptions): Promise<RenderedTerminalSnapshot> {
    const cols = clamp(options.cols, TerminalSnapshotRenderer.minCols, TerminalSnapshotRenderer.maxCols);
    const rows = clamp(options.rows, TerminalSnapshotRenderer.minRows, TerminalSnapshotRenderer.maxRows);
    const terminal = new Terminal({ cols, rows, allowProposedApi: true });
    try {
      await new Promise<void>(resolve => terminal.write(ansi, resolve));
      const startY = terminal.buffer.active.baseY;
      const image = createCanvas(PADDING * 2 + cols * CELL_WIDTH, PADDING * 2 + rows * CELL_HEIGHT);
      const context = image.getContext("2d");
      context.fillStyle = BG; context.fillRect(0, 0, image.width, image.height);
      context.textBaseline = "top"; context.font = `${options.fontSize ?? 14}px ${options.fontFamily ?? DEFAULT_FONT_FAMILY}`;
      const lines: string[] = [];
      for (let row = 0; row < rows; row++) {
        const line = terminal.buffer.active.getLine(startY + row); if (!line) { lines.push(""); continue; }
        lines.push(line.translateToString(true, 0, cols));
        for (let column = 0; column < cols;) {
          const cell = line.getCell(column); if (!cell) { column++; continue; }
          const width = cell.getWidth(); if (width === 0) { column++; continue; }
          let foreground = cell.isFgRGB() ? rgb(cell.getFgColor()) : FG;
          let background = cell.isBgRGB() ? rgb(cell.getBgColor()) : undefined;
          if (cell.isInverse()) { const swap = foreground; foreground = background ?? BG; background = swap; }
          const x = PADDING + column * CELL_WIDTH, y = PADDING + row * CELL_HEIGHT;
          if (background) { context.fillStyle = background; context.fillRect(x, y, CELL_WIDTH * width, CELL_HEIGHT); }
          const chars = cell.getChars();
          if (chars && chars !== " ") { context.fillStyle = foreground; context.font = `${cell.isBold() ? "bold " : ""}${options.fontSize ?? 14}px ${options.fontFamily ?? DEFAULT_FONT_FAMILY}`; context.fillText(chars, x, y + 1); }
          column += width;
        }
      }
      while (lines.at(-1) === "") lines.pop();
      return { png: image.toBuffer("image/png"), text: lines.join("\n"), cols, rows };
    } finally { terminal.dispose(); }
  }
}
function clamp(value: number, minimum: number, maximum: number): number { if (!Number.isFinite(value)) return minimum; return Math.max(minimum, Math.min(maximum, Math.floor(value))); }
function rgb(value: number): string { return `#${value.toString(16).padStart(6, "0")}`; }
