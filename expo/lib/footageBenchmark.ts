/**
 * Footage speed benchmark (owner screen app/footage-benchmark.tsx): how long the existing renderer takes to cut a slice of a video at a given size, how
 * big the result is, and what that means for 60 minutes of footage on a given connection. Pure projection math, tested without a phone.
 */
export type BenchSample = { label: string; maxSide: number; sliceSeconds: number; wallMs: number; bytes: number };
export type BenchProjection = {
  label: string;
  secondsPerMinute: number;      // seconds of work for each minute of video
  mbPerMinute: number;
  mbps: number;                  // average bitrate of the result
  projectedMinutes: number;      // to prepare `totalSeconds` of footage, one cut at a time
  projectedGB: number;
  projectedUploadMinutes: number; // to upload that much at `uploadMbps`
  realtimeFactor: number;        // how many times faster than real time (60 = a minute of video per second)
};

export function project(s: BenchSample, totalSeconds = 3600, uploadMbps = 19, uploadEfficiency = 0.8): BenchProjection {
  const perVideoSecond = s.wallMs / 1000 / s.sliceSeconds;
  const bytesPerSecond = s.bytes / s.sliceSeconds;
  const totalBytes = bytesPerSecond * totalSeconds;
  const bytesPerSecondUp = (uploadMbps * 1_000_000 / 8) * uploadEfficiency;
  return {
    label: s.label,
    secondsPerMinute: perVideoSecond * 60,
    mbPerMinute: (bytesPerSecond * 60) / 1_000_000,
    mbps: (bytesPerSecond * 8) / 1_000_000,
    projectedMinutes: (perVideoSecond * totalSeconds) / 60,
    projectedGB: totalBytes / 1_000_000_000,
    projectedUploadMinutes: totalBytes / bytesPerSecondUp / 60,
    realtimeFactor: perVideoSecond > 0 ? 1 / perVideoSecond : 0,
  };
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
export function describeProjection(p: BenchProjection): string[] {
  return [
    `${p.label}: ${f1(p.secondsPerMinute)} s of work per minute of video (${f1(p.realtimeFactor)}x faster than real time)`,
    `size: ${f1(p.mbPerMinute)} MB per minute (${f1(p.mbps)} Mbps)`,
    `60 minutes: about ${f1(p.projectedMinutes)} min to prepare, ${f1(p.projectedGB)} GB, about ${f1(p.projectedUploadMinutes)} min to upload at 19 Mbps`,
  ];
}
