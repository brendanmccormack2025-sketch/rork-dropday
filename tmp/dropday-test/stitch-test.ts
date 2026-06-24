/**
 * stitch-test.ts — Load parent and reaction clips, run the MP4 box parser
 * on both with try/catch around EVERY DataView read, and log the exact
 * failure point.
 *
 * Usage: bun run /tmp/dropday-test/stitch-test.ts
 */

import { readFileSync } from "node:fs";

const textDecoder = new TextDecoder();

function bytesToAscii(view: DataView, offset: number, length: number): string {
  try {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
    return textDecoder.decode(bytes);
  } catch (e) {
    return `[ERR:${(e as Error).message}]`;
  }
}

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

// ── Safe DataView reader wrappers ────────────────────────────────────────────

function safeGetUint32(view: DataView, offset: number, label: string): number | { error: string } {
  if (offset + 4 > view.byteLength) {
    return { error: `[${label}] offset=${offset} +4 exceeds buffer byteLength=${view.byteLength} (${view.byteLength - offset} bytes remain)` };
  }
  try {
    return view.getUint32(offset);
  } catch (e) {
    return { error: `[${label}] offset=${offset} DataView.getUint32() threw: ${(e as Error).message} | buffer=${view.byteLength} bytes` };
  }
}

function safeGetUint32_noLabel(view: DataView, offset: number): number | { error: string } {
  return safeGetUint32(view, offset, "unknown");
}

// ── Parsing with FULL try/catch ──────────────────────────────────────────────

interface Mp4Box {
  type: string;
  offset: number;
  size: number;
  endOffset: number;
  children: Mp4Box[];
}

function parseBoxSafe(view: DataView, offset: number, depth: number, fileLabel: string): Mp4Box | null {
  const indent = "  ".repeat(depth);

  // Read box size
  if (offset + 4 > view.byteLength) {
    console.log(`${indent}[${fileLabel}] OVERREAD at offset=${offset}: need 4 bytes for size, only ${view.byteLength - offset} remain`);
    return null;
  }

  let rawSize: number;
  try {
    rawSize = view.getUint32(offset);
  } catch (e) {
    console.log(`${indent}[${fileLabel}] OVERREAD at offset=${offset}: getUint32(size) threw: ${(e as Error).message} | buffer=${view.byteLength}B`);
    return null;
  }

  // Read box type
  if (offset + 8 > view.byteLength) {
    console.log(`${indent}[${fileLabel}] OVERREAD at offset=${offset}: need 8 bytes for header, only ${view.byteLength - offset} remain`);
    return null;
  }

  let boxType: string;
  try {
    boxType = bytesToAscii(view, offset + 4, 4);
  } catch (e) {
    boxType = `ERR:${(e as Error).message}`;
  }

  // Check reserved bytes are zero — sanity check for non-MP4 data
  const reserved = view.getUint32(offset + 8);
  const looksLikeMp4 = (boxType === "ftyp" || boxType === "moov" || boxType === "mdat" || boxType === "free" || boxType === "skip" || boxType === "wide");

  let size: number;
  let headerSize: number;

  if (rawSize === 0) {
    size = view.byteLength - offset;
    headerSize = 8;
  } else if (rawSize === 1) {
    if (offset + 16 > view.byteLength) {
      console.log(`${indent}[${fileLabel}] OVERREAD at offset=${offset} box="${boxType}": need 16 bytes for extended header, only ${view.byteLength - offset} remain`);
      return null;
    }
    try {
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 0x1_0000_0000 + low;
    } catch (e) {
      console.log(`${indent}[${fileLabel}] OVERREAD at offset=${offset} box="${boxType}": extended size read threw: ${(e as Error).message}`);
      return null;
    }
    headerSize = 16;
  } else {
    size = rawSize;
    headerSize = 8;
  }

  const endOffset = offset + size;
  const children: Mp4Box[] = [];

  // ── Log the box ──────────────────────────────────────────────────────────
  const exceeds = endOffset > view.byteLength;
  const marker = exceeds ? " ⚠️ EXCEEDS BUFFER" : "";
  console.log(
    `${indent}[${fileLabel}] BOX [#${depth}] type="${boxType}" offset=${offset} size=${size} endOffset=${endOffset}${marker}`
  );

  if (boxType === "ftyp" && !exceeds) {
    try {
      const major = bytesToAscii(view, offset + 8, 4);
      const compat: string[] = [];
      for (let i = offset + 16; i < endOffset && i + 4 <= endOffset; i += 4) {
        compat.push(bytesToAscii(view, i, 4));
      }
      console.log(`${indent}[${fileLabel}]   ftyp majorBrand="${major.trim()}" compatible=[${compat.map(c => c.trim()).join(", ")}]`);
    } catch {}
  }

  // If this box exceeds the buffer, stop recursing
  if (exceeds) {
    console.log(`${indent}[${fileLabel}]   → Box size=${size} exceeds buffer byteLength=${view.byteLength}. Aborting recursion.`);
    return null;
  }

  // ── Recurse into container box children ──────────────────────────────────
  if (isContainerBox(boxType) && endOffset <= view.byteLength) {
    let childPos = offset + headerSize;
    const childrenEnd = endOffset;
    let childIdx = 0;

    while (childPos + 8 <= childrenEnd && childIdx < 500) {
      // Guard check before each child read
      if (childPos + 4 > view.byteLength) {
        console.log(`${indent}  [${fileLabel}] OVERREAD at child offset=${childPos}: need 4 bytes, only ${view.byteLength - childPos} remain`);
        break;
      }

      let cSize: number;
      try {
        cSize = view.getUint32(childPos);
      } catch (e) {
        console.log(`${indent}  [${fileLabel}] OVERREAD at child offset=${childPos}: getUint32 threw: ${(e as Error).message} | buffer=${view.byteLength}B`);
        break;
      }

      const child = parseBoxSafe(view, childPos, depth + 1, fileLabel);
      if (!child) break;
      children.push(child);

      if (cSize === 0) break;

      const advance = cSize === 1 ? child.size : cSize;
      if (advance <= 0) break;

      childPos += advance;
      childIdx++;
    }
  }

  return { type: boxType, offset, size, endOffset, children };
}

function parseTopLevelSafe(buffer: ArrayBuffer, fileLabel: string): void {
  const view = new DataView(buffer);
  let offset = 0;
  let boxCount = 0;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`[${fileLabel}] PARSING — buffer size: ${buffer.byteLength} bytes`);
  console.log(`${"=".repeat(70)}`);

  while (offset < view.byteLength && boxCount < 500) {
    if (offset + 8 > view.byteLength) {
      console.log(`[${fileLabel}] STOP: only ${view.byteLength - offset} bytes remain at offset=${offset} (need 8 for box header)`);
      break;
    }

    const box = parseBoxSafe(view, offset, 0, fileLabel);
    if (!box) break;

    offset = box.endOffset;
    boxCount++;
  }

  console.log(`[${fileLabel}] DONE — ${boxCount} top-level boxes parsed. Final offset: ${offset}/${view.byteLength}\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const parentBuf = readFileSync("/tmp/dropday-test/parent.mov").buffer;
const reactionBuf = readFileSync("/tmp/dropday-test/reaction.mov").buffer;

console.log("=== STITCH DIAGNOSTIC TEST ===");
console.log(`Parent:  ${parentBuf.byteLength} bytes`);
console.log(`Reaction: ${reactionBuf.byteLength} bytes\n`);

parseTopLevelSafe(parentBuf, "PARENT");
parseTopLevelSafe(reactionBuf, "REACTION");

// ── Try parsing them together (simulated concat) ─────────────────────────────
console.log(`${"=".repeat(70)}`);
console.log(`SIMULATED CONCAT: parsing parent+reaction as one contiguous buffer`);
console.log(`${"=".repeat(70)}`);
const combined = new Uint8Array(parentBuf.byteLength + reactionBuf.byteLength);
combined.set(new Uint8Array(parentBuf), 0);
combined.set(new Uint8Array(reactionBuf), parentBuf.byteLength);
parseTopLevelSafe(combined.buffer, "COMBINED");

console.log("\n=== TEST COMPLETE ===");
