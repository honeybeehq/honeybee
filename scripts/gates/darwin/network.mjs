import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import fs from 'node:fs';

const local = host => !host || host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || /^::ffff:127\./i.test(host);
const refused = (kind, target) => {
  fs.appendFileSync(process.env.SCG_NET_VIOLATIONS, JSON.stringify({ pid: process.pid, kind, target }) + '\n');
  return Object.assign(new Error('gate refused non-loopback network'), { code: 'ESCGNET' });
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host, path;
  if (first && typeof first === 'object') ({ host, path } = first);
  else if (typeof first === 'string' && Number.isNaN(Number(first))) path = first;
  else host = typeof args[1] === 'string' ? args[1] : undefined;
  if (path || local(host)) return connect.apply(this, args);
  const error = refused('connect', host);
  process.nextTick(() => this.destroy(error));
  return this;
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (typeof host !== 'string' || local(host) || net.isIP(host)) return lookup.call(this, host, ...args);
  const error = refused('dns.lookup', host), callback = args.at(-1);
  if (typeof callback === 'function') process.nextTick(() => callback(error));
  return {};
};
const promisesLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, ...args) {
  if (typeof host !== 'string' || local(host) || net.isIP(host)) return promisesLookup.call(this, host, ...args);
  throw refused('dns.promises.lookup', host);
};
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const address = args.find((value, i) => i > 0 && typeof value === 'string');
  if (address && !local(address)) throw refused('dgram.send', address);
  return send.apply(this, args);
};
