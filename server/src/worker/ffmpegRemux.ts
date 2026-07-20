import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const STDERR_TAIL_MAX_CHARS = 4000;

export interface RemuxHandle {
  process: ChildProcessWithoutNullStreams;
  getStderrTail: () => string;
}

// Remux only, no re-encode, into MPEG-TS (revised 2026-07-20 — see PLAN.md
// "Remux vs raw store" / Recording worker for the full history). Originally
// this wrote fragmented MP4 (`-f mp4 -movflags +frag_keyframe+empty_moov+
// default_base_moof`), but that was only ever verified against a synthetic
// lavfi testsrc/sine source. Against a real Xtream channel it failed on
// ADTS-framed AAC audio ("Malformed AAC bitstream ... use the audio
// bitstream filter 'aac_adtstoasc'") — MP4 requires AAC in raw/LATM framing,
// not ADTS, and a per-codec bitstream-filter fix would only have deferred
// the same class of failure to the next channel carrying MP2 or AC-3/E-AC-3
// (MP2 has no defined MP4 sample entry at all; ffmpeg refuses it outright).
// The source stream is already MPEG-TS (Xtream's `/live/.../id.ts`), so
// `-c copy` into `-f mpegts` needs zero bitstream translation for any
// codec combination a provider might send. Crash-safety is unaffected: TS
// packets are self-contained (no moov/moof to finalize), the same property
// the old movflags were approximating for MP4.
export function startRemux(inputUrl: string, outputPath: string, durationSeconds: number): RemuxHandle {
  const process = spawn("ffmpeg", [
    "-y",
    "-i",
    inputUrl,
    "-t",
    String(Math.max(durationSeconds, 0)),
    "-c",
    "copy",
    "-f",
    "mpegts",
    outputPath,
  ]);

  let stderrTail = "";
  process.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_CHARS);
  });

  return { process, getStderrTail: () => stderrTail };
}
