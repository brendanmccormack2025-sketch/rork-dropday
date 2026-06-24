/**
 * concatMP4.ts — Concatenate a parent MP4 clip with a reaction clip.
 *
 * The core of this module is an MP4 box parser that walks the ISO Base Media File
 * Format (ISOBMFF) box tree. The `parseBoxTree` function performs the binary
 * scanning and is the source of the "DataView.prototype.get<Type>(): Cannot read
 * that many bytes" overread that occurs on certain parent clips.
 *
 * ── Diagnostic Mode ───────────────────────────────────────────────────────────
 * Set DIAGNOSTIC = true and call diagnosticDump(buffer) to log every box found
 * until the overread. The output shows (boxName, offset, size, endOffset) for
 * each box and flags the exact box that exceeds the buffer.
 */

const DIAGNOSTIC = true;

// ── Box Types ─────────────────────────────────────────────────────────────────

interface Mp4Box {
  /** 4-char box type (e.g. "moov", "ftyp", "mdat") */
  type: string;
  /** Byte offset of the box header (the size field) */
  offset: number;
  /** Total box size in bytes (header + payload) */
  size: number;
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

// ── Parser (the function that overreads) ──────────────────────────────────────

/**
 * Parse a single MP4 box starting at `offset` within `view`.
 *
 * BUG: When `rawSize` is larger than the remaining bytes in the buffer,
 *      subsequent DataView reads (e.g. for child boxes or the next sibling)
 *      throw:  DataView.prototype.get<Type>(): Cannot read that many bytes
 *
 * The overread occurs at the line marked with `⚠️` below — when `rawSize`
 * pushes `childrenEnd` past `view.byteLength`, the next iteration of the
 * child-parsing loop calls `view.getUint32(childPos)` at an offset that
 * exceeds the buffer.
 */
function parseBox(view: DataView, offset: number, depth: number): Mp4Box {
  // Read box size — 4 bytes, big-endian
  // ⚠️ If offset + 4 > view.byteLength, THIS line throws first
  const rawSize = view.getUint32(offset);
  // Read box type — next 4 bytes
  const boxType = bytesToAscii(view, offset + 4, 4);

  let size: number;
  let headerSize: number;

  if (rawSize === 0) {
    // Box extends to end of file
    size = view.byteLength - offset;
    headerSize = 8;
  } else if (rawSize === 1) {
    // 64-bit extended size — read largesize (uint64, 8 bytes)
    // ⚠️ If offset + 16 > view.byteLength, THIS line throws
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

  // ═══════════════════════════════════════════════════════════════════════════
  // ⚠️ OVERREAD: If `size` exceeds the remaining bytes in the buffer
  //    (i.e. offset + size > view.byteLength), then `childrenEnd` is past
  //    the end of the buffer. The child-parsing loop below will attempt
  //    `view.getUint32(childPos)` at an invalid offset.
  // ═══════════════════════════════════════════════════════════════════════════

  // Container boxes: recurse into children
  if (isContainerBox(boxType) && endOffset <= view.byteLength) {
    const childrenStart = offset + headerSize;
    const childrenEnd = endOffset;

    let childPos = childrenStart;
    while (childPos + 8 <= childrenEnd) {
      // ⚠️ THIS IS WHERE THE OVERREAD HAPPENS:
      //     view.getUint32(childPos) calls DataView.prototype.getUint32
      //     which throws "Cannot read that many bytes" when childPos + 4
      //     exceeds view.byteLength — which it will if `size` was bogus.
      const childSize_raw = view.getUint32(childPos);
      const childBox = parseBox(view, childPos, depth + 1);
      children.push(childBox);

      if (childSize_raw === 0) {
        break; // extends to EOF — stop parsing
      }

      const childAdvance =
        childSize_raw === 1
          ? childBox.size // largesize box, size already resolved
          : childSize_raw;

      if (childAdvance <= 0) {
        break; // safety: prevent infinite loop
      }

      childPos += childAdvance;
    }
  }

  return { type: boxType, offset, size, endOffset, children };
}

/** Container boxes that contain child boxes */
function isContainerBox(type: string): boolean {
  return (
    type === "moov" ||
    type === "trak" ||
    type === "mdia" ||
    type === "minf" ||
    type "stbl" ||
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
  const maxBoxes = 500;

  while (offset < view.byteLength && boxes.length < maxBoxes) {
    if (offset + 8 > view.byteLength) {
      break;
    }
    const box = parseBox(view, offset, 0);
    boxes.push(box);
    offset = box.endOffset;
  }

  return boxes;
}

// ── Diagnostic Dump ───────────────────────────────────────────────────────────

/**
 * Walk the box tree and print every box: name, offset, size, endOffset.
 * Stops at the first overread and reports which box caused it.
 */
export function diagnosticDump(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  let offset = 0;
  let boxCount = 0;

  console.log(`\n[concatMP4] DIAGNOSTIC — buffer size: ${buffer.byteLength} bytes`);
  console.log(`[concatMP4] First 32 bytes (hex): ${bytesToHex(buffer, 0, 32)}\n`);

  while (offset < buffer.byteLength && boxCount < 1000) {
    // Guard: can we read at least the size field?
    if (offset + 4 > buffer.byteLength) {
      console.log(
        `[concatMP4] ⚠️ OVERREAD at offset ${offset}: ` +
          `need 4 bytes for size field but only ${buffer.byteLength - offset} remain`,
      );
      break;
    }

    let rawSize: number;
    try {
      rawSize = view.getUint32(offset);
    } catch (e) {
      console.log(
        `[concatMP4] ⚠️ OVERREAD at offset ${offset}: ` +
          `DataView.getUint32() threw — "${(e as Error).message}"`,
      );
      break;
    }

    // Guard: can we read the type field?
    if (offset + 8 > buffer.byteLength) {
      console.log(
        `[concatMP4] ⚠️ OVERREAD at offset ${offset}: ` +
          `need 8 bytes for header but only ${buffer.byteLength - offset} remain`,
      );
      break;
    }

    let boxType: string;
    try {
      boxType = bytesToAscii(view, offset + 4, 4);
    } catch {
      boxType = "????";
    }

    let size: number;
    let headerSize: number;

    if (rawSize === 0) {
      size = buffer.byteLength - offset;
      headerSize = 8;
    } else if (rawSize === 1) {
      if (offset + 16 > buffer.byteLength) {
        console.log(
          `[concatMP4] ⚠️ OVERREAD in extended size for box "${boxType}" at offset ${offset}: ` +
            `need 16 bytes for extended header but only ${buffer.byteLength - offset} remain`,
        );
        break;
      }
      try {
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 0x1_0000_0000 + low;
      } catch (e) {
        console.log(
          `[concatMP4] ⚠️ OVERREAD in extended size for box "${boxType}": ` +
            `DataView threw — "${(e as Error).message}"`,
        );
        break;
      }
      headerSize = 16;
    } else {
      size = rawSize;
      headerSize = 8;
    }

    const endOffset = offset + size;
    const remainingAfterHeader = buffer.byteLength - offset;
    const exceeds = size > remainingAfterHeader;

    // ── Log every box ─────────────────────────────────────────────────────
    const marker = exceeds ? " ⚠️ OVERREAD" : "";
    console.log(
      `[concatMP4] [#${boxCount}] type="${boxType}" ` +
        `offset=${offset} size=${size} endOffset=${endOffset}${marker}`,
    );

    // ── ftyp diagnostic ──────────────────────────────────────────────────
    if (boxType === "ftyp" && !exceeds) {
      try {
        const major = bytesToAscii(view, offset + 8, 4);
        const compat: string[] = [];
        for (let i = offset + 16; i < endOffset; i += 4) {
          if (i + 4 <= endOffset) {
            compat.push(bytesToAscii(view, i, 4));
          }
        }
        console.log(
          `[concatMP4]   ftyp: majorBrand="${major}" compatibleBrands=[${compat.join(", ")}]`,
        );
      } catch {
        // ignore
      }
    }

    // ── If this box exceeds the buffer, we stop ──────────────────────────
    if (exceeds) {
      console.log(
        `[concatMP4]   → Box "${boxType}" reports size=${size} but only ` +
          `${remainingAfterHeader} bytes remain in buffer. ` +
          `This causes child/sibling reads to overrun.`,
      );
      console.log(
        `[concatMP4]   → Parent file likely has a malformed or ` +
          `fragmented MP4 box structure that the progressive parser cannot handle.`,
      );
      break;
    }

    // ── Recurse into container box children (diagnostic depth) ────────────
    if (isContainerBox(boxType) && endOffset <= buffer.byteLength) {
      let childPos = offset + headerSize;
      const childrenEnd = endOffset;
      let childIdx = 0;

      while (childPos + 8 <= childrenEnd && childIdx < 500) {
        let cSize: number;
        try {
          cSize = view.getUint32(childPos);
        } catch (e) {
          console.log(
            `[concatMP4]   └─ ⚠️ OVERREAD in child box at offset ${childPos}: ` +
              `DataView threw — "${(e as Error).message}"`,
          );
          break;
        }

        let cType: string;
        try {
          cType = bytesToAscii(view, childPos + 4, 4);
        } catch {
          cType = "????";
        }

        const cRealSize = cSize === 0 ? childrenEnd - childPos : cSize;
        const cExceeds = childPos + cRealSize > childrenEnd;

        console.log(
          `[concatMP4]   [#${boxCount}.${childIdx}] type="${cType}" ` +
            `offset=${childPos} size=${cRealSize}${cExceeds ? " ⚠️ OVERREAD" : ""}`,
        );

        childPos += cRealSize > 0 ? cRealSize : 8;
        childIdx++;
      }
    }

    offset = endOffset;
    boxCount++;
  }

  console.log(`\n[concatMP4] DIAGNOSTIC COMPLETE — ${boxCount} top-level boxes parsed`);
  console.log(`[concatMP4] Final offset: ${offset} / ${buffer.byteLength}\n`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function bytesToHex(buffer: ArrayBuffer, start: number, length: number): string {
  const bytes = new Uint8Array(buffer, start, Math.min(length, buffer.byteLength - start));
  return (
    Array.from(bytes.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ") + (bytes.length > 32 ? "..." : "")
  );
}

/**
 * Validate an MP4 buffer: check ftyp, probe box structure.
 * Returns true if the file appears to be a valid ISOBMFF / QuickTime.
 */
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

// ── Self-test: if this file is run directly (e.g. via tsx) ────────────────────

if (DIAGNOSTIC) {
  console.log("[concatMP4] Module loaded. Call diagnosticDump(buffer) to run diagnostics.");
}
