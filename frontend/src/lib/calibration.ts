import type { FrameAnalysis } from "./quality-core";

/** Flattens core metrics to `group.metric` keys, the same shape as the server diagnostics. */
export function flattenMetrics(metrics: FrameAnalysis["metrics"]) {
  const output: Record<string, number> = {};
  for (const [group, values] of Object.entries({ geometry: metrics.geometry, image: metrics.image }))
    if (values)
      for (const [key, value] of Object.entries(values))
        output[`${group}.${key}`] = Math.round(value * 10_000) / 10_000;
  if (metrics.cornerMotion !== undefined) output.cornerMotion = Math.round(metrics.cornerMotion * 10_000) / 10_000;
  return output;
}

/** Compact report of one analysed frame, streamed by the calibration phone to the workstation. */
export function calibrationSummary(
  analysis: FrameAnalysis,
  telemetry?: { stablePasses: number; camera: { width: number; height: number; label: string; torch: boolean } },
) {
  return {
    score: analysis.evaluation.score,
    passed: analysis.evaluation.passed,
    hint: analysis.evaluation.hint,
    quad: analysis.quad,
    metrics: flattenMetrics(analysis.metrics),
    checks: analysis.evaluation.checks.map(({ key, status, value, threshold }) => ({ key, status, value, threshold })),
    durationMs: analysis.durationMs.total,
    ...(telemetry ? { stablePasses: telemetry.stablePasses, camera: telemetry.camera } : {}),
  };
}

export type ClientFrameReport = ReturnType<typeof calibrationSummary>;
