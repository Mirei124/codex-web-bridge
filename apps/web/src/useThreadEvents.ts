import { useEffect, useRef } from "react";
import type { ClientEvent, ServerEvent } from "@cwb/protocol";
import { currentCsrfToken } from "./api";

export function useThreadEvents(threadId: string | undefined, onEvent: (event: ServerEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!threadId) return;
    const selectedThreadId = threadId;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const send = (event: ClientEvent) => socket?.send(JSON.stringify(event));

    function connect() {
      const csrf = currentCsrfToken();
      const query = csrf ? `?csrf=${encodeURIComponent(csrf)}` : "";
      socket = new WebSocket(`${scheme}//${location.host}/api/events${query}`);
      socket.onopen = () => { attempt = 0; send({ type: "subscribe", threadId: selectedThreadId }); };
      socket.onmessage = ({ data }) => handler.current(JSON.parse(String(data)) as ServerEvent);
      socket.onclose = () => {
        if (stopped) return;
        retry = setTimeout(connect, Math.min(1_000 * 2 ** attempt++, 10_000));
      };
    }
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (socket?.readyState === WebSocket.OPEN) send({ type: "unsubscribe", threadId: selectedThreadId });
      socket?.close();
    };
  }, [threadId]);
}
