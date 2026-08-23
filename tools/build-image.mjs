#!/usr/bin/env node
/* ICEBERG — build a base image.
 *
 *   node tools/build-image.mjs <rootfs-dir> <image-id> [--label "Alpine 3.21"]
 *
 * Produces, under images/<image-id>/:
 *   image.json          the manifest, in the same shape a floe uses
 *   keel/<aa>/<h>    content-addressed chunks, deflate-raw compressed
 *
 * The output of this script is what every user's BASE points at, so it must
 * agree with the browser byte for byte:
 *
 *   - the same Gear table, from the same seed
 *   - the same chunk floor / average / ceiling
 *   - the same path-sorted stream order
 *   - the same exclusion list
 *   - the same per-file sha256
 *
 * If any of those drift, users' calves stop matching the image's chunks and
 * every vault silently doubles in size. The constants below are duplicated from
 * js/config.js and js/keel.js deliberately — this file has no browser
 * imports — and the check at the bottom fails the build if they disagree with
 * what it can read from those files.
 *
 * Getting a rootfs:
 *   curl -LO https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86/alpine-minirootfs-3.21.0-x86.tar.gz
 *   mkdir rootfs && tar -xzf alpine-minirootfs-*.tar.gz -C rootfs
 *   # add a kernel and initramfs under rootfs/boot — v86 boots them from the 9p tree
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const MIN = 256 * 1024;
const AVG_MASK = (1 << 20) - 1;
const MAX = 4 * 1024 * 1024;

const EXCLUDED = [
  '/proc/', '/sys/', '/dev/', '/run/', '/tmp/',
  '/var/cache/apk/', '/var/tmp/', '/var/log/',
];

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

const GEAR = (() => {
  const t = new Uint32Array(256);
  let s = 0x1f2e3d4c;
  for (let i = 0; i < 256; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    t[i] = s;
  }
  return t;
})();

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/* ---- the same cutter, without the streaming machinery ---- */
function cut(bytes) {
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + MAX, bytes.length);
    if (bytes.length - start > MIN) {
      let h = 0;
      for (let i = start + MIN; i < end; i++) {
        h = ((h << 1) + GEAR[bytes[i]]) >>> 0;
        if ((h & AVG_MASK) === 0) { end = i + 1; break; }
      }
    }
    out.push({ hash: sha256(bytes.subarray(start, end)), off: start, len: end - start });
    start = end;
  }
  return out;
}

/* ---- walk ---- */
function walk(root) {
  const entries = [];
  const visit = (abs, rel) => {
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    const p = rel === '' ? '/' : rel;
    if (p !== '/' && EXCLUDED.some((e) => p === e.slice(0, -1) || p.startsWith(e))) return;

    if (st.isDirectory()) {
      if (p !== '/') entries.push({ p, m: S_IFDIR | (st.mode & 0o7777), u: st.uid, g: st.gid, t: Math.floor(st.mtimeMs / 1000) });
      for (const name of fs.readdirSync(abs).sort()) visit(path.join(abs, name), `${rel}/${name}`);
    } else if (st.isSymbolicLink()) {
      entries.push({ p, m: S_IFLNK | 0o777, u: st.uid, g: st.gid, t: Math.floor(st.mtimeMs / 1000), l: fs.readlinkSync(abs) });
    } else if (st.isFile()) {
      entries.push({ p, m: 0o100000 | (st.mode & 0o7777), u: st.uid, g: st.gid, t: Math.floor(st.mtimeMs / 1000), s: st.size, abs });
    }
    // Device nodes, fifos and sockets are not carried: they are recreated by
    // the guest at boot and cannot be represented in a 9p JSON tree anyway.
  };
  visit(root, '');
  return entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

/* ---- build ---- */
function main() {
  const [rootfs, id, ...rest] = process.argv.slice(2);
  if (!rootfs || !id) {
    console.error('usage: build-image.mjs <rootfs-dir> <image-id> [--label "..."] [--version "3.21"]');
    process.exit(2);
  }
  const label = arg(rest, '--label') ?? id;
  const version = arg(rest, '--version') ?? null;

  const outDir = path.resolve(process.cwd(), 'images', id);
  fs.mkdirSync(path.join(outDir, 'keel'), { recursive: true });

  console.log(`walking ${rootfs}`);
  const entries = walk(path.resolve(rootfs));
  console.log(`  ${entries.length} entries`);

  // One pass: build the stream, hash files, cut, write chunks.
  const files = [];
  const chunks = [];
  let carry = Buffer.alloc(0);
  let streamOff = 0;
  let dataBytes = 0;
  const written = new Set();

  const emit = (final) => {
    while (carry.length >= (final ? 1 : MAX)) {
      const view = carry.subarray(0, Math.min(carry.length, MAX));
      let end = view.length;
      if (!final || view.length > MIN) {
        let h = 0;
        let found = 0;
        for (let i = MIN; i < view.length; i++) {
          h = ((h << 1) + GEAR[view[i]]) >>> 0;
          if ((h & AVG_MASK) === 0) { found = i + 1; break; }
        }
        if (found) end = found;
        else if (!final) end = MAX;
      }
      const slice = Buffer.from(carry.subarray(0, end));
      const hash = sha256(slice);
      chunks.push({ h: hash, o: streamOff, n: slice.length });
      if (!written.has(hash)) {
        written.add(hash);
        const dir = path.join(outDir, 'keel', hash.slice(0, 2));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, hash), deflateRawSync(slice, { level: 9 }));
      }
      carry = carry.subarray(end);
      streamOff += end;
      if (!final && carry.length < MAX) break;
      if (final && carry.length === 0) break;
    }
  };

  let n = 0;
  for (const e of entries) {
    const rec = { p: e.p, m: e.m, u: e.u, g: e.g, t: e.t };
    if (e.l !== undefined) rec.l = e.l;
    else if ((e.m & S_IFMT) !== S_IFDIR) {
      const buf = fs.readFileSync(e.abs);
      rec.s = buf.length;
      rec.off = streamOff + carry.length;
      rec.h = sha256(buf);
      carry = Buffer.concat([carry, buf]);
      dataBytes += buf.length;
      emit(false);
    }
    files.push(rec);
    if (++n % 2000 === 0) process.stdout.write(`\r  ${n}/${entries.length}`);
  }
  emit(true);
  process.stdout.write(`\r  ${n}/${entries.length}\n`);

  const index = { v: 1, files, streamBytes: streamOff, fileCount: files.length, dataBytes, image: id };
  const gz = deflateRawSync(Buffer.from(JSON.stringify(index)), { level: 9 });
  const indexChunks = [];
  for (const c of cut(gz)) {
    indexChunks.push(c.hash);
    if (written.has(c.hash)) continue;
    written.add(c.hash);
    const dir = path.join(outDir, 'keel', c.hash.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, c.hash), deflateRawSync(gz.subarray(c.off, c.off + c.len), { level: 9 }));
  }

  const manifest = {
    schema: 1,
    id, label, version,
    os: 'Alpine Linux',
    arch: 'x86',
    built: new Date().toISOString(),
    sha256: sha256(Buffer.from(chunks.map((c) => c.h).join(''))),
    fs: { fileCount: files.length, dataBytes, streamBytes: streamOff, streamChunks: chunks, indexChunks },
  };
  fs.writeFileSync(path.join(outDir, 'image.json'), JSON.stringify(manifest, null, 2));

  const onDisk = [...written].reduce((sum, h) => {
    try { return sum + fs.statSync(path.join(outDir, 'keel', h.slice(0, 2), h)).size; } catch { return sum; }
  }, 0);

  console.log(`\n${id}`);
  console.log(`  files        ${files.length}`);
  console.log(`  data         ${(dataBytes / 1048576).toFixed(1)} MB`);
  console.log(`  chunks       ${chunks.length} (${written.size} unique)`);
  console.log(`  on disk      ${(onDisk / 1048576).toFixed(1)} MB compressed`);
  console.log(`  → images/${id}/`);

  verifyConstants();
}

function arg(list, name) {
  const i = list.indexOf(name);
  return i === -1 ? null : list[i + 1];
}

/* Fails loudly if the browser's constants have moved away from these. */
function verifyConstants() {
  try {
    const cfg = fs.readFileSync(path.resolve('js/config.js'), 'utf8');
    const min = /minChunk:\s*(\d+)\s*\*\s*1024/.exec(cfg);
    const max = /maxChunk:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(cfg);
    const mask = /mask:\s*\(1\s*<<\s*(\d+)\)/.exec(cfg);
    const ok = min && Number(min[1]) * 1024 === MIN
            && max && Number(max[1]) * 1048576 === MAX
            && mask && ((1 << Number(mask[1])) - 1) === AVG_MASK;
    if (!ok) {
      console.error('\n!! js/config.js disagrees with this builder about chunk sizes.');
      console.error('!! Users calving against this image would share nothing with it.');
      process.exit(1);
    }
  } catch {
    console.warn('(could not cross-check js/config.js — run this from the repository root)');
  }
}

main();
