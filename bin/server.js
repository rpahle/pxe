'use strict';
const http    = require('http');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cfg     = require('../config');
const { startTFTP } = require('./tftp-server');
const { startDHCP } = require('./dhcp-server');
const IfaceManager  = require('./iface-manager');

const app       = express();
const ROOT      = path.join(__dirname, '..');
const FILES_DIR = path.join(ROOT, 'files');

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function timestamp() {
  return new Date().toISOString();
}

(async () => {
  // Generate pxelinux.cfg/default from config so URLs always match serverIp
  fs.writeFileSync(
    path.join(ROOT, 'pxelinux.cfg', 'default'),
    [
      'DEFAULT rescue',
      'TIMEOUT 10',
      'PROMPT 0',
      '',
      'LABEL rescue',
      `  KERNEL http://${cfg.serverIp}:${cfg.httpPort}/linux`,
      `  INITRD http://${cfg.serverIp}:${cfg.httpPort}/initrd.gz`,
      `  APPEND console=ttyS2,1500000n8 priority=critical auto=true preseed/url=http://${cfg.serverIp}:${cfg.httpPort}/preseed.cfg hostname=rock5b domain=`,
      `  FDT http://${cfg.serverIp}:${cfg.httpPort}/dtb/rockchip/rk3588-rock-5b.dtb`,
    ].join('\n') + '\n'
  );

  // Startup banner
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          PXE HTTP Boot Server  —  Rock5B Rescue          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Server : http://${cfg.serverIp}:${cfg.httpPort}                  ║`);
  console.log(`║  Serving: ${FILES_DIR.padEnd(46)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');

  try {
    const entries = fs.readdirSync(FILES_DIR);
    if (entries.length === 0) {
      console.log('║  (no files found)                                        ║');
    } else {
      for (const name of entries) {
        const stat = fs.statSync(path.join(FILES_DIR, name));
        const size = formatBytes(stat.size);
        const line = `  ${name}  (${size})`;
        console.log(`║${line.padEnd(58)}║`);
      }
    }
  } catch (err) {
    console.log(`║  ERROR reading files dir: ${err.message.substring(0, 31).padEnd(31)}║`);
  }

  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Interactive prompts
  const mgr     = new IfaceManager();
  const useDhcp = await mgr.askDhcp();

  if (useDhcp) {
    const selected = await mgr.selectInterface();
    if (selected) mgr.apply(selected.name, cfg.serverIp, cfg.subnetMask);
  }

  // Request logging + speed tracking
  app.use((req, res, next) => {
    const start    = Date.now();
    const clientIp = req.socket.remoteAddress || req.ip || 'unknown';

    console.log(`[${timestamp()}] REQUEST  ${clientIp}  ${req.method} ${req.url}`);

    let finished = false;

    res.on('finish', () => {
      finished = true;
      const elapsed    = (Date.now() - start) / 1000;
      const contentLen = parseInt(res.getHeader('content-length') || '0', 10);
      const sizeMb     = contentLen > 0 ? (contentLen / 1024 / 1024).toFixed(1) + ' MB' : '? MB';
      const speed      = contentLen > 0 && elapsed > 0
        ? (contentLen / elapsed / 1024 / 1024).toFixed(2) + ' MB/s'
        : '?';
      console.log(
        `[${timestamp()}] DONE     ${clientIp}  ${req.url}` +
        ` | ${res.statusCode} | ${sizeMb} | ${elapsed.toFixed(1)}s | ${speed}`
      );
    });

    res.on('close', () => {
      if (!finished) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[${timestamp()}] ABORT    ${clientIp}  ${req.url} | connection closed after ${elapsed}s`);
      }
    });

    next();
  });

  // grub.cfg served dynamically so preseed URL reflects current serverIp
  app.get('/grub/grub.cfg', (req, res) => {
    res.type('text/plain').send(
      `linux /linux console=ttyS2,1500000n8 priority=critical auto=true preseed/url=http://${cfg.serverIp}:${cfg.httpPort}/preseed.cfg hostname=rock5b domain=\ninitrd /initrd.gz\nboot\n`
    );
  });

  // Serve boot files and pxelinux config
  app.use(express.static(FILES_DIR));
  app.use('/pxelinux.cfg', express.static(path.join(ROOT, 'pxelinux.cfg')));

  // 404
  app.use((req, res) => {
    const clientIp = req.socket.remoteAddress || req.ip || 'unknown';
    console.log(`[${timestamp()}] 404      ${clientIp}  ${req.url}`);
    res.status(404).send('Not found\n');
  });

  // Error handler
  app.use((err, req, res, next) => {
    const clientIp = req.socket.remoteAddress || req.ip || 'unknown';
    console.error(`[${timestamp()}] ERROR    ${clientIp}  ${req.url}  —  ${err.message}`);
    console.error(err.stack);
    res.status(500).send('Server error\n');
  });

  const httpServer = http.createServer(app);
  httpServer.on('error', (err) => {
    console.error(`[${timestamp()}] FATAL: ${err.message}`);
    process.exit(1);
  });

  function shutdown(sig) {
    console.log(`\n[${timestamp()}] ${sig} received — shutting down...`);
    mgr.restore();
    httpServer.close();
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (useDhcp) startDHCP();
  startTFTP(ROOT);

  httpServer.listen(cfg.httpPort, '0.0.0.0', () => {
    console.log(`[${timestamp()}] HTTP listening on 0.0.0.0:${cfg.httpPort} — ready for PXE boot requests\n`);
  });
})();
