import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { terminateSpawnedDaemon } from "./startup-transaction.js";

describe("daemon startup transaction", () => {
  it("does not return until the spawned daemon has exited", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null, signalCode: null });
    const signals: NodeJS.Signals[] = [];
    child.kill = ((signal?: NodeJS.Signals | number) => {
      signals.push(signal as NodeJS.Signals);
      setTimeout(() => {
        Object.assign(child, { signalCode: signal });
        child.emit("exit", null, signal);
      }, 10);
      return true;
    }) as ChildProcess["kill"];

    await terminateSpawnedDaemon(child, 100);

    expect(signals).toEqual(["SIGTERM"]);
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("escalates a daemon that ignores SIGTERM before returning", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null, signalCode: null });
    const signals: NodeJS.Signals[] = [];
    child.kill = ((signal?: NodeJS.Signals | number) => {
      signals.push(signal as NodeJS.Signals);
      if (signal === "SIGKILL") {
        Object.assign(child, { signalCode: signal });
        child.emit("exit", null, signal);
      }
      return true;
    }) as ChildProcess["kill"];

    await terminateSpawnedDaemon(child, 5);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
