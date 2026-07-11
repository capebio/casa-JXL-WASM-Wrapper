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
  const base =
    reason instanceof Error && (reason as any).code === "ABORT_ERR"
      ? (reason as AbortStageError)
      : (Object.assign(new Error(`ingest aborted during ${stage}`), { code: "ABORT_ERR" as const }) as AbortStageError);
  if (base.stage === undefined) base.stage = stage;
  return base;
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
