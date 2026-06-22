/**
 * concatMP4 — Concatenates multiple MP4 files into a single continuous video.
 *
 * All input files MUST share identical encoding parameters (same codec, resolution,
 * frame rate, audio sample rate) — which is guaranteed when all segments come from
 * the same expo-camera session. The concatenation is done at the MP4 box level
 * WITHOUT re-encoding, so it is fast and lossless.
 *
 * Uses expo-file-system (base64 read/write) and base64-arraybuffer for binary I/O.
 *
 * NOTE: This implementation correctly handles multi-track files (video + audio)
 * by storing and rebuilding per-track sample tables independently. A previous
 * version only stored the first track's data, causing audio tracks to be rebuilt
 * with video sample tables — producing corrupt, unplayable files.
 */

import { EncodingType, getInfoAsync, readAsStringAsync, writeAsStringAsync } from "@/lib/fileSystemCompat";
import { decode, encode } from "base64-arraybuffer";

// ── Binary helpers ────────────────────────────────────────────────────────────

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Read a 32-bit big-endian unsigned integer from buffer at offset */
function readU32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! << 24) |
    (buf[offset + 1]! << 16) |
    (buf[offset + 2]! << 8) |
    buf[offset + 3]!
  ) >>> 0;
}

/** Write a 32-bit big-endian unsigned integer to buffer at offset */
function writeU32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** Read 4-character box type */
function readType(buf: Uint8Array, offset: number): string {
  return textDecoder.decode(buf.slice(offset, offset + 4));
}

/** Write 4-character box type */
function writeType(buf: Uint8Array, offset: number, type: string): void {
  const bytes = textEncoder.encode(type);
  buf.set(bytes, offset);
}

// ── MP4 Box types ─────────────────────────────────────────────────────────────

interface Mp4Box {
  type: string;
  offset: number; // byte offset in the source buffer
  size: number; // total box size including header
  dataOffset: number; // offset to box payload (after size+type)
  dataSize: number; // payload size
  children: Mp4Box[];
}

/** Parse a single box header. Returns null if out of bounds. */
function parseBoxHeader(
  buf: Uint8Array,
  offset: number,
): { type: string; size: number; headerSize: number } | null {
  if (offset + 8 > buf.length) return null;
  let size = readU32(buf, offset);
  const type = readType(buf, offset + 4);
  let headerSize = 8;

  if (size === 1 && offset + 16 <= buf.length) {
    // 64-bit extended size
    const hi = readU32(buf, offset + 8);
    const lo = readU32(buf, offset + 12);
    // Only handle sizes up to Number.MAX_SAFE_INTEGER (53 bits)
    size = hi * 0x100000000 + lo;
    headerSize = 16;
    if (size < 16) return null; // invalid
  } else if (size === 0) {
    // Box extends to end of file
    size = buf.length - offset;
  }

  if (offset + size > buf.length) return null; // truncated
  return { type, size, headerSize };
}

/** Parse all boxes at the current level, returns array of child boxes */
function parseBoxes(buf: Uint8Array, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;

  while (offset + 8 <= end) {
    const header = parseBoxHeader(buf, offset);
    if (!header) break;

    const { type, size, headerSize } = header;
    const dataOffset = offset + headerSize;
    const dataSize = size - headerSize;

    // Only recurse into container boxes — avoids parsing large mdat payloads
    const isContainer =
      type === "moov" ||
      type === "trak" ||
      type === "mdia" ||
      type === "minf" ||
      type === "stbl" ||
      type === "dinf" ||
      type === "edts" ||
      type === "udta";

    const children: Mp4Box[] = isContainer
      ? parseBoxes(buf, dataOffset, dataOffset + dataSize)
      : [];

    boxes.push({
      type,
      offset,
      size,
      dataOffset,
      dataSize,
      children,
    });

    offset += size;
  }

  return boxes;
}

/** Find a direct child box by type (non-recursive, one level only) */
function findChild(box: Mp4Box, type: string): Mp4Box | null {
  return box.children.find((c) => c.type === type) ?? null;
}

/** Walk path like ["moov", "trak", "mdia", "minf", "stbl", "stco"] */
function boxAtPath(root: Mp4Box, path: string[]): Mp4Box | null {
  let current = root;
  for (const type of path) {
    const child = findChild(current, type);
    if (!child) return null;
    current = child;
  }
  return current;
}

// ── Sample table parsing ──────────────────────────────────────────────────────

interface SttsEntry {
  sampleCount: number;
  sampleDelta: number;
}

interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
  sampleDescriptionIndex: number;
}

function parseStts(buf: Uint8Array, box: Mp4Box): SttsEntry[] {
  // stts fullbox: version(1) + flags(3) + entry_count(4) + entries
  const view = new DataView(buf.buffer, buf.byteOffset + box.dataOffset + 4, box.dataSize - 4);
  const entryCount = view.getUint32(0);
  const entries: SttsEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    entries.push({
      sampleCount: view.getUint32(4 + i * 8),
      sampleDelta: view.getUint32(8 + i * 8),
    });
  }
  return entries;
}

function parseStsc(buf: Uint8Array, box: Mp4Box): StscEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset + box.dataOffset + 4, box.dataSize - 4);
  const entryCount = view.getUint32(0);
  const entries: StscEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    entries.push({
      firstChunk: view.getUint32(4 + i * 12),
      samplesPerChunk: view.getUint32(8 + i * 12),
      sampleDescriptionIndex: view.getUint32(12 + i * 12),
    });
  }
  return entries;
}

function parseStsz(buf: Uint8Array, box: Mp4Box): number[] {
  const view = new DataView(buf.buffer, buf.byteOffset + box.dataOffset + 4, box.dataSize - 4);
  const sampleSize = view.getUint32(0);
  const sampleCount = view.getUint32(4);
  if (sampleSize !== 0) {
    // All samples have the same size
    return new Array(sampleCount).fill(sampleSize);
  }
  const sizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sizes.push(view.getUint32(8 + i * 4));
  }
  return sizes;
}

interface ChunkOffsetTable {
  is64: boolean; // true = co64, false = stco
  offsets: number[];
}

function parseChunkOffsets(buf: Uint8Array, box: Mp4Box): ChunkOffsetTable {
  const is64 = box.type === "co64";
  const view = new DataView(buf.buffer, buf.byteOffset + box.dataOffset + 4, box.dataSize - 4);
  const entryCount = view.getUint32(0);
  const offsets: number[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (is64) {
      const hi = view.getUint32(4 + i * 8);
      const lo = view.getUint32(8 + i * 8);
      offsets.push(hi * 0x100000000 + lo);
    } else {
      offsets.push(view.getUint32(4 + i * 4));
    }
  }
  return { is64, offsets };
}

// ── Per-track sample table data ───────────────────────────────────────────────

/** Sample table data for a single track (video or audio) in one input file */
interface TrackTableData {
  chunkTable: ChunkOffsetTable;
  stszSizes: number[];
  stscEntries: StscEntry[];
  sttsEntries: SttsEntry[];
  numChunks: number;
}

// ── mdat extraction ───────────────────────────────────────────────────────────

interface MdatInfo {
  /** Offset of the mdat box in the source file */
  fileOffset: number;
  /** Offset of the mdat payload (where actual media data starts) */
  payloadOffset: number;
  /** Size of the mdat payload (media data only, excluding box header) */
  payloadSize: number;
  /** The raw buffer containing this file */
  buffer: Uint8Array;
}

function findMdatBox(boxes: Mp4Box[]): Mp4Box | null {
  for (const box of boxes) {
    if (box.type === "mdat") return box;
    // Some files have mdat inside other containers (rare)
    const found = findMdatBox(box.children);
    if (found) return found;
  }
  return null;
}

// ── Main types ────────────────────────────────────────────────────────────────

interface SegmentInfo {
  boxes: Mp4Box[];
  mdat: MdatInfo;
  moovBox: Mp4Box;
  /** Per-track sample table data — tracks[0] = video, tracks[1] = audio (usually) */
  tracks: TrackTableData[];
}

// ── Read / write helpers ─────────────────────────────────────────────────────

async function readFileAsBuffer(uri: string): Promise<Uint8Array> {
  const base64 = await readAsStringAsync(uri, {
    encoding: EncodingType.Base64,
  });
  if (!base64 || base64.length === 0) {
    throw new Error(`Empty file: ${uri.slice(0, 60)}`);
  }
  return new Uint8Array(decode(base64));
}

async function writeBufferToFile(uri: string, buf: Uint8Array): Promise<void> {
  const base64 = encode(buf.buffer as ArrayBuffer);
  await writeAsStringAsync(uri, base64, {
    encoding: EncodingType.Base64,
  });
}

// ── Duration helper ───────────────────────────────────────────────────────────

/** Compute total duration for a specific track index across all segments */
function computeTrackDuration(allSegments: SegmentInfo[], trakIdx: number): number {
  let totalDuration = 0;
  for (const seg of allSegments) {
    const track = seg.tracks[trakIdx];
    if (!track) continue;
    for (const entry of track.sttsEntries) {
      totalDuration += entry.sampleCount * entry.sampleDelta;
    }
  }
  return totalDuration;
}

// ── Chunk size computation ────────────────────────────────────────────────────

/**
 * Compute total size of all chunks in a file (from stco offsets through to end of mdat).
 * Each chunk's size is determined by the sample sizes of samples that belong to it.
 */
function computeChunkSizes(
  stscEntries: StscEntry[],
  stszSizes: number[],
  numChunks: number,
): number[] {
  const chunkSizes: number[] = new Array(numChunks).fill(0);

  // Build a chunk→(samplesPerChunk, descIndex) map
  const chunkMap: Map<number, { samplesPerChunk: number }> = new Map();
  for (let i = 0; i < stscEntries.length; i++) {
    const entry = stscEntries[i]!;
    const nextFirstChunk =
      i + 1 < stscEntries.length ? stscEntries[i + 1]!.firstChunk : numChunks + 1;
    for (let c = entry.firstChunk; c < nextFirstChunk; c++) {
      chunkMap.set(c, { samplesPerChunk: entry.samplesPerChunk });
    }
  }

  let sampleIdx = 0;
  for (let c = 1; c <= numChunks; c++) {
    const info = chunkMap.get(c);
    if (!info) continue;
    for (let s = 0; s < info.samplesPerChunk && sampleIdx < stszSizes.length; s++) {
      chunkSizes[c - 1] += stszSizes[sampleIdx]!;
      sampleIdx++;
    }
  }

  return chunkSizes;
}

// ── Main concatenation logic ──────────────────────────────────────────────────

/**
 * Concatenate multiple MP4 video files into a single continuous MP4 file.
 *
 * All input files must have been recorded with the same camera settings
 * (identical codec, resolution, frame rate). This is guaranteed when
 * all URIs come from the same expo-camera session.
 *
 * Each source file is validated on disk before processing. Corrupted or
 * empty files are skipped with a warning instead of poisoning the export.
 *
 * @param inputUris - Array of local file URIs to concatenate, in order
 * @param outputUri - Where to write the merged file (must end in .mp4)
 * @returns The output URI on success
 * @throws If all files are invalid, or the merge produces an unplayable result
 */
export async function concatMP4Files(
  inputUris: string[],
  outputUri: string,
): Promise<string> {
  if (inputUris.length === 0) {
    throw new Error("No input files to concatenate.");
  }

  // ── 0. Validate source files on disk ────────────────────────────────
  const validUris: string[] = [];
  for (const uri of inputUris) {
    try {
      const info = await getInfoAsync(uri);
      if (!info.exists) {
        console.warn(`[concatMP4] Source file missing — skipping: ${uri.slice(0, 60)}`);
        continue;
      }
      if ((info.size ?? 0) === 0) {
        console.warn(`[concatMP4] Source file is empty (0 bytes) — skipping: ${uri.slice(0, 60)}`);
        continue;
      }
      console.log(
        `[concatMP4] Source file validated: ${uri.slice(0, 60)} — ${info.size} bytes`,
      );
      validUris.push(uri);
    } catch (e) {
      console.warn(
        `[concatMP4] Could not check source file — skipping: ${uri.slice(0, 60)}`,
        e,
      );
    }
  }

  if (validUris.length === 0) {
    throw new Error("All source files are missing or empty. Cannot merge.");
  }

  if (validUris.length === 1) {
    // Single file — just copy it
    console.log(`[concatMP4] Single valid file — copying to output`);
    const sourceBase64 = await readAsStringAsync(validUris[0]!, {
      encoding: EncodingType.Base64,
    });
    await writeAsStringAsync(outputUri, sourceBase64, {
      encoding: EncodingType.Base64,
    });

    // Verify the copy
    const outInfo = await getInfoAsync(outputUri);
    console.log(
      `[concatMP4] Copy check — exists: ${outInfo.exists}, size: ${outInfo.exists ? (outInfo.size ?? 0) : "N/A"} bytes`,
    );
    if (!outInfo.exists || (outInfo.size ?? 0) === 0) {
      throw new Error("Failed to copy source file to output location.");
    }
    return outputUri;
  }

  console.log(`[concatMP4] Merging ${validUris.length} file(s)...`);

  // ── 1. Read, validate, and parse all input files ────────────────────
  const segments: SegmentInfo[] = [];

  for (const uri of validUris) {
    let buf: Uint8Array;
    try {
      buf = await readFileAsBuffer(uri);
    } catch (e) {
      console.warn(`[concatMP4] Failed to read source file — skipping: ${uri.slice(0, 60)}`, e);
      continue;
    }

    const boxes = parseBoxes(buf, 0, buf.length);

    const mdatBox = findMdatBox(boxes);
    if (!mdatBox) {
      console.warn(`[concatMP4] No mdat box in source — skipping: ${uri.slice(0, 60)}`);
      continue;
    }

    const moovBox = boxes.find((b) => b.type === "moov") ?? null;
    if (!moovBox) {
      console.warn(`[concatMP4] No moov box in source — skipping: ${uri.slice(0, 60)}`);
      continue;
    }

    const mdatInfo: MdatInfo = {
      fileOffset: mdatBox.offset,
      payloadOffset: mdatBox.dataOffset,
      payloadSize: mdatBox.dataSize,
      buffer: buf,
    };

    // Parse sample tables for EACH track (video + audio) — store ALL of them
    // so the rebuild phase can use the correct track's data for each trak.
    const trakBoxes = moovBox.children.filter((c) => c.type === "trak");
    const trackTables: TrackTableData[] = [];

    for (const trak of trakBoxes) {
      const stbl = boxAtPath(trak, ["mdia", "minf", "stbl"]);
      if (!stbl) continue;

      const stcoBox = findChild(stbl, "stco") ?? findChild(stbl, "co64");
      const stszBox = findChild(stbl, "stsz");
      const stscBox = findChild(stbl, "stsc");
      const sttsBox = findChild(stbl, "stts");

      if (!stcoBox || !stszBox || !stscBox || !sttsBox) continue;

      const chunkTable = parseChunkOffsets(buf, stcoBox);
      const stszSizes = parseStsz(buf, stszBox);
      const stscEntries = parseStsc(buf, stscBox);
      const sttsEntries = parseStts(buf, sttsBox);

      trackTables.push({
        chunkTable,
        stszSizes,
        stscEntries,
        sttsEntries,
        numChunks: chunkTable.offsets.length,
      });
    }

    if (trackTables.length === 0) {
      console.warn(`[concatMP4] No tracks with sample tables — skipping: ${uri.slice(0, 60)}`);
      continue;
    }

    segments.push({
      boxes,
      mdat: mdatInfo,
      moovBox,
      tracks: trackTables,
    });

    console.log(
      `[concatMP4] Parsed segment: ${trackTables.length} track(s), ${mdatInfo.payloadSize} bytes mdat`,
    );
  }

  if (segments.length === 0) {
    throw new Error("No valid segments could be parsed from source files.");
  }

  if (segments.length === 1) {
    // After validation, only one segment remains — just copy it
    console.log(`[concatMP4] Only one valid segment after parsing — copying to output`);
    const singleBuf = segments[0]!.mdat.buffer;
    const base64 = encode(singleBuf.buffer as ArrayBuffer);
    await writeAsStringAsync(outputUri, base64, {
      encoding: EncodingType.Base64,
    });

    const outInfo = await getInfoAsync(outputUri);
    if (!outInfo.exists || (outInfo.size ?? 0) === 0) {
      throw new Error("Failed to write merged file to disk.");
    }
    return outputUri;
  }

  // ── 2. Build merged mdat: concatenate all mdat payloads ────────────
  const mdatParts: Uint8Array[] = [];
  const cumulativeOffsets: number[] = [];
  let cumulativeOffset = 0;

  for (const seg of segments) {
    const payload = seg.mdat.buffer.slice(
      seg.mdat.payloadOffset,
      seg.mdat.payloadOffset + seg.mdat.payloadSize,
    );
    mdatParts.push(payload);
    cumulativeOffsets.push(cumulativeOffset);
    cumulativeOffset += payload.length;
  }

  const mergedMdat = concatUint8Arrays(mdatParts);

  // ── 3. Clone and modify the first file's moov ──────────────────────

  const firstSeg = segments[0]!;
  const firstBuf = firstSeg.mdat.buffer;

  // Extract ftyp box
  const ftypBox = firstSeg.boxes.find((b) => b.type === "ftyp");
  let ftypBytes: Uint8Array;
  if (ftypBox) {
    ftypBytes = new Uint8Array(firstBuf.slice(ftypBox.offset, ftypBox.offset + ftypBox.size));
  } else {
    ftypBytes = createMinimalFtyp();
  }

  // ── 4. Rebuild moov with updated chunk offsets for ALL tracks ─────

  const rebuiltMoov = rebuildMoov(
    firstBuf,
    firstSeg.moovBox,
    segments,
    cumulativeOffsets,
  );

  // ── 5. Patch stco/co64 offsets to be absolute file offsets ─────────
  //    rebuildChunkOffsets computes offsets relative to the merged mdat
  //    payload start, but the player reads stco/co64 as absolute file
  //    offsets. We must add the absolute position of the mdat payload
  //    in the final file: ftypSize + moovSize + mdatHeaderSize.
  const MDAT_HEADER_SIZE = 8;
  const mdatPayloadAbsoluteOffset =
    ftypBytes.length + rebuiltMoov.length + MDAT_HEADER_SIZE;

  console.log(
    `[concatMP4] Patching stco offsets by +${mdatPayloadAbsoluteOffset} ` +
    `(ftyp=${ftypBytes.length} + moov=${rebuiltMoov.length} + mdatHdr=${MDAT_HEADER_SIZE})`,
  );
  patchStcoOffsets(rebuiltMoov, mdatPayloadAbsoluteOffset);

  // ── 6. Build mdat box header ───────────────────────────────────────
  const mdatHeader = new Uint8Array(MDAT_HEADER_SIZE);
  writeU32(mdatHeader, 0, MDAT_HEADER_SIZE + mergedMdat.length);
  writeType(mdatHeader, 4, "mdat");

  // ── 7. Write the merged file ───────────────────────────────────────

  const merged = concatUint8Arrays([ftypBytes, rebuiltMoov, mdatHeader, mergedMdat]);

  // Quick sanity: make sure the file starts with ftyp
  if (readType(merged, 4) !== "ftyp") {
    throw new Error("Merged file is malformed — missing ftyp box.");
  }

  console.log(
    `[concatMP4] Merged ${segments.length} segment(s) → ${(merged.length / 1024 / 1024).toFixed(1)} MB`,
  );
  await writeBufferToFile(outputUri, merged);

  // ── 6. Verify the output file ─────────────────────────────────────

  const outInfo = await getInfoAsync(outputUri);
  console.log(
    `[concatMP4] Output check — exists: ${outInfo.exists}, size: ${outInfo.exists ? (outInfo.size ?? 0) : "N/A"} bytes (expected ${merged.length})`,
  );

  if (!outInfo.exists) {
    throw new Error(
      `Merged file was not written to disk: ${outputUri.slice(0, 60)}`,
    );
  }
  if ((outInfo.size ?? 0) === 0) {
    throw new Error(
      `Merged file is empty after write (0 bytes). Export failed. Output: ${outputUri.slice(0, 60)}`,
    );
  }
  if ((outInfo.size ?? 0) !== merged.length) {
    console.error(
      `[concatMP4] SIZE MISMATCH — in-memory: ${merged.length}, on-disk: ${outInfo.size}. The merged file is corrupted.`,
    );
    throw new Error(
      `Merged file size mismatch: expected ${merged.length} bytes, got ${outInfo.size}. The file is corrupted and cannot be played.`,
    );
  }

  console.log(`[concatMP4] Merge complete — output validated: ${outputUri.slice(0, 60)}`);
  return outputUri;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function createMinimalFtyp(): Uint8Array {
  // Minimal ftyp box: size=24, type='ftyp', major_brand='isom', minor_version=0,
  // compatible_brands=['isom', 'mp42']
  const buf = new Uint8Array(24);
  writeU32(buf, 0, 24);
  writeType(buf, 4, "ftyp");
  writeType(buf, 8, "isom");
  writeU32(buf, 12, 0);
  writeType(buf, 16, "isom");
  writeType(buf, 20, "mp42");
  return buf;
}

// ── stco offset patching ────────────────────────────────────────────────────

/**
 * Scan the rebuilt moov buffer for all stco/co64 boxes and add the given
 * absolute offset to every chunk offset entry.
 *
 * This is necessary because rebuildChunkOffsets computes offsets relative to
 * the start of the merged mdat payload, but the player interprets stco/co64
 * values as absolute file offsets. After the moov is placed in the final file,
 * the mdat payload sits at ftypSize + moovSize + mdatHeaderSize bytes in.
 */
function patchStcoOffsets(moovBuffer: Uint8Array, absoluteOffset: number): void {
  // Recursively scan boxes looking for stco and co64
  scanAndPatchBoxes(moovBuffer, 0, moovBuffer.length, absoluteOffset);
}

function scanAndPatchBoxes(
  buf: Uint8Array,
  start: number,
  end: number,
  offset: number,
): void {
  let pos = start;
  while (pos + 8 <= end) {
    const header = parseBoxHeader(buf, pos);
    if (!header) break;

    const { type, size, headerSize } = header;
    const dataOffset = pos + headerSize;
    const dataSize = size - headerSize;

    if (type === "stco" || type === "co64") {
      // Patch the chunk offset entries
      const is64 = type === "co64";
      const entryCount = readU32(buf, dataOffset + 4);
      const entrySize = is64 ? 8 : 4;
      for (let i = 0; i < entryCount; i++) {
        const entryBase = dataOffset + 8 + i * entrySize;
        if (is64) {
          const hi = readU32(buf, entryBase);
          const lo = readU32(buf, entryBase + 4);
          const oldVal = hi * 0x100000000 + lo;
          const newVal = oldVal + offset;
          writeU32(buf, entryBase, Math.floor(newVal / 0x100000000));
          writeU32(buf, entryBase + 4, newVal % 0x100000000);
        } else {
          const oldVal = readU32(buf, entryBase);
          writeU32(buf, entryBase, oldVal + offset);
        }
      }
      // stco/co64 is a leaf — no children to recurse into
    } else {
      // Only recurse into container boxes
      const isContainer =
        type === "moov" ||
        type === "trak" ||
        type === "mdia" ||
        type === "minf" ||
        type === "stbl" ||
        type === "dinf" ||
        type === "edts" ||
        type === "udta";
      if (isContainer) {
        scanAndPatchBoxes(buf, dataOffset, dataOffset + dataSize, offset);
      }
    }

    pos += size;
  }
}

// ── Moov rebuilding ───────────────────────────────────────────────────────────

/**
 * Rebuild the moov box with updated chunk offsets spanning all segments.
 *
 * Each trak (video + audio) is rebuilt independently using its own per-track
 * sample table data from every segment. This is the critical fix: a previous
 * version only stored the first track's data and applied it to all traks,
 * producing corrupt audio track metadata and unplayable files.
 */
function rebuildMoov(
  firstBuf: Uint8Array,
  firstMoov: Mp4Box,
  allSegments: SegmentInfo[],
  cumulativeOffsets: number[],
): Uint8Array {
  const trakBoxes = firstMoov.children.filter((c) => c.type === "trak");

  // Extract movie timescale from mvhd — needed for tkhd/mvhd duration conversion
  const mvhdBox = firstMoov.children.find((c) => c.type === "mvhd");
  let movieTimescale = 600; // sensible default for iOS camera output
  if (mvhdBox) {
    const mvhdVersion = readU32(firstBuf, mvhdBox.dataOffset) >>> 24;
    if (mvhdVersion === 0) {
      movieTimescale = readU32(firstBuf, mvhdBox.dataOffset + 12);
    }
  }

  const rebuiltTraks: Uint8Array[] = [];

  for (let trakIdx = 0; trakIdx < trakBoxes.length; trakIdx++) {
    const trak = trakBoxes[trakIdx]!;
    const rebuiltTrak = rebuildTrak(
      firstBuf,
      trak,
      trakIdx,
      allSegments,
      cumulativeOffsets,
      movieTimescale,
    );
    rebuiltTraks.push(rebuiltTrak);
  }

  // Clone non-trak children from moov
  const nonTrakChildren: Uint8Array[] = [];
  for (const child of firstMoov.children) {
    if (child.type === "trak") continue;
    nonTrakChildren.push(
      new Uint8Array(firstBuf.slice(child.offset, child.offset + child.size)),
    );
  }

  // Update mvhd duration using the VIDEO track's stts (trakIdx 0).
  // computeTrackDuration returns values in the track's media timescale,
  // but mvhd duration is in the MOVIE's timescale — convert if they differ.
  if (mvhdBox) {
    const mvhdBytes = new Uint8Array(
      firstBuf.slice(mvhdBox.offset, mvhdBox.offset + mvhdBox.size),
    );
    const version = readU32(mvhdBytes, 0) >>> 24;
    if (version === 0) {
      const videoTrackDuration = computeTrackDuration(allSegments, 0);
      // Find video track's media timescale from its mdhd
      let videoMediaTimescale = movieTimescale;
      const videoTrak = trakBoxes[0];
      if (videoTrak) {
        const videoMdia = findChild(videoTrak, "mdia");
        if (videoMdia) {
          const videoMdhd = findChild(videoMdia, "mdhd");
          if (videoMdhd) {
            const mdhdVersion = readU32(firstBuf, videoMdhd.dataOffset) >>> 24;
            if (mdhdVersion === 0) {
              videoMediaTimescale = readU32(firstBuf, videoMdhd.dataOffset + 12);
            }
          }
        }
      }
      const mvhdDuration = Math.round(
        videoTrackDuration * movieTimescale / videoMediaTimescale,
      );
      writeU32(mvhdBytes, 24, mvhdDuration);
    }
    // Replace in nonTrakChildren array
    const idx = nonTrakChildren.findIndex(
      (arr) => arr.length >= 4 && readType(arr, 4) === "mvhd",
    );
    if (idx >= 0) {
      nonTrakChildren[idx] = mvhdBytes;
    }
  }

  // Build new moov
  const moovContent = concatUint8Arrays([...nonTrakChildren, ...rebuiltTraks]);

  const moovHeader = new Uint8Array(8);
  writeU32(moovHeader, 0, 8 + moovContent.length);
  writeType(moovHeader, 4, "moov");

  return concatUint8Arrays([moovHeader, moovContent]);
}

function rebuildTrak(
  firstBuf: Uint8Array,
  trak: Mp4Box,
  trakIdx: number,
  allSegments: SegmentInfo[],
  cumulativeOffsets: number[],
  movieTimescale: number,
): Uint8Array {
  const mdiaBox = findChild(trak, "mdia");
  const trakParts: Uint8Array[] = [];

  for (const child of trak.children) {
    if (child.type === "mdia") {
      const rebuiltMdia = rebuildMdia(
        firstBuf,
        child,
        trakIdx,
        allSegments,
        cumulativeOffsets,
      );
      trakParts.push(rebuiltMdia);
    } else if (child.type === "tkhd") {
      // Update tkhd duration using THIS track's stts data.
      // computeTrackDuration returns values in the TRACK's media timescale,
      // but tkhd duration is in the MOVIE's timescale — convert.
      const tkhdBytes = new Uint8Array(
        firstBuf.slice(child.offset, child.offset + child.size),
      );
      const version = readU32(tkhdBytes, 0) >>> 24;
      if (version === 0) {
        const trackDuration = computeTrackDuration(allSegments, trakIdx);
        // Find this track's media timescale from its mdhd
        const mdiaBox = findChild(trak, "mdia");
        let mediaTimescale = movieTimescale;
        if (mdiaBox) {
          const mdhdBox = findChild(mdiaBox, "mdhd");
          if (mdhdBox) {
            const mdhdVersion = readU32(firstBuf, mdhdBox.dataOffset) >>> 24;
            if (mdhdVersion === 0) {
              mediaTimescale = readU32(firstBuf, mdhdBox.dataOffset + 12);
            }
          }
        }
        // Convert track duration from media timescale to movie timescale
        const tkhdDuration = Math.round(
          trackDuration * movieTimescale / mediaTimescale,
        );
        writeU32(tkhdBytes, 28, tkhdDuration);
      }
      trakParts.push(tkhdBytes);
    } else {
      trakParts.push(
        new Uint8Array(firstBuf.slice(child.offset, child.offset + child.size)),
      );
    }
  }

  const trakContent = concatUint8Arrays(trakParts);
  const trakHeader = new Uint8Array(8);
  writeU32(trakHeader, 0, 8 + trakContent.length);
  writeType(trakHeader, 4, "trak");

  return concatUint8Arrays([trakHeader, trakContent]);
}

function rebuildMdia(
  firstBuf: Uint8Array,
  mdia: Mp4Box,
  trakIdx: number,
  allSegments: SegmentInfo[],
  cumulativeOffsets: number[],
): Uint8Array {
  const mdiaParts: Uint8Array[] = [];

  for (const child of mdia.children) {
    if (child.type === "minf") {
      const rebuiltMinf = rebuildMinf(
        firstBuf,
        child,
        trakIdx,
        allSegments,
        cumulativeOffsets,
      );
      mdiaParts.push(rebuiltMinf);
    } else if (child.type === "mdhd") {
      // Update mdhd duration using THIS track's stts data
      const mdhdBytes = new Uint8Array(
        firstBuf.slice(child.offset, child.offset + child.size),
      );
      const version = readU32(mdhdBytes, 0) >>> 24;
      if (version === 0) {
        const totalDuration = computeTrackDuration(allSegments, trakIdx);
        writeU32(mdhdBytes, 24, totalDuration);
      }
      mdiaParts.push(mdhdBytes);
    } else {
      mdiaParts.push(
        new Uint8Array(firstBuf.slice(child.offset, child.offset + child.size)),
      );
    }
  }

  const mdiaContent = concatUint8Arrays(mdiaParts);
  const mdiaHeader = new Uint8Array(8);
  writeU32(mdiaHeader, 0, 8 + mdiaContent.length);
  writeType(mdiaHeader, 4, "mdia");

  return concatUint8Arrays([mdiaHeader, mdiaContent]);
}

function rebuildMinf(
  firstBuf: Uint8Array,
  minf: Mp4Box,
  trakIdx: number,
  allSegments: SegmentInfo[],
  cumulativeOffsets: number[],
): Uint8Array {
  const minfParts: Uint8Array[] = [];

  for (const child of minf.children) {
    if (child.type === "stbl") {
      const rebuiltStbl = rebuildStbl(
        firstBuf,
        child,
        trakIdx,
        allSegments,
        cumulativeOffsets,
      );
      minfParts.push(rebuiltStbl);
    } else {
      minfParts.push(
        new Uint8Array(firstBuf.slice(child.offset, child.offset + child.size)),
      );
    }
  }

  const minfContent = concatUint8Arrays(minfParts);
  const minfHeader = new Uint8Array(8);
  writeU32(minfHeader, 0, 8 + minfContent.length);
  writeType(minfHeader, 4, "minf");

  return concatUint8Arrays([minfHeader, minfContent]);
}

function rebuildStbl(
  firstBuf: Uint8Array,
  stbl: Mp4Box,
  trakIdx: number,
  allSegments: SegmentInfo[],
  cumulativeOffsets: number[],
): Uint8Array {
  const stblParts: Uint8Array[] = [];

  for (const child of stbl.children) {
    switch (child.type) {
      case "stco":
      case "co64": {
        const newStco = rebuildChunkOffsets(
          firstBuf,
          child,
          allSegments,
          cumulativeOffsets,
          trakIdx,
        );
        stblParts.push(newStco);
        break;
      }
      case "stsz": {
        const newStsz = rebuildStsz(firstBuf, child, allSegments, trakIdx);
        stblParts.push(newStsz);
        break;
      }
      case "stsc": {
        const newStsc = rebuildStsc(firstBuf, child, allSegments, trakIdx);
        stblParts.push(newStsc);
        break;
      }
      case "stts": {
        const newStts = rebuildStts(firstBuf, child, allSegments, trakIdx);
        stblParts.push(newStts);
        break;
      }
      default: {
        stblParts.push(
          new Uint8Array(firstBuf.slice(child.offset, child.offset + child.size)),
        );
        break;
      }
    }
  }

  const stblContent = concatUint8Arrays(stblParts);
  const stblHeader = new Uint8Array(8);
  writeU32(stblHeader, 0, 8 + stblContent.length);
  writeType(stblHeader, 4, "stbl");

  return concatUint8Arrays([stblHeader, stblContent]);
}

// ── Sample table rebuilders (all track-indexed) ───────────────────────────────

function rebuildChunkOffsets(
  firstBuf: Uint8Array,
  stcoBox: Mp4Box,
  allSegments: SegmentInfo[],
  cumulativeOffsets: number[],
  trakIdx: number,
): Uint8Array {
  const is64 = stcoBox.type === "co64";

  // Collect chunk offsets from the SPECIFIC track across all segments
  const allNewOffsets: number[] = [];

  for (let segIdx = 0; segIdx < allSegments.length; segIdx++) {
    const seg = allSegments[segIdx]!;
    const track = seg.tracks[trakIdx];
    if (!track) continue; // segment doesn't have this track — skip

    const mdatPayloadStart = seg.mdat.payloadOffset;
    const baseOffset = cumulativeOffsets[segIdx]!;

    for (const originalOffset of track.chunkTable.offsets) {
      const relativeOffset = originalOffset - mdatPayloadStart;
      allNewOffsets.push(baseOffset + relativeOffset);
    }
  }

  // Build new stco/co64 box
  const entrySize = is64 ? 8 : 4;
  const boxPayloadSize = 8 + allNewOffsets.length * entrySize;
  const boxSize = 8 + boxPayloadSize;
  const buf = new Uint8Array(boxSize);

  writeU32(buf, 0, boxSize);
  writeType(buf, 4, stcoBox.type);

  // Copy version/flags from original
  const origView = new DataView(
    firstBuf.buffer,
    firstBuf.byteOffset + stcoBox.dataOffset,
    stcoBox.dataSize,
  );
  const origVersion = origView.getUint8(0);
  const origFlags =
    (origView.getUint8(1) << 16) | (origView.getUint8(2) << 8) | origView.getUint8(3);
  buf[8] = origVersion;
  buf[9] = (origFlags >> 16) & 0xff;
  buf[10] = (origFlags >> 8) & 0xff;
  buf[11] = origFlags & 0xff;
  writeU32(buf, 12, allNewOffsets.length);

  for (let i = 0; i < allNewOffsets.length; i++) {
    const offset = allNewOffsets[i]!;
    if (is64) {
      writeU32(buf, 16 + i * 8, Math.floor(offset / 0x100000000));
      writeU32(buf, 20 + i * 8, offset % 0x100000000);
    } else {
      writeU32(buf, 16 + i * 4, offset);
    }
  }

  return buf;
}

function rebuildStsz(
  firstBuf: Uint8Array,
  stszBox: Mp4Box,
  allSegments: SegmentInfo[],
  trakIdx: number,
): Uint8Array {
  // Concatenate sample sizes from the SPECIFIC track across all segments
  const allSizes: number[] = [];
  for (const seg of allSegments) {
    const track = seg.tracks[trakIdx];
    if (!track) continue;
    for (const sz of track.stszSizes) {
      allSizes.push(sz);
    }
  }

  // If all samples have the same size, use constant sample size mode
  const firstSize = allSizes[0] ?? 0;
  const allSame = allSizes.every((s) => s === firstSize);

  if (allSame && allSizes.length > 0) {
    // Constant sample size mode
    const buf = new Uint8Array(20);
    writeU32(buf, 0, 20);
    writeType(buf, 4, "stsz");
    const origView = new DataView(
      firstBuf.buffer,
      firstBuf.byteOffset + stszBox.dataOffset,
      stszBox.dataSize,
    );
    buf[8] = origView.getUint8(0);
    buf[9] = origView.getUint8(1);
    buf[10] = origView.getUint8(2);
    buf[11] = origView.getUint8(3);
    writeU32(buf, 12, firstSize);
    writeU32(buf, 16, allSizes.length);
    return buf;
  }

  // Variable sample size mode
  const payloadSize = 8 + allSizes.length * 4;
  const boxSize = 8 + payloadSize;
  const buf = new Uint8Array(boxSize);
  writeU32(buf, 0, boxSize);
  writeType(buf, 4, "stsz");
  const origView = new DataView(
    firstBuf.buffer,
    firstBuf.byteOffset + stszBox.dataOffset,
    stszBox.dataSize,
  );
  buf[8] = origView.getUint8(0);
  buf[9] = origView.getUint8(1);
  buf[10] = origView.getUint8(2);
  buf[11] = origView.getUint8(3);
  writeU32(buf, 12, 0); // sampleSize = 0 (variable)
  writeU32(buf, 16, allSizes.length);
  for (let i = 0; i < allSizes.length; i++) {
    writeU32(buf, 20 + i * 4, allSizes[i]!);
  }
  return buf;
}

function rebuildStsc(
  firstBuf: Uint8Array,
  stscBox: Mp4Box,
  allSegments: SegmentInfo[],
  trakIdx: number,
): Uint8Array {
  // Concatenate stsc entries from the SPECIFIC track, adjusting firstChunk
  const allEntries: StscEntry[] = [];
  let cumulativeChunks = 0;

  for (const seg of allSegments) {
    const track = seg.tracks[trakIdx];
    if (!track) continue;
    for (const entry of track.stscEntries) {
      allEntries.push({
        ...entry,
        firstChunk: entry.firstChunk + cumulativeChunks,
      });
    }
    cumulativeChunks += track.numChunks;
  }

  // Deduplicate consecutive entries with same samplesPerChunk
  const deduped: StscEntry[] = [];
  for (const entry of allEntries) {
    const last = deduped[deduped.length - 1];
    if (last && last.samplesPerChunk === entry.samplesPerChunk) {
      continue;
    }
    deduped.push(entry);
  }

  const payloadSize = 8 + deduped.length * 12;
  const boxSize = 8 + payloadSize;
  const buf = new Uint8Array(boxSize);
  writeU32(buf, 0, boxSize);
  writeType(buf, 4, "stsc");
  const origView = new DataView(
    firstBuf.buffer,
    firstBuf.byteOffset + stscBox.dataOffset,
    stscBox.dataSize,
  );
  buf[8] = origView.getUint8(0);
  buf[9] = origView.getUint8(1);
  buf[10] = origView.getUint8(2);
  buf[11] = origView.getUint8(3);
  writeU32(buf, 12, deduped.length);
  for (let i = 0; i < deduped.length; i++) {
    const e = deduped[i]!;
    writeU32(buf, 16 + i * 12, e.firstChunk);
    writeU32(buf, 20 + i * 12, e.samplesPerChunk);
    writeU32(buf, 24 + i * 12, e.sampleDescriptionIndex);
  }
  return buf;
}

function rebuildStts(
  firstBuf: Uint8Array,
  sttsBox: Mp4Box,
  allSegments: SegmentInfo[],
  trakIdx: number,
): Uint8Array {
  // Concatenate stts entries from the SPECIFIC track
  const allEntries: SttsEntry[] = [];
  for (const seg of allSegments) {
    const track = seg.tracks[trakIdx];
    if (!track) continue;
    for (const entry of track.sttsEntries) {
      allEntries.push({ ...entry });
    }
  }

  // Merge consecutive entries with the same delta
  const merged: SttsEntry[] = [];
  for (const entry of allEntries) {
    const last = merged[merged.length - 1];
    if (last && last.sampleDelta === entry.sampleDelta) {
      last.sampleCount += entry.sampleCount;
    } else {
      merged.push({ ...entry });
    }
  }

  const payloadSize = 8 + merged.length * 8;
  const boxSize = 8 + payloadSize;
  const buf = new Uint8Array(boxSize);
  writeU32(buf, 0, boxSize);
  writeType(buf, 4, "stts");
  const origView = new DataView(
    firstBuf.buffer,
    firstBuf.byteOffset + sttsBox.dataOffset,
    sttsBox.dataSize,
  );
  buf[8] = origView.getUint8(0);
  buf[9] = origView.getUint8(1);
  buf[10] = origView.getUint8(2);
  buf[11] = origView.getUint8(3);
  writeU32(buf, 12, merged.length);
  for (let i = 0; i < merged.length; i++) {
    const e = merged[i]!;
    writeU32(buf, 16 + i * 8, e.sampleCount);
    writeU32(buf, 20 + i * 8, e.sampleDelta);
  }
  return buf;
}
