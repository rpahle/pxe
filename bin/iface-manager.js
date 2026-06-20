'use strict';
const { execSync }  = require('child_process');
const os            = require('os');
const readline      = require('readline');

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function maskToCidr(mask) {
  return mask.split('.').reduce((acc, o) => {
    return acc + parseInt(o, 10).toString(2).replace(/0/g, '').length;
  }, 0);
}

function ts() { return new Date().toISOString(); }

class IfaceManager {
  constructor() {
    this.iface      = null;
    this.applyIp    = null;
    this.cidr       = null;
    this.savedState = null;
  }

  // Step 1: ask whether to start DHCP
  async askDhcp() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await ask(rl, '\nStart DHCP server? [y/N]: ');
    rl.close();
    return answer.trim().toLowerCase() === 'y';
  }

  // Step 2: list interfaces and ask user to pick one
  async selectInterface() {
    const ifaces   = os.networkInterfaces();
    const candidates = [];

    for (const [name, addrs] of Object.entries(ifaces)) {
      if (/^lo$|loopback/i.test(name)) continue;
      const v4 = (addrs || []).find(a => a.family === 'IPv4' || a.family === 4);
      candidates.push({ name, ip: v4?.address || 'no IPv4' });
    }

    if (candidates.length === 0) {
      console.log('[iface] No network interfaces found — skipping IP management');
      return null;
    }

    console.log('\nAvailable interfaces:');
    candidates.forEach((c, i) => {
      console.log(`  [${i + 1}] ${c.name.padEnd(32)} ${c.ip}`);
    });
    console.log('  [0] Skip — manage IP manually\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await ask(rl, 'Select interface: ');
    rl.close();

    const n = parseInt(answer.trim(), 10);
    if (!n || n < 1 || n > candidates.length) return null;
    return candidates[n - 1];
  }

  // Save current state then apply rescue IP
  apply(ifaceName, ip, mask) {
    this.iface   = ifaceName;
    this.applyIp = ip;
    this.cidr    = maskToCidr(mask);

    try {
      if (process.platform === 'win32') {
        const out = execSync(`netsh interface ip show address "${ifaceName}"`, { encoding: 'utf8' });
        const isDhcp = /DHCP Enabled:\s+Yes/i.test(out);
        if (isDhcp) {
          this.savedState = { type: 'dhcp' };
        } else {
          const ipM   = out.match(/IP Address:\s+([\d.]+)/);
          const maskM = out.match(/mask ([\d.]+)/i);
          const gwM   = out.match(/Default Gateway:\s+([\d.]+)/);
          this.savedState = {
            type:    'static',
            ip:      ipM?.[1],
            mask:    maskM?.[1] || '255.255.255.0',
            gateway: gwM?.[1],
          };
        }
        execSync(`netsh interface ip set address "${ifaceName}" static ${ip} ${mask}`);
      } else {
        this.savedState = { type: 'addonly' };
        try {
          execSync(`ip addr add ${ip}/${this.cidr} dev ${ifaceName}`);
        } catch (e) {
          if (/RTNETLINK.*exists/i.test(e.stderr?.toString() || e.message)) {
            console.log(`[${ts()}] IFACE    ${ip}/${this.cidr} already on ${ifaceName} — skipping`);
            return;
          }
          throw e;
        }
      }
      console.log(`[${ts()}] IFACE    ${ifaceName} → ${ip}/${this.cidr} assigned`);
    } catch (e) {
      console.error(`[${ts()}] IFACE    apply failed: ${e.message}`);
    }
  }

  // Restore original interface state
  restore() {
    if (!this.iface || !this.savedState) return;
    try {
      if (process.platform === 'win32') {
        if (this.savedState.type === 'dhcp') {
          execSync(`netsh interface ip set address "${this.iface}" dhcp`);
          console.log(`[${ts()}] IFACE    ${this.iface} → restored to DHCP`);
        } else if (this.savedState.ip) {
          const gw = this.savedState.gateway ? ` ${this.savedState.gateway}` : '';
          execSync(`netsh interface ip set address "${this.iface}" static ${this.savedState.ip} ${this.savedState.mask}${gw}`);
          console.log(`[${ts()}] IFACE    ${this.iface} → restored to ${this.savedState.ip}`);
        }
      } else {
        execSync(`ip addr del ${this.applyIp}/${this.cidr} dev ${this.iface}`);
        console.log(`[${ts()}] IFACE    removed ${this.applyIp}/${this.cidr} from ${this.iface}`);
      }
    } catch (e) {
      console.error(`[${ts()}] IFACE    restore failed: ${e.message}`);
    }
  }
}

module.exports = IfaceManager;
