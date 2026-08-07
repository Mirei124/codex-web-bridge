import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  data: string[];
  writable: boolean;
  onInput(data: string): void;
}
interface SnapshotProps {
  ansi: string;
  cols: number;
  rows: number;
}

export function Terminal({ data, writable, onInput }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const written = useRef(0);
  useEffect(() => {
    if (!element.current) return;
    const xterm = new XTerm({
      cursorBlink: writable,
      disableStdin: !writable,
      fontSize: 13,
      theme: { background: "#101411" },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element.current);
    fit.fit();
    const subscription = xterm.onData((data) => onInput(data === "\x7f" ? "\x08" : data));
    terminal.current = xterm;
    return () => {
      subscription.dispose();
      xterm.dispose();
      terminal.current = null;
      written.current = 0;
    };
  }, [onInput]);
  useEffect(() => {
    const xterm = terminal.current;
    if (!xterm) return;
    xterm.options.disableStdin = !writable;
    xterm.options.cursorBlink = writable;
  }, [writable]);
  useEffect(() => {
    for (; written.current < data.length; written.current++) terminal.current?.write(data[written.current]);
  }, [data]);
  return <div className="terminal" aria-label="Codex terminal" ref={element} />;
}

export function TerminalSnapshot({ ansi, cols, rows }: SnapshotProps) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const xterm = new XTerm({
      cols,
      rows,
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      theme: { background: "#101411" },
    });
    xterm.open(element.current);
    xterm.write(ansi);
    return () => xterm.dispose();
  }, [ansi, cols, rows]);
  return <div className="terminal-snapshot" aria-label="终端 ANSI 快照" ref={element} />;
}
