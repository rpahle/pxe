'use strict';
const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');

const TFTP_PORT  = 69;
const OP_RRQ     = 1;
const OP_DATA    = 3;
const OP_ACK     = 4;
const OP_ERROR   = 5;
const OP_OACK    = 6;
const ERR_NOT_FOUND = 1;
const ERR_ACCESS    = 2;
const TIMEOUT_MS  = 5000;
const MAX_RETRIES = 5;

// Log progress for large files every this many blocks
const PROGRESS_BLOCKS = 512; // ~750 KB at blksize=1468

function ts() { return new Date().toISOString(); }

// All sends go through the MAIN socket (port 69) so MikroTik's srcnat
// connection tracking can reverse-NAT replies back to the Rock5B.
// A per-transfer ephemeral socket would be outside the NAT table.

function startTFTP(rootDir) {
  const absRoot   = path.resolve(rootDir);
  const server    = dgram.createSocket('udp4');
  const transfers = new Map(); // key: "addr:port"

  function send(pkt, addr, port) { server.send(pkt, port, addr); }

  function sendErr(addr, port, code, msg) {
    const buf = Buffer.alloc(5 + msg.length);
    buf.writeUInt16BE(OP_ERROR, 0);
    buf.writeUInt16BE(code, 2);
    buf.write(msg, 4, 'ascii');
    buf.writeUInt8(0, 4 + msg.length);
    send(buf, addr, port);
  }

  function finish(key, state, ok) {
    if (state.done) return;
    state.done = true;
    if (state.timer) clearTimeout(state.timer);
    transfers.delete(key);
    try { fs.closeSync(state.fd); } catch (_) {}
    if (ok) {
      const s = (Date.now() - state.startTime) / 1000;
      console.log(
        `[${ts()}] TFTP DONE ${state.addr} ${state.name}` +
        ` | ${state.fileSize.toLocaleString()} B | ${s.toFixed(1)}s` +
        ` | ${s > 0 ? Math.round(state.fileSize / s).toLocaleString() : '?'} B/s`
      );
    }
  }

  function armTimer(key, state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (state.done) return;
      if (++state.retries > MAX_RETRIES) {
        console.log(`[${ts()}] TFTP TIMEOUT ${state.addr} ${state.name}`);
        finish(key, state, false);
        return;
      }
      // Retransmit OACK or current window
      if (state.sentBytes === -1) {
        send(state.oackPkt, state.addr, state.port);
        armTimer(key, state);
      } else {
        sendWindow(key, state, state.windowStart); // sets its own timer
      }
    }, TIMEOUT_MS);
  }

  function buildData(state, n) {
    const offset  = (n - 1) * state.blockSize;
    const toRead  = offset >= state.fileSize ? 0 : Math.min(state.blockSize, state.fileSize - offset);
    const dataBuf = Buffer.alloc(toRead);
    let bytesRead = 0;
    if (toRead > 0)
      bytesRead = fs.readSync(state.fd, dataBuf, 0, toRead, offset);
    const pkt = Buffer.alloc(4 + bytesRead);
    pkt.writeUInt16BE(OP_DATA, 0);
    pkt.writeUInt16BE(n & 0xffff, 2);
    dataBuf.copy(pkt, 4, 0, bytesRead);
    return { pkt, bytesRead };
  }

  // Send up to windowSize blocks starting at startBlock.
  // Sets state.windowStart, state.windowEnd, state.isLastWindow.
  function sendWindow(key, state, startBlock) {
    state.windowStart   = startBlock;
    state.isLastWindow  = false;

    for (let i = 0; i < state.windowSize; i++) {
      const n = startBlock + i;
      let pkt, bytesRead;
      try { ({ pkt, bytesRead } = buildData(state, n)); }
      catch (e) { finish(key, state, false); return; }

      send(pkt, state.addr, state.port);
      state.windowEnd = n;

      if (bytesRead < state.blockSize) {
        state.isLastWindow = true;
        break;
      }
    }

    armTimer(key, state);
  }

  server.on('message', (msg, rinfo) => {
    if (msg.length < 4) return;
    const op  = msg.readUInt16BE(0);
    const key = `${rinfo.address}:${rinfo.port}`;

    // ── ACK ──────────────────────────────────────────────────────────────────
    if (op === OP_ACK) {
      const state = transfers.get(key);
      if (!state || state.done) return;
      const ack = msg.readUInt16BE(2);

      if (state.sentBytes === -1) {
        // Waiting for ACK 0 confirming our OACK
        if (ack === 0) {
          state.sentBytes = 0;
          if (state.timer) clearTimeout(state.timer);
          state.retries = 0;
          sendWindow(key, state, 1);
        }
        return;
      }

      const winEnd16 = state.windowEnd & 0xffff;

      if (ack === winEnd16) {
        // ACK for the last block of the current window
        state.retries = 0;
        if (state.timer) clearTimeout(state.timer);

        if (state.isLastWindow) { finish(key, state, true); return; }

        // Progress log for large files
        if (state.fileSize > 1_000_000 && state.windowEnd % PROGRESS_BLOCKS === 0) {
          const sent = Math.min(state.windowEnd * state.blockSize, state.fileSize);
          const s    = (Date.now() - state.startTime) / 1000;
          const pct  = Math.round(sent / state.fileSize * 100);
          const rate = s > 0 ? Math.round(sent / s) : 0;
          console.log(
            `[${ts()}] TFTP ...   ${state.addr} ${state.name}` +
            ` | ${pct}% | ${rate.toLocaleString()} B/s`
          );
        }

        sendWindow(key, state, state.windowEnd + 1);

      } else {
        // Intermediate ACK (block within window, or partial window loss) —
        // reset timer so we don't time out while the window is still flowing
        state.retries = 0;
        if (state.timer) clearTimeout(state.timer);
        armTimer(key, state);
      }
      return;
    }

    // ── RRQ ──────────────────────────────────────────────────────────────────
    if (op !== OP_RRQ) return;

    let i = 2;
    const fnEnd = msg.indexOf(0, i); if (fnEnd < 0) return;
    const filename = msg.slice(i, fnEnd).toString().replace(/\\/g, '/');
    i = fnEnd + 1;
    const modeEnd = msg.indexOf(0, i); if (modeEnd < 0) return;
    i = modeEnd + 1;

    const opts = {};
    while (i < msg.length) {
      const kEnd = msg.indexOf(0, i); if (kEnd < 0) break;
      const k = msg.slice(i, kEnd).toString().toLowerCase(); i = kEnd + 1;
      const vEnd = msg.indexOf(0, i); if (vEnd < 0) break;
      opts[k] = msg.slice(i, vEnd).toString(); i = vEnd + 1;
    }

    const rel      = filename.replace(/^\/+/, '');
    const fullPath = path.join(absRoot, rel);

    if (!fullPath.startsWith(absRoot + path.sep) && fullPath !== absRoot) {
      console.log(`[${ts()}] TFTP DENY  ${rinfo.address} "${filename}"`);
      sendErr(rinfo.address, rinfo.port, ERR_ACCESS, 'Access denied');
      return;
    }

    let fileSize;
    try { fileSize = fs.statSync(fullPath).size; }
    catch (_) {
      console.log(`[${ts()}] TFTP 404   ${rinfo.address} "${filename}"`);
      sendErr(rinfo.address, rinfo.port, ERR_NOT_FOUND, 'File not found');
      return;
    }

    // ── Negotiate options ────────────────────────────────────────────────────
    let blockSize  = 512;
    let windowSize = 1;
    const negOpts  = {};

    if (opts.blksize) {
      blockSize = Math.min(Math.max(parseInt(opts.blksize) || 512, 8), 65464);
      negOpts.blksize = String(blockSize);
    } else if (fileSize > 33_553_920) {
      // >32 MB with 512-byte blocks would overflow the 16-bit block counter
      blockSize = 1468;
      negOpts.blksize = String(blockSize);
    }
    if (opts.windowsize) {
      windowSize = Math.min(Math.max(parseInt(opts.windowsize) || 1, 1), 64);
      negOpts.windowsize = String(windowSize);
    }
    if ('tsize' in opts) negOpts.tsize = String(fileSize);

    const useOack  = Object.keys(negOpts).length > 0;
    const optExtra = Object.entries(opts)
      .filter(([k]) => !['blksize','tsize','windowsize'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join(' ');

    console.log(
      `[${ts()}] TFTP GET   ${rinfo.address} "${filename}"` +
      ` (${fileSize.toLocaleString()} B, blksize=${blockSize}, window=${windowSize}` +
      `${optExtra ? ', ' + optExtra : ''})`
    );

    let fd;
    try { fd = fs.openSync(fullPath, 'r'); }
    catch (e) {
      sendErr(rinfo.address, rinfo.port, ERR_NOT_FOUND, 'Cannot open file');
      return;
    }

    // Close any stale transfer from the same client (retransmitted RRQ)
    const prev = transfers.get(key);
    if (prev) finish(key, prev, false);

    // Build OACK packet (reused on retransmit)
    let oackPkt = null;
    if (useOack) {
      const parts = [];
      for (const [k, v] of Object.entries(negOpts)) parts.push(`${k}\0${v}\0`);
      const payload = Buffer.from(parts.join(''), 'ascii');
      oackPkt = Buffer.alloc(2 + payload.length);
      oackPkt.writeUInt16BE(OP_OACK, 0);
      payload.copy(oackPkt, 2);
    }

    const state = {
      addr: rinfo.address, port: rinfo.port,
      fd, fileSize, blockSize, windowSize,
      name: path.basename(filename),
      oackPkt,
      sentBytes: -1,          // -1 = waiting for OACK ACK 0
      windowStart: 0, windowEnd: 0,
      isLastWindow: false,
      retries: 0, timer: null, done: false,
      startTime: Date.now(),
    };
    transfers.set(key, state);

    if (useOack) {
      send(oackPkt, rinfo.address, rinfo.port);
      armTimer(key, state);
    } else {
      sendWindow(key, state, 1);
    }
  });

  server.on('error', err => {
    console.error(`[${ts()}] TFTP ERROR: ${err.message}`);
    if (err.code === 'EADDRINUSE') console.error(`[${ts()}]   → port 69 already in use`);
    if (err.code === 'EACCES')    console.error(`[${ts()}]   → run as Administrator`);
  });

  server.bind(TFTP_PORT, '0.0.0.0', () => {
    console.log(`[${ts()}] TFTP listening on 0.0.0.0:${TFTP_PORT}`);
  });

  return server;
}

module.exports = { startTFTP };
