/**
 * concatMP4.ts — Concatenate a parent MP4 clip with a reaction clip.
 *
 * The core of this module is an MP4 box parser that walks the ISO Base Media File
 * Format (ISOBMFF) box tree. `parseBoxTree` scans the binary structure;
 * `concatMP4Files` uses the parsed tree to stitch two clips into one.
 *
 * All binary patching operates on ArrayBuffer with absolute byte offsets,
 * so chunk-offset arithmetic is always relative to file start — no view/slice
 * offset confusion.
 *
 * The output is a valid progressive MP4 with:
 *   - ftyp from the parent clip
 *   - Combined mdat (parent's samples then reaction's samples)
 *   - Rebuilt moov with adjusted chunk offsets and combined duration
 */

// ── Box Types ─────────────────────────────────────────────────────────────────

interface Mp4Box {
  /** 4-char box type (e.g. "moov", "ftyp", "mdat") */
  type: string;
  /** Byte offset of the box header (the size field) */
  offset: number;
  /** Total box size in bytes (header + payload) */
  size: number;
  /** Header size in bytes (8 for standard, 16 for extended/largesize) */
  headerSize: number;
  /** Byte offset immediately after this box */
  endOffset: number;
  /** For container boxes — child boxes */
  children: Mp4Box[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const textDecoder = new TextDecoder();

function bytesToAscii(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  return textDecoder.decode(bytes);
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a single MP4 box starting at `offset` within `view`.
 */
function parseBox(view: DataView, offset: number): Mp4Box {
  const rawSize = view.getUint32(offset);
  const boxType = bytesToAscii(view, offset + 4, 4);

  let size: number;
  let headerSize: number;

  if (rawSize === 0) {
    size = view.byteLength - offset;
    headerSize = 8;
  } else if (rawSize === 1) {
    const high = view.getUint32(offset + 8);
    const low = view.getUint32(offset + 12);
    size = high * 0x1_0000_0000 + low;
    headerSize = 16;
  } else {
    size = rawSize;
    headerSize = 8;
  }

  const endOffset = offset + size;
  const children: Mp4Box[] = [];

  // Recurse into container box children
  if (isContainerBox(boxType) && endOffset <= view.byteLength) {
    const childrenStart = offset + headerSize;
    const childrenEnd = endOffset;

    let childPos = childrenStart;
    while (childPos + 8 <= childrenEnd) {
      const childRawSize = view.getUint32(childPos);
      const childBox = parseBox(view, childPos);
      children.push(childBox);

      if (childRawSize === 0) break;

      const childAdvance =
        childRawSize === 1 ? childBox.size : childRawSize;
      if (childAdvance <= 0) break;

      childPos += childAdvance;
    }
  }

  return { type: boxType, offset, size, headerSize, endOffset, children };
}

/** Container boxes that contain child boxes */
function isContainerBox(type: string): boolean {
  return (
    type === "moov" ||
    type === "trak" ||
    type === "mdia" ||
    type === "minf" ||
    type === "stbl" ||
    type === "udta" ||
    type === "edts" ||
    type === "mvex" ||
    type === "moof" ||
    type === "traf"
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse the full box tree from an ArrayBuffer.
 * Returns all top-level boxes with their children.
 */
export function parseBoxTree(buffer: ArrayBuffer): Mp4Box[] {
  const view = new DataView(buffer);
  const boxes: Mp4Box[] = [];
  let offset = 0;

  while (offset + 8 <= view.byteLength) {
    const box = parseBox(view, offset);
    boxes.push(box);
    offset = box.endOffset;
    if (offset >= view.byteLength) break;
  }

  return boxes;
}

// ── Box tree navigation helpers ──────────────────────────────────────────────

/** Find a child box by type, recursively searching all descendants */
function findBox(boxes: Mp4Box[], type: string): Mp4Box | undefined {
  for (const box of boxes) {
    if (box.type === type) return box;
    const found = findBox(box.children, type);
    if (found) return found;
  }
  return undefined;
}

/** Walk a path through nested container boxes */
function findNested(parent: Mp4Box, ...path: string[]): Mp4Box | undefined {
  let current: Mp4Box | undefined = parent;
  for (const type of path) {
    if (!current) return undefined;
    current = current.children.find((c) => c.type === type);
  }
  return current;
}

function getMdatBox(boxes: Mp4Box[]): Mp4Box | undefined {
  return boxes.find((b) => b.type === "mdat");
}

function getMoovBox(boxes: Mp4Box[]): Mp4Box | undefined {
  return boxes.find((b) => b.type === "moov");
}

// ── Duration helpers ─────────────────────────────────────────────────────────

/** Read the duration value from an mvhd or tkhd box. Returns [duration, timescale]. */
function readDuration(
  boxBytes: ArrayBuffer,
  boxOffsetInBuffer: number,
): { duration: number; timescale: number } {
  const view = new DataView(boxBytes);
  // mvhd/tkhd structure: version(1) + flags(3) + creation_time(4) + modification_time(4)
  // + timescale(4) + duration(4 or 8)
  const version = view.getUint8(boxOffsetInBuffer);
  const timescale = view.getUint32(boxOffsetInBuffer + 12);

  let duration: number;
  if (version === 1) {
    const high = view.getUint32(boxOffsetInBuffer + 16);
    const low = view.getUint32(boxOffsetInBuffer + 20);
    duration = high * 0x1_0000_0000 + low;
  } else {
    duration = view.getUint32(boxOffsetInBuffer + 16);
  }

  return { duration, timescale };
}

/**
 * Get the duration and timescale from the mvhd box in a moov.
 * mvhd is always the first child of moov.
 */
function getMoovDuration(moovBox: Mp4Box, buffer: ArrayBuffer): { duration: number; timescale: number } {
  const mvhd = moovBox.children.find((c) => c.type === "mvhd");
  if (!mvhd) throw new Error("No mvhd found in moov box");
  return readDuration(buffer, mvhd.offset);
}

// ── Chunk offset patching ────────────────────────────────────────────────────

/**
 * Patch stco or co64 chunk offsets in a buffer.
 * All box offsets must be absolute byte positions within `buf`.
 *
 * stco structure:  version(1) + flags(3) + entry_count(4) + entries(entry_count * 4)
 * co64 structure:  version(1) + flags(3) + entry_count(4) + entries(entry_count * 8)
 */
function patchTrakChunkOffsets(
  buf: ArrayBuffer,
  boxes: Mp4Box[],
  delta: number,
): void {
  const view = new DataView(buf);
  const trakBox = boxes.find((b) => b.type === "trak");
  if (!trakBox) return;

  const stbl = findNested(trakBox, "mdia", "minf", "stbl");
  if (!stbl) return;

  const stco = stbl.children.find((c) => c.type === "stco");
  const co64 = stbl.children.find((c) => c.type === "co64");
  const chunkBox = stco ?? co64;
  if (!chunkBox) return;

  const is64 = chunkBox.type === "co64";
  const entrySize = is64 ? 8 : 4;

  // stco/co64 payload starts after: size(4) + type(4) + version(1) + flags(3) = 12 bytes
  const headerEnd = chunkBox.offset + 12;
  const entryCount = view.getUint32(chunkBox.offset + 8);

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = headerEnd + i * entrySize;
    if (is64) {
      const high = view.getUint32(entryOffset);
      const low = view.getUint32(entryOffset + 4);
      const oldOffset = high * 0x1_0000_0000 + low;
      const newOffset = oldOffset + delta;
      view.setUint32(entryOffset, Math.floor(newOffset / 0x1_0000_0000));
      view.setUint32(entryOffset + 4, newOffset % 0x1_0000_0000);
    } else {
      const oldOffset = view.getUint32(entryOffset);
      view.setUint32(entryOffset, oldOffset + delta);
    }
  }
}

// ── Buffer construction helpers ───────────────────────────────────────────────

/** Build a standard 32-byte ftyp box with major brand "isom". */
function buildFtypBytes(): Uint8Array {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 32);
  view.setUint32(4, 0x66_74_79_70); // "ftyp"
  view.setUint32(8, 0x69_73_6f_6d); // "isom"
  view.setUint32(12, 512);
  view.setUint32(16, 0x69_73_6f_6d); // "isom"
  view.setUint32(20, 0x69_73_6f_32); // "iso2"
  view.setUint32(24, 0x6d_70_34_31); // "mp41"
  view.setUint32(28, 0x6d_70_34_32); // "mp42"
  return buf;
}

/** Write a 4-byte big-endian uint32 into an ArrayBuffer at the given absolute offset */
function writeUint32(buf: ArrayBuffer, offset: number, value: number): void {
  new DataView(buf).setUint32(offset, value);
}

/** Write an 8-byte big-endian uint64 into an ArrayBuffer at the given absolute offset */
function writeUint64(buf: ArrayBuffer, offset: number, value: number): void {
  const view = new DataView(buf);
  view.setUint32(offset, Math.floor(value / 0x1_0000_0000));
  view.setUint32(offset + 4, value % 0x1_0000_0000);
}

// ── concatMP4Files ───────────────────────────────────────────────────────────

export interface ConcatResult {
  success: boolean;
  error?: string;
  outputUri?: string;
  parentDurationMs?: number;
  reactionDurationMs?: number;
  combinedDurationMs?: number;
}

/**
 * Concatenate two MP4/MOV files into one by rebuilding the ISOBMFF structure.
 *
 * The output file has this layout:
 *   [ftyp] [mdat: parent data + reaction data] [moov: rebuilt with adjusted offsets]
 *
 * Offset adjustment logic:
 *   Both files' stco/co64 entries are absolute byte offsets into their original
 *   files. After concatenation, those same bytes land at different positions.
 *
 *   parent_delta = output_mdat_data_start - parent_original_mdat_data_start
 *   reaction_delta = output_mdat_data_start + parent_mdat_data_size
 *                    - reaction_original_mdat_data_start
 *
 *   If both files have identical header layout and we copy the parent's ftyp,
 *   parent_delta = 0 and reaction_delta = parent_mdat_data_size.
 *
 * Timescale handling:
 *   The mvhd duration in the output must be the sum of both clips' durations.
 *   Both durations must be in the same timescale. We read each clip's duration
 *   and timescale from its mvhd, convert reaction's duration to the parent's
 *   timescale, and sum them.
 */
export async function concatMP4Files(
  parentUri: string,
  reactionUri: string,
  outputUri: string,
): Promise<ConcatResult> {
  const { readAsStringAsync, writeAsStringAsync } = await import(
    "@/lib/fileSystemCompat"
  );
  const { decode, encode } = await import("base64-arraybuffer");

  // ── 1. Read both files into buffers ──────────────────────────────────────
  console.log("[concatMP4] Reading parent:", parentUri.slice(0, 60));
  console.log("[concatMP4] Reading reaction:", reactionUri.slice(0, 60));

  let parentB64: string;
  let reactionB64: string;
  try {
    parentB64 = await readAsStringAsync(parentUri, {
      encoding: "base64" as unknown as never,
    });
  } catch (e) {
    return {
      success: false,
      error: `Failed to read parent file: ${(e as Error).message}`,
    };
  }

  try {
    reactionB64 = await readAsStringAsync(reactionUri, {
      encoding: "base64" as unknown as never,
    });
  } catch (e) {
    return {
      success: false,
      error: `Failed to read reaction file: ${(e as Error).message}`,
    };
  }

  // decode() returns Uint8Array | ArrayBuffer depending on version;
  // cast through unknown for safe ArrayBuffer access
  const parentBuffer = (decode(parentB64) as unknown as { buffer: ArrayBuffer }).buffer
    ?? (decode(parentB64) as unknown as ArrayBuffer);
  const reactionBuffer = (decode(reactionB64) as unknown as { buffer: ArrayBuffer }).buffer
    ?? (decode(reactionB64) as unknown as ArrayBuffer);

  // Normalize: if decode returned a typed array, parentBuffer is its .buffer;
  // if it returned ArrayBuffer directly, it's already what we need.
  const pBuf: ArrayBuffer =
    (parentBuffer as { byteLength?: number }).byteLength !== undefined
      ? (parentBuffer as ArrayBuffer)
      : (decode(parentB64) as unknown as ArrayBuffer);
  const rBuf: ArrayBuffer =
    (reactionBuffer as { byteLength?: number }).byteLength !== undefined
      ? (reactionBuffer as ArrayBuffer)
      : (decode(reactionB64) as unknown as ArrayBuffer);

  console.log(
    `[concatMP4] Parent: ${(pBuf.byteLength / 1024).toFixed(1)} KB, ` +
      `Reaction: ${(rBuf.byteLength / 1024).toFixed(1)} KB`,
  );

  // ── 2. Parse both box trees ──────────────────────────────────────────────
  let parentBoxes: Mp4Box[];
  let reactionBoxes: Mp4Box[];

  try {
    parentBoxes = parseBoxTree(pBuf);
    console.log(
      "[concatMP4] Parent boxes:",
      parentBoxes.map((b) => `${b.type}(${b.size})`).join(", "),
    );
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse parent file box structure: ${(e as Error).message}`,
    };
  }

  try {
    reactionBoxes = parseBoxTree(rBuf);
    console.log(
      "[concatMP4] Reaction boxes:",
      reactionBoxes.map((b) => `${b.type}(${b.size})`).join(", "),
    );
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse reaction file box structure: ${(e as Error).message}`,
    };
  }

  // ── 3. Locate critical boxes ─────────────────────────────────────────────
  const parentMdat = getMdatBox(parentBoxes);
  const parentMoov = getMoovBox(parentBoxes);
  const reactionMdat = getMdatBox(reactionBoxes);
  const reactionMoov = getMoovBox(reactionBoxes);

  if (!parentMdat) return { success: false, error: "Parent file has no mdat box" };
  if (!parentMoov) return { success: false, error: "Parent file has no moov box" };
  if (!reactionMdat) return { success: false, error: "Reaction file has no mdat box" };
  if (!reactionMoov) return { success: false, error: "Reaction file has no moov box" };

  // ── 4. Extract mdat payload data (skip the box header) ───────────────────
  const parentMdatDataStart = parentMdat.offset + parentMdat.headerSize;
  const parentMdatDataSize = parentMdat.size - parentMdat.headerSize;
  const parentMdatData = new Uint8Array(pBuf, parentMdatDataStart, parentMdatDataSize);

  const reactionMdatDataStart = reactionMdat.offset + reactionMdat.headerSize;
  const reactionMdatDataSize = reactionMdat.size - reactionMdat.headerSize;
  const reactionMdatData = new Uint8Array(rBuf, reactionMdatDataStart, reactionMdatDataSize);

  console.log(
    `[concatMP4] Parent mdat data: ${(parentMdatDataSize / 1024).toFixed(1)} KB, ` +
      `Reaction mdat data: ${(reactionMdatDataSize / 1024).toFixed(1)} KB`,
  );

  // ── 5. Compute durations (timescale-converted) ───────────────────────────
  const parentDur = getMoovDuration(parentMoov, pBuf);
  const reactionDur = getMoovDuration(reactionMoov, rBuf);

  const reactionDurationInParentTimescale = Math.round(
    (reactionDur.duration * parentDur.timescale) / reactionDur.timescale,
  );
  const combinedDuration = parentDur.duration + reactionDurationInParentTimescale;

  const parentDurationMs = Math.round((parentDur.duration / parentDur.timescale) * 1000);
  const reactionDurationMs = Math.round((reactionDur.duration / reactionDur.timescale) * 1000);
  const combinedDurationMs = parentDurationMs + reactionDurationMs;

  console.log(
    `[concatMP4] Parent: ${parentDurationMs}ms ` +
      `(${parentDur.duration}/${parentDur.timescale}), ` +
      `Reaction: ${reactionDurationMs}ms ` +
      `(${reactionDur.duration}/${reactionDur.timescale}), ` +
      `Combined: ${combinedDurationMs}ms`,
  );

  // ── 6. Build new ftyp (copy parent's, or synthesize standard) ────────────
  const parentFtyp = parentBoxes.find((b) => b.type === "ftyp");
  let ftypBytes: Uint8Array;
  if (parentFtyp) {
    ftypBytes = new Uint8Array(pBuf, parentFtyp.offset, parentFtyp.size);
    console.log(`[concatMP4] Using parent ftyp (${ftypBytes.length} bytes)`);
  } else {
    ftypBytes = buildFtypBytes();
    console.log("[concatMP4] No parent ftyp — using standard ftyp");
  }

  // ── 7. Build combined mdat ───────────────────────────────────────────────
  const combinedMdatDataSize = parentMdatDataSize + reactionMdatDataSize;
  const needsExtendedMdat = combinedMdatDataSize + 8 > 0xff_ff_ff_ff;
  const mdatTotalSize = (needsExtendedMdat ? 16 : 8) + combinedMdatDataSize;

  const mdatBytes = new Uint8Array(mdatTotalSize);
  const mdatView = new DataView(mdatBytes.buffer);

  if (needsExtendedMdat) {
    mdatView.setUint32(0, 1);
    mdatView.setUint32(4, 0x6d_64_61_74); // "mdat"
    mdatView.setUint32(8, Math.floor(mdatTotalSize / 0x1_0000_0000));
    mdatView.setUint32(12, mdatTotalSize % 0x1_0000_0000);
    mdatBytes.set(parentMdatData, 16);
    mdatBytes.set(reactionMdatData, 16 + parentMdatDataSize);
  } else {
    mdatView.setUint32(0, mdatTotalSize);
    mdatView.setUint32(4, 0x6d_64_61_74); // "mdat"
    mdatBytes.set(parentMdatData, 8);
    mdatBytes.set(reactionMdatData, 8 + parentMdatDataSize);
  }

  // ── 8. Compute offset deltas ─────────────────────────────────────────────
  const outputFtypSize = ftypBytes.length;
  const outputMdatHeaderSize = needsExtendedMdat ? 16 : 8;
  const outputMdatDataStart = outputFtypSize + outputMdatHeaderSize;

  const parentDelta = outputMdatDataStart - parentMdatDataStart;
  const reactionDelta =
    outputMdatDataStart + parentMdatDataSize - reactionMdatDataStart;

  console.log(
    `[concatMP4] Offsets — parent delta: ${parentDelta}, reaction delta: ${reactionDelta}`,
  );

  // ── 9. Build the moov box ────────────────────────────────────────────────
  // Patch IN PLACE in the full source buffers using absolute box offsets,
  // then extract the patched bytes for assembly.

  // 9a. Patch mvhd duration in parentBuffer (absolute offset)
  const parentMvhd = parentMoov.children.find((c) => c.type === "mvhd");
  if (parentMvhd) {
    const mvhdView = new DataView(pBuf);
    const mvhdVersion = mvhdView.getUint8(parentMvhd.offset);
    const durationOffset = parentMvhd.offset + 16; // past version+flags+creation+mod+timescale

    if (mvhdVersion === 1) {
      writeUint64(pBuf, durationOffset, combinedDuration);
    } else {
      writeUint32(pBuf, durationOffset, combinedDuration);
    }
    console.log(
      `[concatMP4] Patched mvhd duration: ${combinedDuration} (timescale ${parentDur.timescale})`,
    );
  }

  // 9b. Patch parent's stco/co64 offsets in parentBuffer (absolute offsets)
  for (const trak of parentMoov.children.filter((c) => c.type === "trak")) {
    patchTrakChunkOffsets(pBuf, [trak], parentDelta);
  }
  console.log("[concatMP4] Patched parent chunk offsets");

  // Extract parent moov bytes from the (now patched) parentBuffer
  const parentMoovBytes = new Uint8Array(pBuf, parentMoov.offset, parentMoov.size);

  // 9c. Patch reaction's trak boxes in reactionBuffer, then extract
  const reactionTrakBytesList: Uint8Array[] = [];
  for (const trak of reactionMoov.children.filter((c) => c.type === "trak")) {
    // Patch chunk offsets in reactionBuffer at absolute offsets
    patchTrakChunkOffsets(rBuf, [trak], reactionDelta);

    // Patch tkhd duration in the reaction's trak
    const tkhd = findBox(trak.children, "tkhd");
    if (tkhd) {
      const tkhdVersion = new DataView(rBuf).getUint8(tkhd.offset);
      const tkhdDurationOffset = tkhd.offset + 16;
      if (tkhdVersion === 1) {
        writeUint64(rBuf, tkhdDurationOffset, reactionDurationInParentTimescale);
      } else {
        writeUint32(rBuf, tkhdDurationOffset, reactionDurationInParentTimescale);
      }
    }

    // Extract the (now patched) trak bytes
    reactionTrakBytesList.push(new Uint8Array(rBuf, trak.offset, trak.size));
  }
  console.log(
    `[concatMP4] Patched ${reactionTrakBytesList.length} reaction trak(s), delta ${reactionDelta}`,
  );

  // 9d. Assemble final moov
  const reactionTraksTotalSize = reactionTrakBytesList.reduce(
    (sum, t) => sum + t.length,
    0,
  );
  const newMoovSize = parentMoovBytes.length + reactionTraksTotalSize;

  const moovOutput = new Uint8Array(newMoovSize);
  writeUint32(moovOutput.buffer as ArrayBuffer, 0, newMoovSize);
  writeUint32(moovOutput.buffer as ArrayBuffer, 4, 0x6d_6f_6f_76); // "moov"
  // Copy parent's moov payload (skip the 8-byte header we just wrote)
  moovOutput.set(parentMoovBytes.subarray(8), 8);

  // Append reaction's trak boxes
  let appendOffset = parentMoovBytes.length;
  for (const trakBytes of reactionTrakBytesList) {
    moovOutput.set(trakBytes, appendOffset);
    appendOffset += trakBytes.length;
  }

  // ── 10. Assemble the final output ────────────────────────────────────────
  const totalSize = outputFtypSize + mdatBytes.length + moovOutput.length;
  const output = new Uint8Array(totalSize);
  let outOffset = 0;

  output.set(ftypBytes, outOffset);
  outOffset += ftypBytes.length;
  output.set(mdatBytes, outOffset);
  outOffset += mdatBytes.length;
  output.set(moovOutput, outOffset);

  console.log(
    `[concatMP4] Output assembled: ${(totalSize / 1024).toFixed(1)} KB ` +
      `(ftyp:${ftypBytes.length} + mdat:${mdatBytes.length} + moov:${moovOutput.length})`,
  );

  // ── 11. Write output file ────────────────────────────────────────────────
  try {
    const outputB64 = encode(output.buffer as ArrayBuffer);
    await writeAsStringAsync(outputUri, outputB64, {
      encoding: "base64" as unknown as never,
    });
    console.log(
      `[concatMP4] Wrote stitched file: ${outputUri.slice(0, 60)} ` +
        `(${(totalSize / 1024).toFixed(1)} KB)`,
    );
  } catch (e) {
    return {
      success: false,
      error: `Failed to write output file: ${(e as Error).message}`,
    };
  }

  // ── 12. Verify output ────────────────────────────────────────────────────
  const { getInfoAsync } = await import("@/lib/fileSystemCompat");
  const info = await getInfoAsync(outputUri);
  console.log(
    `[concatMP4] Output file check — exists: ${info.exists}, size: ${info.size} bytes`,
  );

  return {
    success: true,
    outputUri,
    parentDurationMs,
    reactionDurationMs,
    combinedDurationMs,
  };
}

// ── Validate MP4 ─────────────────────────────────────────────────────────────

export function validateMp4(buffer: ArrayBuffer): {
  valid: boolean;
  majorBrand: string;
  compatibleBrands: string[];
} {
  if (buffer.byteLength < 12) {
    return { valid: false, majorBrand: "?", compatibleBrands: [] };
  }
  const view = new DataView(buffer);
  try {
    const ftypType = bytesToAscii(view, 4, 4);
    if (ftypType !== "ftyp") {
      return { valid: false, majorBrand: "?", compatibleBrands: [] };
    }
    const major = bytesToAscii(view, 8, 4);
    const ftypSize = view.getUint32(0);
    const compat: string[] = [];
    for (let i = 16; i < ftypSize; i += 4) {
      if (i + 4 <= ftypSize) {
        compat.push(bytesToAscii(view, i, 4));
      }
    }
    return { valid: true, majorBrand: major, compatibleBrands: compat };
  } catch {
    return { valid: false, majorBrand: "?", compatibleBrands: [] };
  }
}

// ── Diagnostic ───────────────────────────────────────────────────────────────

export function diagnosticDump(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  let offset = 0;
  let boxCount = 0;

  console.log(`\n[concatMP4] DIAGNOSTIC — buffer size: ${buffer.byteLength} bytes`);

  while (offset + 8 <= buffer.byteLength && boxCount < 1000) {
    const rawSize = view.getUint32(offset);
    const boxType = bytesToAscii(view, offset + 4, 4);

    let size: number;
    if (rawSize === 0) {
      size = buffer.byteLength - offset;
    } else if (rawSize === 1) {
      if (offset + 16 > buffer.byteLength) break;
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 0x1_0000_0000 + low;
    } else {
      size = rawSize;
    }

    const endOffset = offset + size;
    const exceeds = endOffset > buffer.byteLength;

    console.log(
      `[concatMP4] [#${boxCount}] type="${boxType}" ` +
        `offset=${offset} size=${size} endOffset=${endOffset}` +
        (exceeds ? " OVERREAD" : ""),
    );

    if (exceeds) break;
    offset = endOffset;
    boxCount++;
  }

  console.log(
    `[concatMP4] DIAGNOSTIC COMPLETE — ${boxCount} top-level boxes, ` +
      `final offset: ${offset}/${buffer.byteLength}\n`,
  );
}
