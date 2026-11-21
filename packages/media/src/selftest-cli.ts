// `pnpm media:selftest`: renders and checks a synthetic video with the local FFmpeg (M6 risk R6).
// Exit code 0 when the render passes QC, 1 otherwise. Respects FFMPEG_PATH / FFPROBE_PATH.
import { DEFAULT_MEDIA_TOOLS } from './probe.js';
import { runRenderSelfTest } from './selftest.js';

const tools = {
  ...DEFAULT_MEDIA_TOOLS,
  ffmpegPath: process.env['FFMPEG_PATH'] ?? DEFAULT_MEDIA_TOOLS.ffmpegPath,
  ffprobePath: process.env['FFPROBE_PATH'] ?? DEFAULT_MEDIA_TOOLS.ffprobePath,
  timeoutMs: 120_000,
};

try {
  const result = await runRenderSelfTest(tools);
  console.info(`${result.ffmpeg}\nrendered in ${String(result.elapsedMs)} ms`);
  for (const [name, report] of [
    ['fixed mix (render.v1)', result.report],
    ['audio layers (render.v2)', result.layered],
  ] as const) {
    console.info(`${name}: ${JSON.stringify(report.measured)}`);
    for (const f of report.findings) console.info(`  ${f.severity}: ${f.check}: ${f.message}`);
  }
  const passed = result.report.passed && result.layered.passed;
  console.info(passed ? '✔ render self-test passed' : '✖ render self-test failed');
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(`✖ render self-test failed: ${error instanceof Error ? error.message : 'unknown'}`);
  process.exitCode = 1;
}
