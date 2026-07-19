export interface ByteRange {
  start: number;
  end: number;
}

// Parses a single-range `Range: bytes=start-end` header (the form every
// browser/video player actually sends for seeking) against a known file
// size. Multi-range (`bytes=0-99,200-299`) isn't supported — no seeking
// client relies on it, and supporting it would mean a multipart response.
//
// Returns:
//   null            — no Range header; caller serves the whole file (200)
//   "unsatisfiable"  — malformed or out-of-bounds; caller responds 416
//   ByteRange        — caller responds 206 with this slice
export function parseRange(rangeHeader: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return "unsatisfiable";
  }

  let start: number;
  let end: number;
  if (match[1] === "") {
    // Suffix range, e.g. "bytes=-500" = last 500 bytes.
    const suffixLength = Number(match[2]);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= size) {
    return "unsatisfiable";
  }

  return { start, end };
}
