// jxl-scheduler/test/helpers.ts
// Test doubles for scheduler integration tests.

import type { WorkerHandle, WorkerFactory } from "../src/types.js";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@casabio/jxl-core/protocol";

// A controllable fake worker for scheduler tests.
export class FakeWorker implements WorkerHandle {
  readonly messages: MainToWorkerMessage[] = [];
  private handlers: Array<(msg: WorkerToMainMessage) => void> = [];
  private _terminated = false;

  get terminated(): boolean {
    return this._terminated;
  }

  send(msg: MainToWorkerMessage, _transfer: ArrayBuffer[] = []): void {
    this.messages.push(msg);
  }

  onMessage(handler: (msg: WorkerToMainMessage) => void): void {
    this.handlers.push(handler);
  }

  // Emit a message "from the worker" to all registered handlers.
  emit(msg: WorkerToMainMessage): void {
    for (const h of this.handlers) h(msg);
  }

  async shutdown(_timeoutMs = 5000): Promise<void> {
    this._terminated = true;
  }
}

// Factory that creates a FakeWorker and keeps a reference so tests can
// drive it.
export function fakeWorkerFactory(store: FakeWorker[]): WorkerFactory {
  return async () => {
    const w = new FakeWorker();
    store.push(w);
    return w;
  };
}

// Minimal decode_start message fixture.
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";
export function makeDecodeStart(sessionId: string, priority: "visible" | "near" | "background" = "visible"): MsgDecodeStart {
  return {
    type: "decode_start",
    sessionId,
    format: "rgba8",
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: true,
    suppressDuplicateProgress: false,
    preserveIcc: true,
    preserveMetadata: true,
    priority,
    budgetMs: null,
    progressiveDetail: null,
    targetWidth: null,
    targetHeight: null,
    fitMode: null,
  };
}
