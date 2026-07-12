// finding 67 (Task 6): abortable-deadline primitives shared by the ingest pipeline and the ladder.
//
// One combined AbortSignal per image is composed from the caller's cancel signal + a deadline
// controller (see makeImageSignal in ingest.ts). Every stage boundary calls throwIfAborted so that a
// timed-out or caller-cancelled image stops *before* it can start the next expensive stage or publish
// any artifact. The thrown error is a DOM-standard "ABORT_ERR" tagged with the pipeline stage.

export type IngestStage = "read" | "decode" | "encode" | "publish";

export interface AbortStageError extends Error {
  code: "ABORT_ERR";
  stage?: IngestStage;
}

export function makeAbortError(stage: IngestStage, reason?: unknown): AbortStageError {
  // When the caller-supplied reason is itself a coded ABORT_ERR (e.g. one shared AbortSignal.reason
  // reused across a batch), CLONE it rather than mutating it in place. Mutating the shared reason's
  // `.stage` would make every later image in the batch report the first image's stage.
  const base =
    reason instanceof Error && (reason as any).code === "ABORT_ERR"
      ? (reason as AbortStageError)
      : (Object.assign(new Error(`ingest aborted during ${stage}`), { code: "ABORT_ERR" as const }) as AbortStageError);
  return Object.assign(new Error(base.message), {
    code: "ABORT_ERR" as const,
    stack: base.stack,
    stage: base.stage ?? stage,
  }) as AbortStageError;
}

/** Throw a stage-tagged ABORT_ERR if the combined signal has already fired. */
export function throwIfAborted(signal: AbortSignal | undefined, stage: IngestStage): void {
  if (signal?.aborted) throw makeAbortError(stage, (signal as any).reason);
}

export function isAbortError(e: unknown): boolean {
  return !!e && ((e as any).code === "ABORT_ERR" || (e as any).name === "AbortError");
}

export function inferStage(e: unknown, fallback: IngestStage): IngestStage {
  const s = (e as any)?.stage;
  return s === "read" || s === "decode" || s === "encode" || s === "publish" ? s : fallback;
}
