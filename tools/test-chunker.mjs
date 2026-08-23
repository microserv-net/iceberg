#!/usr/bin/env node
/* ICEBERG — chunker checks.
 *
 *   node tools/test-chunker.mjs
 *
 * Three things are verified, and they are the three the architecture rests on:
 *
 *   1. StreamCutter and whole-buffer cut() agree exactly. They are different
 *      code paths over the same algorithm and the capture path uses the first.
 *   2. Chunk sizes land inside the floor and ceiling, with an average near the
 *      target. A mis-tuned mask silently produces either one enormous chunk or
 *      a million tiny ones, and neither is visible until a vault is huge.
 *   3. An insertion in the middle of a large stream re-synchronises. This is
 *      the whole reason for content-defined boundaries; if it stops holding,
 *      every calve after a package install would upload the entire machine.
 */

import { createHash } from 'node:crypto';
import { StreamCutter, cut, findBoundary } from '../js/chunker.js';
import { KEEL } from '../js/config.js';

const sha = async (b) => createHash('sha256').update(b).digest('hex');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/* Pseudo-random but deterministic "filesystem": mostly compressible text with
 * binary stretches, which is roughly what a root filesystem looks like. */
function makeStream(bytes, seed = 1) {
  const out = new Uint8Array(bytes);
  let s = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = (i % 900 < 700) ? 32 + (s % 95) : s & 0xff;
  }
  return out;
}

const MB = 1024 * 1024;

(async () => {
  console.log(`chunker: floor ${KEEL.minChunk / 1024} KB · target ${KEEL.avgChunk / MB} MB · ceiling ${KEEL.maxChunk / MB} MB\n`);

  const data = makeStream(48 * MB);

  /* ---- 1. the two paths agree ---- */
  const whole = await cut(data, sha);

  const streamed = [];
  const sc = new StreamCutter(async (hash, slice, off) => { streamed.push({ hash, off, len: slice.length }); }, sha);
  // Push in awkward sizes, the way a walk over real files does.
  let i = 0;
  let n = 7;
  while (i < data.length) {
    const take = Math.min(n, data.length - i);
    await sc.push(data.subarray(i, i + take));
    i += take;
    n = (n * 7919) % 3_000_000 + 1;
  }
  await sc.flush();

  check('stream and whole-buffer produce the same count', whole.length === streamed.length,
    `${whole.length} vs ${streamed.length}`);
  const identical = whole.every((c, k) => streamed[k] && streamed[k].hash === c.hash && streamed[k].off === c.off && streamed[k].len === c.len);
  check('stream and whole-buffer produce identical chunks', identical);

  /* ---- 2. size distribution ---- */
  const lens = whole.map((c) => c.len);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const min = Math.min(...lens), max = Math.max(...lens);
  const inBounds = lens.slice(0, -1).every((l) => l >= KEEL.minChunk && l <= KEEL.maxChunk);
  check('every chunk is inside the floor and ceiling', inBounds, `min ${(min / 1024) | 0} KB · max ${(max / 1024) | 0} KB`);
  check('average is within 2× of target', avg > KEEL.avgChunk / 2 && avg < KEEL.avgChunk * 2,
    `average ${(avg / 1024) | 0} KB over ${lens.length} chunks`);
  check('total is conserved', whole.reduce((a, c) => a + c.len, 0) === data.length);

  /* ---- 3. resynchronisation after an insertion ---- */
  const insertAt = 9 * MB + 12345;
  const inserted = makeStream(256 * 1024, 99);
  const changed = new Uint8Array(data.length + inserted.length);
  changed.set(data.subarray(0, insertAt), 0);
  changed.set(inserted, insertAt);
  changed.set(data.subarray(insertAt), insertAt + inserted.length);

  const after = await cut(changed, sha);
  const before = new Set(whole.map((c) => c.hash));
  const shared = after.filter((c) => before.has(c.hash));
  const newBytes = after.filter((c) => !before.has(c.hash)).reduce((a, c) => a + c.len, 0);

  const ratio = shared.length / after.length;
  check('a 256 KB insertion keeps most chunks', ratio > 0.9,
    `${shared.length}/${after.length} shared (${(ratio * 100).toFixed(1)}%)`);
  check('the upload is proportional to the change, not the stream', newBytes < 8 * MB,
    `${(newBytes / MB).toFixed(2)} MB new out of ${(changed.length / MB).toFixed(0)} MB`);

  /* what a fixed-size splitter would have cost, for contrast */
  const fixed = 1 * MB;
  const fixedBefore = new Set();
  for (let k = 0; k < data.length; k += fixed) fixedBefore.add(await sha(data.subarray(k, k + fixed)));
  let fixedNew = 0;
  for (let k = 0; k < changed.length; k += fixed) {
    const slice = changed.subarray(k, k + fixed);
    if (!fixedBefore.has(await sha(slice))) fixedNew += slice.length;
  }
  console.log(`\n  for contrast: fixed 1 MB blocks would have uploaded ${(fixedNew / MB).toFixed(1)} MB for the same edit.`);

  /* ---- boundary determinism ---- */
  const view = data.subarray(0, 6 * MB);
  check('findBoundary is deterministic', findBoundary(view) === findBoundary(view));

  console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
})();
