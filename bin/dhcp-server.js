'use strict';
const dgram = require('dgram');
const cfg   = require('../config');

const SERVER_PORT  = 67;
const CLIENT_PORT  = 68;
const MAGIC_COOKIE = Buffer.from([99, 130, 83, 99]);

// In-process pool for arch-matched clients: mac → assigned IP
const archLeases = new Map();
let   archPoolIdx = 0;

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
  return getOption(buf, 53);
}

// Walk DHCP options, return value of first matching type as a Buffer (or null).
function getOptionBuf(buf, type) {
  let i = 240;
  while (i < buf.length) {
    const opt = buf[i];
    if (opt === 255) break;
    if (opt === 0)  { i++; continue; }
    const len = buf[i + 1];
    if (opt === type) return buf.slice(i + 2, i + 2 + len);
    i += 2 + len;
  }
  return null;
}

// Return numeric value of a 1-byte option, or null.
function getOption(buf, type) {
  const b = getOptionBuf(buf, type);
  return b && b.length >= 1 ? b[0] : null;
}

// Return option 60 (vendor class) as a string, or ''.
function getVendorClass(buf) {
  const b = getOptionBuf(buf, 60);
  return b ? b.toString('ascii') : '';
}

// Parse arch code from "PXEClient:Arch:NNNNN:..." → integer, or -1.
function parseArchCode(vendorClass) {
  const m = vendorClass.match(/PXEClient:Arch:(\d{5})/);
  return m ? parseInt(m[1], 10) : -1;
}

function buildReply(msgType, xid, mac, yiaddr, bootFile) {
  const buf = Buffer.alloc(548);
  buf[0] = 2;  // op: BOOTREPLY
  buf[1] = 1;  // htype: Ethernet
  buf[2] = 6;  // hlen
  xid.copy(buf, 4);
  buf.writeUInt16BE(0x8000, 10); // flags: broadcast
  ipToBytes(yiaddr).forEach((b, i)       => { buf[16 + i] = b; }); // yiaddr
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

  optBytes(53, msgType);                      // DHCP message type
  optBytes(54, ...ipToBytes(cfg.serverIp));   // server identifier
  optU32(51, 3600);                           // lease time: 1 hour
  optBytes(1,  ...ipToBytes(cfg.subnetMask)); // subnet mask
  if (cfg.gateway) optBytes(3, ...ipToBytes(cfg.gateway)); // router
  optStr(66, cfg.serverIp);                   // TFTP server name
  optStr(67, bootFile);                       // boot filename
  buf[o++] = 255;                             // end

  return buf.slice(0, o);
}

function assignArchIp(mac) {
  if (archLeases.has(mac)) return archLeases.get(mac);
  const pool = cfg.archPool || [];
  if (pool.length === 0) return null;
  const ip = pool[archPoolIdx % pool.length];
  archPoolIdx++;
  archLeases.set(mac, ip);
  return ip;
}

function startDHCP(macTable, archTable) {
  const server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  server.on('message', (msg) => {
    if (msg.length < 240) return;
    if (msg[0] !== 1) return;                          // only BOOTREQUEST
    if (!msg.slice(236, 240).equals(MAGIC_COOKIE)) return;

    const mac     = macFromChaddr(msg);
    const xid     = msg.slice(4, 8);
    const msgType = getMsgType(msg);
    if (msgType !== 1 && msgType !== 3) return;        // DISCOVER or REQUEST only

    let yiaddr, bootFile, profileId;

    // 1. MAC table — exact match (e.g. Rock5B)
    if (macTable && macTable.has(mac)) {
      const entry = macTable.get(mac);
      yiaddr    = entry.ip;
      bootFile  = entry.bootFile;
      profileId = entry.profileId;

    // 2. Arch table — detect architecture from option 60
    } else if (archTable) {
      const vendorClass = getVendorClass(msg);
      if (!vendorClass) return;

      // iPXE re-request: serve the .ipxe script instead of the binary (prevents loop)
      if (vendorClass.startsWith('iPXEClient')) {
        const leaseIp = archLeases.get(mac);
        if (!leaseIp) {
          console.log(`[${ts()}] DHCP DROP  ${mac} iPXE re-request but no prior lease — ignoring`);
          return;
        }
        yiaddr = leaseIp;
        for (const [, entry] of archTable) {
          if (entry.ipxeScriptUrl) {
            bootFile  = entry.ipxeScriptUrl;
            profileId = entry.profileId;
            break;
          }
        }
        if (!bootFile) {
          console.log(`[${ts()}] DHCP DROP  ${mac} iPXE re-request but no ipxe script in active profiles`);
          return;
        }
        console.log(`[${ts()}] DHCP iPXE  ${mac} re-request → serving script: ${bootFile}`);
      } else {
        const archCode = parseArchCode(vendorClass);
        if (archCode < 0 || !archTable.has(archCode)) {
          console.log(`[${ts()}] DHCP DROP  ${mac} unrecognized vendor class: "${vendorClass}"`);
          return;
        }
        const entry = archTable.get(archCode);
        yiaddr    = assignArchIp(mac);
        bootFile  = entry.bootFile;
        profileId = entry.profileId;
        if (!yiaddr) {
          console.log(`[${ts()}] DHCP DROP  ${mac} archPool exhausted — add more IPs to config.js archPool`);
          return;
        }
      }
    } else {
      return;
    }

    if (msgType === 1) {
      console.log(`[${ts()}] DHCP DISC  ${mac} [${profileId}]`);
      const pkt = buildReply(2, xid, mac, yiaddr, bootFile);
      server.send(pkt, CLIENT_PORT, '255.255.255.255');
      console.log(`[${ts()}] DHCP OFFER ${mac} → ${yiaddr}  boot: ${bootFile}`);
    } else {
      console.log(`[${ts()}] DHCP REQ   ${mac} [${profileId}]`);
      const pkt = buildReply(5, xid, mac, yiaddr, bootFile);
      server.send(pkt, CLIENT_PORT, '255.255.255.255');
      console.log(`[${ts()}] DHCP ACK   ${mac} → ${yiaddr}  boot: ${bootFile}`);
    }
  });

  server.on('error', err => {
    console.error(`[${ts()}] DHCP ERROR: ${err.message}`);
    if (err.code === 'EADDRINUSE') console.error(`[${ts()}]   → port 67 already in use`);
    if (err.code === 'EACCES')    console.error(`[${ts()}]   → run as Administrator`);
  });

  server.bind(SERVER_PORT, '0.0.0.0', () => {
    server.setBroadcast(true);
    console.log(`[${ts()}] DHCP listening on 0.0.0.0:${SERVER_PORT}`);
  });

  return server;
}

module.exports = { startDHCP };
