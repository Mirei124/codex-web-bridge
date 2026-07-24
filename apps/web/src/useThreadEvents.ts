import { useEffect, useRef } from "react";
import type { ClientEvent, ServerEvent } from "@cwb/protocol";
import { currentCsrfToken } from "./api";

export function useThreadEvents(threadIds: string[], onEvent: (event: ServerEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const subscriptionKey = [...threadIds].sort().join("\0");

  useEffect(() => {
    const subscribedThreadIds = subscriptionKey ? subscriptionKey.split("\0") : [];
    if (!subscribedThreadIds.length) return;
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
      socket.onopen = () => { attempt = 0; for (const threadId of subscribedThreadIds) send({ type: "subscribe", threadId }); };
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
      if (socket?.readyState === WebSocket.OPEN) for (const threadId of subscribedThreadIds) send({ type: "unsubscribe", threadId });
      socket?.close();
    };
  }, [subscriptionKey]);
}
