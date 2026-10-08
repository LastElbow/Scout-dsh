/** Minimal read-only asar extractor (no deps). Usage: node asar-read.mjs <app.asar> <archive/path> [out-file] */
import { readFileSync, writeFileSync } from 'node:fs';

const [asarPath, arcPath, outPath] = process.argv.slice(2);
if (!asarPath || !arcPath) {
  console.error('usage: node asar-read.mjs <app.asar> <archive/path> [out-file]');
  process.exit(2);
}
const buf = readFileSync(asarPath);
// asar header: UInt32LE pickle — [header_size][...4x uint32...][jsonSize][json...]
const headerSize = buf.readUInt32LE(0);
const jsonSize = buf.readUInt32LE(12);
const jsonStart = 16;
const headerJson = JSON.parse(buf.subarray(jsonStart, jsonStart + jsonSize).toString('utf8'));
const dataOffset = Math.ceil((jsonStart + jsonSize) / 4096) * 4096;

function find(node, parts) {
  let cur = node;
  for (const p of parts) {
    cur = cur?.files?.[p];
    if (!cur) return null;
  }
  return cur;
}
const entry = find(headerJson, arcPath.split('/').filter(Boolean));
if (!entry) {
  console.error('not found. top-level:', Object.keys(headerJson.files ?? {}).join(', '));
  process.exit(1);
}
if (entry.files) {
  console.log('DIR:', Object.keys(entry.files).slice(0, 100).join(', '));
  process.exit(0);
}
const off = dataOffset + Number(entry.offset);
const content = buf.subarray(off, off + Number(entry.size));
if (outPath) {
  writeFileSync(outPath, content);
  console.log('wrote', outPath, content.length, 'bytes');
} else {
  process.stdout.write(content);
}
