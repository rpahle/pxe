'use strict';
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const cfg      = require('../config');

// Arch codes from DHCP option 60 "PXEClient:Arch:NNNNN"
const ARCH_CODES = {
  '00000': 'x86',
  '00007': 'x86_64',
  '00011': 'arm64',
};

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function expandTokens(str) {
  return str
    .replace(/\{serverIp\}/g,  cfg.serverIp)
    .replace(/\{httpPort\}/g,  String(cfg.httpPort));
}

function expandObject(obj) {
  if (typeof obj === 'string') return expandTokens(obj);
  if (Array.isArray(obj))     return obj.map(expandObject);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = expandObject(v);
    return out;
  }
  return obj;
}

function loadProfiles(rootDir) {
  const profilesDir = path.join(rootDir, 'profiles');
  if (!fs.existsSync(profilesDir)) return [];

  const profiles = [];
  for (const entry of fs.readdirSync(profilesDir)) {
    const jsonPath = path.join(profilesDir, entry, 'profile.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const raw     = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const profile = expandObject(raw);

      const filesDir = path.join(rootDir, 'files', profile.filesDir || profile.id);
      profile._filesExist = fs.existsSync(filesDir);
      if (!profile._filesExist) {
        console.warn(`[profiles] WARNING: files/${profile.id}/ not found — profile will load but boot files may be missing`);
      }
      profiles.push(profile);
    } catch (e) {
      console.warn(`[profiles] WARNING: failed to parse ${jsonPath}: ${e.message}`);
    }
  }
  return profiles;
}

function extractRootpass(p) {
  const candidates = [p.ipxe?.append, p.pxelinux?.append, p.grub?.linux].filter(Boolean);
  for (const s of candidates) {
    const m = s.match(/rootpass=(\S+)/);
    if (m) return m[1];
  }
  return null;
}

async function promptSelectProfiles(profiles) {
  if (profiles.length === 0) {
    console.log('[profiles] No profiles found in profiles/ — starting with no boot profiles.');
    return [];
  }

  console.log('\nAvailable boot profiles:');
  profiles.forEach((p, i) => {
    const macInfo  = p.macs
      ? p.macs.map(m => `MAC: ${m.mac}`).join(', ')
      : (p.mac ? `MAC: ${p.mac}` : `any ${p.arch} client`);
    const warning  = p._filesExist ? '' : '  ⚠ files missing';
    const sshInfo = p.ssh || (extractRootpass(p) ? `root / ${extractRootpass(p)}` : null);
    console.log(`  [${i + 1}] ${p.id.padEnd(30)} ${p.name}`);
    console.log(`       ${p.description}`);
    console.log(`       arch: ${p.arch} | method: ${p.bootMethod} | ${macInfo}${warning}`);
    if (sshInfo) console.log(`       ssh: ${sshInfo}`);
  });
  console.log('  [0] All profiles\n');

  const rl     = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, `Select profiles [1]: `);
  rl.close();

  const trimmed = answer.trim();
  if (trimmed === '0' || trimmed.toLowerCase() === 'all') return profiles;
  if (trimmed === '') return [profiles[0]];

  const indices = trimmed.split(',').map(s => parseInt(s.trim(), 10));
  const selected = indices
    .filter(n => n >= 1 && n <= profiles.length)
    .map(n => profiles[n - 1]);

  return selected.length > 0 ? selected : [profiles[0]];
}

function generatePxelinuxConfig(profile) {
  const p = profile.pxelinux;
  const lines = [
    'DEFAULT ' + p.label,
    'TIMEOUT 10',
    'PROMPT 0',
    '',
    'LABEL ' + p.label,
    '  KERNEL ' + p.kernel,
    '  INITRD ' + p.initrd,
    '  APPEND ' + p.append,
  ];
  if (p.fdt) lines.push('  FDT ' + p.fdt);
  return lines.join('\n') + '\n';
}

function generateGrubConfig(profile) {
  const g = profile.grub;
  return `linux ${g.linux}\ninitrd ${g.initrd}\nboot\n`;
}

function generateIpxeScript(profile) {
  const i = profile.ipxe;
  if (profile.bootMethod === 'ipxe-iso') {
    return `#!ipxe\nsanboot ${i.sanboot}\n`;
  }
  const initrdLines = Array.isArray(i.initrd)
    ? i.initrd.map(u => `initrd ${u}`).join('\n')
    : `initrd ${i.initrd}`;
  return `#!ipxe\nkernel ${i.kernel} ${i.append || ''}\n${initrdLines}\nboot\n`;
}

// Build MAC→entry and arch→entry lookup tables for the DHCP server.
// archPool from config provides IPs for arch-matched clients (no static assignment).
function buildDhcpTable(profiles) {
  const macTable  = new Map(); // mac string → { ip, bootFile, profileId, ipxeScriptUrl }
  const archTable = new Map(); // arch integer → { bootFile, profileId, ipxeScriptUrl, poolIndex }

  for (const p of profiles) {
    const ipxeScriptUrl = (p.bootMethod === 'ipxe' || p.bootMethod === 'ipxe-iso')
      ? `http://${cfg.serverIp}:${cfg.httpPort}/profiles/${p.id}/boot.ipxe`
      : null;

    // Support "macs" array of {mac, assignedIp} or legacy single "mac"+"assignedIp"
    const macEntries = p.macs
      ? p.macs
      : (p.mac ? [{ mac: p.mac, assignedIp: p.assignedIp }] : []);

    if (macEntries.length > 0) {
      for (const { mac, assignedIp, bootFileByArch } of macEntries) {
        macTable.set(mac.toLowerCase(), {
          ip:            assignedIp,
          bootFile:      p.bootFile,
          bootFileByArch: bootFileByArch || null,
          profileId:     p.id,
          ipxeScriptUrl,
        });
      }
    } else {
      // Map arch string → integer code
      const archCode = Object.entries(ARCH_CODES).find(([, v]) => v === p.arch)?.[0];
      if (!archCode) {
        console.warn(`[profiles] WARNING: unknown arch "${p.arch}" in profile ${p.id} — skipped in arch table`);
        continue;
      }
      archTable.set(parseInt(archCode, 10), {
        bootFile:      p.bootFile,
        profileId:     p.id,
        ipxeScriptUrl,
      });
    }
  }

  return { macTable, archTable };
}

module.exports = {
  loadProfiles,
  promptSelectProfiles,
  generatePxelinuxConfig,
  generateGrubConfig,
  generateIpxeScript,
  buildDhcpTable,
  ARCH_CODES,
};
