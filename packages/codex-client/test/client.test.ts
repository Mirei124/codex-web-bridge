import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CodexClient } from "../src/index.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING; sent: any[] = [];
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
  reply(id: number, result: unknown) { this.emit("message", Buffer.from(JSON.stringify({ id, result }))); }
}
describe("CodexClient", () => {
  it("handshakes, starts turns, and answers server requests", async () => {
    const socket = new FakeSocket(); const client = new CodexClient({ url: "ws://test", webSocketFactory: () => socket as unknown as WebSocket });
    const connected = client.connect(); socket.open(); await Promise.resolve(); socket.reply(1, {}); await connected;
    expect(socket.sent.slice(0, 2).map(x => x.method)).toEqual(["initialize", "initialized"]);
    const turn = client.startTurn("t1", "hello"); socket.reply(2, { turn: { id: "u1" } }); await turn;
    client.respondToUserInput(7, { q1: ["A"] });
    expect(socket.sent.at(-1)).toEqual({ id: 7, result: { answers: { q1: { answers: ["A"] } } } });
  });
  it("reports a clean transport close", async () => { const socket = new FakeSocket(); const client = new CodexClient({ url: "ws://test", webSocketFactory: () => socket as unknown as WebSocket }); const connected = client.connect(); socket.open(); await Promise.resolve(); socket.reply(1, {}); await connected; let closed = false; client.once("transportClose", () => closed = true); socket.close(); expect(closed).toBe(true); });
});
