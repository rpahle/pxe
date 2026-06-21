'use strict';
const http    = require('http');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cfg     = require('../config');
const { startTFTP }   = require('./tftp-server');
const { startDHCP }   = require('./dhcp-server');
const IfaceManager    = require('./iface-manager');
const {
  loadProfiles,
  promptSelectProfiles,
  generatePxelinuxConfig,
  generateGrubConfig,
  generateIpxeScript,
  buildDhcpTable,
} = require('./profile-manager');

const app  = express();
const ROOT = path.join(__dirname, '..');

function timestamp() { return new Date().toISOString(); }

(async () => {
  // ── Load profiles ─────────────────────────────────────────────────────────
  const profiles       = loadProfiles(ROOT);
  const activeProfiles = await promptSelectProfiles(profiles);

  // ── Generate boot configs + register per-profile HTTP routes ───────────────
  for (const p of activeProfiles) {
    if (p.bootMethod === 'pxelinux') {
      const cfgPath = path.join(ROOT, 'pxelinux.cfg', 'default');
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, generatePxelinuxConfig(p));
    }

    if (p.grub) {
      const grubCfg = generateGrubConfig(p);
      app.get(`/profiles/${p.id}/grub.cfg`, (req, res) =>
        res.type('text/plain').send(grubCfg));
    }

    if (p.bootMethod === 'ipxe' || p.bootMethod === 'ipxe-iso') {
      const ipxeScript = generateIpxeScript(p);
      app.get(`/profiles/${p.id}/boot.ipxe`, (req, res) =>
        res.type('text/plain').send(ipxeScript));
    }
  }

  // ── Active profile banner ──────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          PXE Boot Server  —  Multi-Profile               ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Server : http://${cfg.serverIp}:${cfg.httpPort}                  ║`);
  if (activeProfiles.length === 0) {
    console.log('║  (no profiles active)                                    ║');
  } else {
    for (const p of activeProfiles) {
      const routing = p.mac ? `MAC ${p.mac}` : `any ${p.arch}`;
      const line    = `  ${p.id}  [${p.bootMethod}]  ${routing}`;
      console.log(`║${line.padEnd(58)}║`);

      const filesDir = path.join(ROOT, 'files', p.id);
      if (fs.existsSync(filesDir)) {
        for (const name of fs.readdirSync(filesDir)) {
          try {
            const stat = fs.statSync(path.join(filesDir, name));
            if (!stat.isFile()) continue;
            const mb   = (stat.size / 1024 / 1024).toFixed(1);
            const line2 = `    ${name}  (${mb} MB)`;
            console.log(`║${line2.padEnd(58)}║`);
          } catch (_) {}
        }
      }
    }
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // ── NIC / DHCP prompts ────────────────────────────────────────────────────
  const mgr     = new IfaceManager();
  const useDhcp = await mgr.askDhcp();

  if (useDhcp) {
    const selected = await mgr.selectInterface();
    if (selected) mgr.apply(selected.name, cfg.serverIp, cfg.subnetMask);
  }

  // ── Request logging middleware ─────────────────────────────────────────────
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
        ? (contentLen / elapsed / 1024 / 1024).toFixed(2) + ' MB/s' : '?';
      console.log(
        `[${timestamp()}] DONE     ${clientIp}  ${req.url}` +
        ` | ${res.statusCode} | ${sizeMb} | ${elapsed.toFixed(1)}s | ${speed}`
      );
    });

    res.on('close', () => {
      if (!finished) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[${timestamp()}] ABORT    ${clientIp}  ${req.url} | after ${elapsed}s`);
      }
    });

    next();
  });

  // ── Static routes (after dynamic per-profile routes above) ────────────────
  app.use('/profiles',     express.static(path.join(ROOT, 'profiles')));
  app.use('/files',        express.static(path.join(ROOT, 'files')));
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
    res.status(500).send('Server error\n');
  });

  // ── HTTP server ───────────────────────────────────────────────────────────
  const httpServer = http.createServer(app);
  httpServer.on('error', err => {
    console.error(`[${timestamp()}] FATAL: ${err.message}`);
    process.exit(1);
  });

  // ── Shutdown ──────────────────────────────────────────────────────────────
  function shutdown(sig) {
    console.log(`\n[${timestamp()}] ${sig} received — shutting down...`);
    mgr.restore();
    httpServer.close();
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── Start servers ─────────────────────────────────────────────────────────
  const { macTable, archTable } = buildDhcpTable(activeProfiles);
  if (useDhcp) startDHCP(macTable, archTable);
  startTFTP(ROOT);

  httpServer.listen(cfg.httpPort, '0.0.0.0', () => {
    console.log(`[${timestamp()}] HTTP listening on 0.0.0.0:${cfg.httpPort} — ready\n`);
  });
})();
