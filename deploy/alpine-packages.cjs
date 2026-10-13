#!/usr/bin/env node
// Fetches Alpine packages, with everything they depend on, for a server that
// reaches no mirror: deploy/offline.sh installs them there from the files.
//
//   node deploy/alpine-packages.cjs <directory> <package>...
//
//   ALPINE_RELEASE  the server's release, v3.24 say (required)
//   ALPINE_ARCH     x86_64 unless set
//   ALPINE_HAVE     packages the server already has, space-separated: left out
//   ALPINE_MIRROR   https://dl-cdn.alpinelinux.org/alpine unless set; any
//                   mirror will do, apk checks every package's signature
//                   against the keys in the image
//
// Prints what it fetched and how much. Node.js 22, nothing to install.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [dir, ...wanted] = process.argv.slice(2);
const release = process.env.ALPINE_RELEASE;
const arch = process.env.ALPINE_ARCH || 'x86_64';
const have = new Set((process.env.ALPINE_HAVE || '').split(/\s+/).filter(Boolean));
const mirror = (process.env.ALPINE_MIRROR || 'https://dl-cdn.alpinelinux.org/alpine').replace(/\/+$/, '');
if (!dir || !wanted.length || !release) {
  console.error('usage: ALPINE_RELEASE=v3.24 node deploy/alpine-packages.cjs <directory> <package>...');
  process.exit(2);
}

/** The files of a tar archive, by name. */
const untar = (archive) => {
  const files = {};
  for (let at = 0; at + 512 <= archive.length; ) {
    const name = archive.toString('utf8', at, at + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(archive.toString('utf8', at + 124, at + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    files[name] = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

/**
 * One file, asked again when the network drops it: a hundred and seventy
 * downloads in a row are where a connection gets reset once.
 */
const fetched = async (url, attempts = 4) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const reason = error.cause?.code ?? error.message;
      if (attempt === attempts) throw new Error(`${url}: ${reason}`);
      console.error(`${url}: ${reason}, again`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
};

/** Every package of one repository of the release: name, version, size, what it needs and provides. */
const indexOf = async (repository) => {
  // The index is two gzip streams, its signature and itself; gunzip reads both.
  const text = untar(zlib.gunzipSync(await fetched(`${mirror}/${release}/${repository}/${arch}/APKINDEX.tar.gz`))).APKINDEX.toString('utf8');
  return text.split('\n\n').filter(Boolean).map((block) => {
    const entry = { repository, needs: [], provides: [], priority: 0 };
    for (const line of block.split('\n')) {
      const value = line.slice(2);
      if (line.startsWith('P:')) entry.name = value;
      if (line.startsWith('V:')) entry.version = value;
      if (line.startsWith('S:')) entry.size = Number(value);
      if (line.startsWith('D:')) entry.needs = value.split(' ').filter(Boolean);
      if (line.startsWith('p:')) entry.provides = value.split(' ').filter(Boolean).map((token) => token.split('=')[0]);
      if (line.startsWith('k:')) entry.priority = Number(value);
    }
    return entry;
  });
};

(async () => {
  const packages = [...(await indexOf('main')), ...(await indexOf('community'))];
  const named = new Map(packages.map((entry) => [entry.name, entry]));
  const providers = new Map();
  for (const entry of packages) for (const token of entry.provides) providers.set(token, [...(providers.get(token) ?? []), entry]);

  // What the server has already satisfies whatever it provides.
  const satisfied = new Set(have);
  for (const name of have) for (const token of named.get(name)?.provides ?? []) satisfied.add(token);

  const needed = new Map();
  const queue = [...wanted];
  while (queue.length) {
    const token = queue.shift();
    if (token.startsWith('!')) continue;
    const bare = token.replace(/[<>=~].*$/, '');
    if (satisfied.has(bare)) continue;
    const entry = named.get(bare) ?? (providers.get(bare) ?? []).sort((a, b) => b.priority - a.priority)[0];
    if (!entry) throw new Error(`nothing in ${release} provides ${token}`);
    satisfied.add(bare);
    if (needed.has(entry.name) || have.has(entry.name)) continue;
    needed.set(entry.name, entry);
    for (const provided of entry.provides) satisfied.add(provided);
    queue.push(...entry.needs);
  }

  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const entry of needed.values()) {
    const file = `${entry.name}-${entry.version}.apk`;
    fs.writeFileSync(path.join(dir, file), await fetched(`${mirror}/${release}/${entry.repository}/${arch}/${file}`));
    bytes += entry.size;
  }
  console.log(`${needed.size} packages, ${(bytes / 1024 ** 2).toFixed(0)} MB, in ${dir}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
