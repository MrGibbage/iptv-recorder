export type MediaType = "Video" | "Audio";

export interface StreamMappingResult {
  // False until ffmpeg's initial input/output stream negotiation is
  // observably complete (the "Stream mapping:" line has appeared) — before
  // that, missingTypes isn't meaningful yet.
  settled: boolean;
  missingTypes: MediaType[];
}

const STREAM_TYPE_RE = /Stream #\d+:\d+[^:]*:\s*(Video|Audio):/;

// Incrementally parses ffmpeg's stderr to catch a failure mode this
// recorder actually hit in practice (PLAN.md TODO2, 2026-07-24): a
// provider's mpegts declares a stream (in the field case, malformed AC-3
// audio) that ffmpeg's demuxer can detect but can't parse enough of to
// include in `-c copy`'s default "best per type" auto-mapping — so the
// process exits 0 having silently produced a video-only file. Settles
// within ~1-2s of ffmpeg starting (well before any meaningful recording
// duration), so the caller can abort early rather than only discovering
// this once the full scheduled window has completed.
//
// Deliberately scoped to Video/Audio only (subtitle/data streams aren't
// what makes a recording watchable), and to "a type present on input but
// entirely absent from output" rather than a raw stream-count comparison —
// a channel with two audio tracks (e.g. dual language) is expected to have
// ffmpeg's default auto-selection map only one of them, which is normal,
// not a failure. A source that's legitimately audio-only or video-only
// never trips this either, since it only ever declares the one type to
// begin with.
export class StreamMappingWatcher {
  private buffer = "";
  private inInputSection = false;
  private inOutputSection = false;
  private readonly inputTypes = new Set<MediaType>();
  private readonly outputTypes = new Set<MediaType>();
  private _result: StreamMappingResult = { settled: false, missingTypes: [] };

  get result(): StreamMappingResult {
    return this._result;
  }

  feed(chunk: string): StreamMappingResult {
    if (this._result.settled) {
      return this._result;
    }
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // keep a possibly-partial trailing line for the next chunk

    for (const line of lines) {
      this.consumeLine(line);
      if (this._result.settled) {
        break;
      }
    }
    return this._result;
  }

  private consumeLine(line: string): void {
    if (/^Input #0,/.test(line)) {
      this.inInputSection = true;
      return;
    }
    if (/^Output #0,/.test(line)) {
      this.inInputSection = false;
      this.inOutputSection = true;
      return;
    }
    // "Stream mapping:" always follows Output's own stream list, so
    // outputTypes is fully populated by the time we see it — the correct
    // point to settle. "Press [q]"/progress lines are a defensive fallback
    // for the (unobserved in practice) case ffmpeg's build omits that line.
    if (/^Stream mapping:/.test(line) || /^Press \[q\]/.test(line) || /^\s*(frame|size)=/.test(line)) {
      this.inOutputSection = false;
      const missingTypes = [...this.inputTypes].filter((type) => !this.outputTypes.has(type));
      this._result = { settled: true, missingTypes };
      return;
    }

    const match = STREAM_TYPE_RE.exec(line);
    if (!match) {
      return;
    }
    const type = match[1] as MediaType;
    if (this.inInputSection) {
      this.inputTypes.add(type);
    } else if (this.inOutputSection) {
      this.outputTypes.add(type);
    }
  }
}
