'use strict';
const deny = () => { throw new Error('OFFLINE_IO_FORBIDDEN'); };
for (const name of ['node:net', 'node:tls', 'node:http', 'node:https', 'node:dgram']) {
  const m = require(name);
  for (const key of ['connect','createConnection','request','get','createSocket','createServer']) if (key in m) m[key] = deny;
  for (const key of ['Socket','Server']) if (m[key]?.prototype) for (const method of ['connect','listen']) if (method in m[key].prototype) m[key].prototype[method] = deny;
}
globalThis.fetch = deny;
for (const key of ['setTimeout','setInterval','setImmediate']) globalThis[key] = deny;
const child = require('node:child_process');
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[key] = deny;
