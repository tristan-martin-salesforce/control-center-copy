#!/usr/bin/env node
// The web of a compiled release (D-90): Next's standalone server (server.js at the release root), bound to
// 127.0.0.1 only (D-76, PKG-1: never every interface; the standalone server reads HOSTNAME, which a shell can carry,
// so it is set here, not inherited). PORT comes from the LaunchAgent (4327) or the env file.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = join(root, 'server.js');
if (!existsSync(server)) {
  console.error(`[start-web] no server.js in ${root}: this is not a compiled release (run npm run start in a source checkout)`);
  process.exit(78);
}
process.env.HOSTNAME = '127.0.0.1';
process.env.PORT ||= '4327';
process.env.NODE_ENV ||= 'production';
await import(pathToFileURL(server).href);
