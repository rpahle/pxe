'use strict';
const dgram = require('dgram');
const cfg   = require('../config');

const SERVER_PORT  = 67;
const CLIENT_PORT  = 68;
const MAGIC_COOKIE = Buffer.from([99, 130, 83, 99]);

function ts() { return new Date().toISOString(); }

function ipToBytes(ip) {
  return ip.split('.').map(Number);
}

function macFromChaddr(buf) {
  return Array.from(buf.slice(28, 34))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':');
}

function getMsgType(buf) {
  let i = 240;
  while (i < buf.length) {
    const opt = buf[i];
    if (opt === 255) break;
    if (opt === 0)  { i++; continue; }
    const len = buf[i + 1];
    if (opt === 53 && len === 1) return buf[i + 2];
    i += 2 + len;
  }
  return null;
}

function buildReply(msgType, xid, mac, yiaddr) {
  const buf = Buffer.alloc(548);
  buf[0] = 2;  // op: BOOTREPLY
  buf[1] = 1;  // htype: Ethernet
  buf[2] = 6;  // hlen
  xid.copy(buf, 4);
  buf.writeUInt16BE(0x8000, 10); // flags: broadcast
  ipToBytes(yiaddr).forEach((b, i)      => { buf[16 + i] = b; }); // yiaddr
  ipToBytes(cfg.serverIp).forEach((b, i) => { buf[20 + i] = b; }); // siaddr
  Buffer.from(mac.split(':').map(s => parseInt(s, 16))).copy(buf, 28); // chaddr
  MAGIC_COOKIE.copy(buf, 236);

  let o = 240;

  function optBytes(type, ...bytes) {
    buf[o++] = type; buf[o++] = bytes.length;
    bytes.forEach(b => { buf[o++] = b; });
  }
  function optStr(type, str) {
    const b = Buffer.from(str, 'ascii');
    buf[o++] = type; buf[o++] = b.length;
    b.copy(buf, o); o += b.length;
  }
  function optU32(type, val) {
    buf[o++] = type; buf[o++] = 4;
    buf.writeUInt32BE(val, o); o += 4;
  }

  optBytes(53, msgType);                     // DHCP message type
  optBytes(54, ...ipToBytes(cfg.serverIp));  // server identifier
  optU32(51, 3600);                          // lease time: 1 hour
  optBytes(1,  ...ipToBytes(cfg.subnetMask)); // subnet mask
  optStr(66, cfg.serverIp);                  // TFTP server name
  optStr(67, cfg.bootFile);                  // boot filename
  buf[o++] = 255;                            // end

  return buf.slice(0, o);
}

function startDHCP() {
  const targetMac = cfg.rock5bMac.toLowerCase();
  const server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  server.on('message', (msg) => {
    if (msg.length < 240) return;
    if (msg[0] !== 1) return;                         // only BOOTREQUEST
    if (!msg.slice(236, 240).equals(MAGIC_COOKIE)) return;

    const mac = macFromChaddr(msg);
    if (mac !== targetMac) return;                    // ignore other MACs

    const xid     = msg.slice(4, 8);
    const msgType = getMsgType(msg);

    if (msgType === 1) {
      console.log(`[${ts()}] DHCP DISC  ${mac} → offering ${cfg.rock5bIp}`);
      const pkt = buildReply(2, xid, mac, cfg.rock5bIp);
      server.send(pkt, CLIENT_PORT, '255.255.255.255');
    } else if (msgType === 3) {
      console.log(`[${ts()}] DHCP REQ   ${mac} → ACK ${cfg.rock5bIp}`);
      const pkt = buildReply(5, xid, mac, cfg.rock5bIp);
      server.send(pkt, CLIENT_PORT, '255.255.255.255');
    }
  });

  server.on('error', err => {
    console.error(`[${ts()}] DHCP ERROR: ${err.message}`);
    if (err.code === 'EADDRINUSE') console.error(`[${ts()}]   → port 67 already in use`);
    if (err.code === 'EACCES')    console.error(`[${ts()}]   → run as Administrator`);
  });

  server.bind(SERVER_PORT, '0.0.0.0', () => {
    server.setBroadcast(true);
    console.log(`[${ts()}] DHCP listening on 0.0.0.0:${SERVER_PORT} — ${cfg.rock5bMac} → ${cfg.rock5bIp}`);
  });

  return server;
}

module.exports = { startDHCP };
