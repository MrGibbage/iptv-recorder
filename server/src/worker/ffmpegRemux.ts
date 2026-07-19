import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const STDERR_TAIL_MAX_CHARS = 4000;

export interface RemuxHandle {
  process: ChildProcessWithoutNullStreams;
  getStderrTail: () => string;
}

// Remux only, no re-encode (PLAN.md "Likely a remux (TS -> fragmented MP4)
// rather than a raw copy or a real transcode — cheap CPU-wise, but gives a
// saner, seekable file than raw MPEG-TS", decided 2026-07-19). The
// frag_keyframe+empty_moov flags produce a file that's valid even if ffmpeg
// is killed mid-recording, since MP4's moov atom never needs a final seek-
// back-and-write pass the way a plain `-movflags faststart` file would.
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
    "mp4",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    outputPath,
  ]);

  let stderrTail = "";
  process.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_CHARS);
  });

  return { process, getStderrTail: () => stderrTail };
}
