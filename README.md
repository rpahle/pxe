# PXE Boot Server — Multi-Profile

Self-contained Node.js PXE boot server. Serves DHCP (port 67), TFTP (port 69), and HTTP (port 8080) from one process. Supports multiple OS and architecture targets simultaneously via a profile system — adding a new boot target requires no code changes, just a new folder.

Primary use case: rescuing a Rock5B (RK3588, ARM64) when NVMe boot is broken. Also supports x86/x86_64 netboot and ISO booting via iPXE.

Runs on Windows or Linux. Direct-cable connection supported — prompts you to pick a NIC, assigns the rescue IP, and restores the original IP on exit.

---

## Repository layout

```
pxe/
├── bin/
│   ├── server.js            # Entry point — HTTP server + startup prompts
│   ├── dhcp-server.js       # DHCP — MAC-first routing, arch fallback via option 60
│   ├── tftp-server.js       # TFTP — serves boot files from project root
│   ├── iface-manager.js     # NIC selection + IP assign/restore (Windows + Linux)
│   └── profile-manager.js   # Profile loading, config generation, DHCP table building
├── config.js                # Server IP, port, subnet, arch IP pool
├── profiles/                # Tracked in git — one folder per boot target
│   └── debian-rescue-arm64/
│       ├── profile.json     # Boot config, metadata, file paths
│       └── preseed.cfg      # Debian installer config (SSH console, password)
├── files/                   # Boot assets — gitignored, placed manually
│   ├── shared/
│   │   └── ipxe/
│   │       ├── ipxe.efi         # x86_64 EFI iPXE binary
│   │       └── undionly.kpxe    # x86 BIOS iPXE binary
│   └── debian-rescue-arm64/
│       ├── linux                # ARM64 netboot kernel (~36 MB)
│       ├── initrd.gz            # ARM64 netboot initrd (~41 MB)
│       ├── grubaa64.efi         # GRUB EFI binary for ARM64
│       └── dtb/rockchip/rk3588-rock-5b.dtb
└── pxelinux.cfg/
    └── default                  # Auto-generated at startup from active profile
```

---

## Prerequisites

- Node.js 18 or later
- Run as **Administrator** on Windows / **sudo** on Linux (ports 67 and 69 require elevated privileges)
- Ethernet connection to the target machine (direct cable or same switch segment, no competing DHCP server)

---

## Installation

```bash
git clone https://dev.netfusion.io/netfusion/pxe.git
cd pxe
npm install
```

Then place boot files in `files/<profile-id>/` — see [Boot files](#boot-files).

---

## Configuration

`config.js` contains only server-level settings. All boot target config (MAC, IPs, kernel args) lives in `profiles/`.

```js
module.exports = {
  serverIp:   '192.168.50.1',   // IP assigned to your NIC during rescue
  subnetMask: '255.255.255.0',
  httpPort:   8080,

  // IPs offered to arch-matched clients (no fixed MAC).
  // Assigned round-robin; persist for the lifetime of the process.
  archPool:   ['192.168.50.10', '192.168.50.11', '192.168.50.12'],
};
```

---

## Starting the server

```bash
npm start
```

### Prompt 1 — Profile selection

```
Available boot profiles:
  [1] debian-rescue-arm64    Debian Rescue — ARM64 (Rock5B)
                             Boots Debian netboot installer on Rock5B via U-Boot PXE. SSH console for NVMe repair.
                             arch: arm64 | method: pxelinux | MAC: ba:bd:81:07:be:e4
  [2] sysrescue-x86          SystemRescue — x86 ISO
                             Boots SystemRescue ISO via iPXE sanboot.
                             arch: x86 | method: ipxe-iso | any x86 BIOS client
  [0] All profiles

Select profiles [1]:
```

Enter a number, comma-separated numbers (e.g. `1,2`), `0` for all, or press Enter to take the default (first profile). Active profiles determine which clients get DHCP responses and which boot files are served.

Profiles with missing `files/<id>/` directories show a `⚠ files missing` warning — the server still starts, boot will fail for that profile until files are placed.

### Prompt 2 — DHCP

```
Start DHCP server? [y/N]:
```

- **Y** — starts the built-in DHCP server. Clients get their IP from this machine. You'll then be asked to pick a NIC.
- **N** — skips DHCP and NIC management. Use this when your router handles DHCP and you only need HTTP + TFTP from this machine.

### Prompt 3 — NIC selection (only if DHCP = Y)

```
Available interfaces:
  [1] Ethernet                          192.168.1.5
  [2] Ethernet 2                        no IPv4
  [3] Wi-Fi                             192.168.1.10
  [0] Skip — manage IP manually

Select interface:
```

Pick the NIC connected to the target. The server saves the current IP config, assigns `serverIp` from `config.js`, and restores the original on Ctrl+C. Pick `0` to skip — useful if the IP is already set.

### Startup output

```
╔══════════════════════════════════════════════════════════╗
║          PXE Boot Server  —  Multi-Profile               ║
╠══════════════════════════════════════════════════════════╣
║  Server : http://192.168.50.1:8080                       ║
║  debian-rescue-arm64  [pxelinux]  MAC ba:bd:81:07:be:e4  ║
║    linux  (36.1 MB)                                      ║
║    initrd.gz  (41.3 MB)                                  ║
╚══════════════════════════════════════════════════════════╝

[...] IFACE    Ethernet 2 → 192.168.50.1/24 assigned
[...] DHCP listening on 0.0.0.0:67
[...] TFTP listening on 0.0.0.0:69
[...] HTTP listening on 0.0.0.0:8080 — ready
```

### Shutdown

Press **Ctrl+C**. The NIC IP is restored before exit:

```
[...] SIGINT received — shutting down...
[...] IFACE    Ethernet 2 → restored to DHCP
```

---

## Profiles

Each profile is a folder under `profiles/` containing a `profile.json` and any installer config files (e.g. `preseed.cfg`). The `profiles/` directory is tracked in git. Boot assets (kernels, ISOs) go in `files/` which is gitignored.

### Profile JSON fields

| Field | Description |
|-------|-------------|
| `id` | Must match the folder name. Used in HTTP URLs and file paths. |
| `name` | Human-readable name shown at startup. |
| `description` | One-line description shown at startup. |
| `arch` | `arm64`, `x86_64`, or `x86` — used for DHCP arch detection fallback. |
| `bootMethod` | `pxelinux`, `ipxe`, or `ipxe-iso` — drives which config is generated. |
| `mac` | Ethernet MAC for MAC-matched routing. `null` for arch-detected clients. |
| `assignedIp` | Static IP offered to this MAC. `null` for arch clients (uses `archPool`). |
| `bootFile` | Path to the first file the client fetches via TFTP (option 67). |
| `pxelinux` | Boot config block for `bootMethod: "pxelinux"`. |
| `grub` | GRUB config block — served dynamically at `/profiles/<id>/grub.cfg`. |
| `ipxe` | iPXE config block for `bootMethod: "ipxe"` or `"ipxe-iso"`. |

Template tokens `{serverIp}` and `{httpPort}` in any string value are expanded at startup from `config.js`.

### Boot methods

**`pxelinux`** — Used by U-Boot on ARM boards. DHCP sends `pxelinux.cfg/default` as the boot file. U-Boot fetches it via TFTP; the file contains HTTP URLs for kernel, initrd, DTB, and kernel args. Used by the Rock5B.

**`ipxe`** — DHCP sends an iPXE binary (`ipxe.efi` or `undionly.kpxe`) as the boot file. The client fetches it via TFTP, then makes a second DHCP request identified as `iPXEClient`. The server responds with `/profiles/<id>/boot.ipxe` as the boot file. iPXE fetches that script over HTTP and boots kernel + initrd.

**`ipxe-iso`** — Same iPXE chainload as above, but the generated script uses `sanboot <iso-url>` to boot an ISO file served directly over HTTP. No extraction needed.

### DHCP routing

The DHCP server uses two-tier routing:

1. **MAC match** — if the client's MAC matches a profile's `mac` field, that profile is used and the client gets `assignedIp`. Highest priority.
2. **Arch fallback** — if no MAC matches, the server reads DHCP option 60 (vendor class identifier). U-Boot and PXE clients send `PXEClient:Arch:NNNNN` where `NNNNN` is:
   - `00000` → x86 BIOS
   - `00007` → x86_64 EFI
   - `00011` → ARM64 EFI

   The server picks the active profile matching that arch and assigns an IP from `archPool`.

3. **iPXE loop prevention** — when an iPXE binary re-requests DHCP (option 60 = `iPXEClient:...`), the server serves the `.ipxe` script URL instead of the binary again, preventing an infinite boot loop.

Unknown clients (no MAC match, no recognized arch) are silently ignored.

---

## Boot files

The `files/` directory is gitignored. Download once and place manually.

### ARM64 (Rock5B rescue)

```bash
BASE=https://deb.debian.org/debian/dists/stable/main/installer-arm64/current/images/netboot/debian-installer/arm64

mkdir -p files/debian-rescue-arm64/dtb/rockchip

wget $BASE/linux     -O files/debian-rescue-arm64/linux
wget $BASE/initrd.gz -O files/debian-rescue-arm64/initrd.gz

# GRUB EFI binary (needed by some U-Boot versions)
wget https://deb.debian.org/debian/dists/stable/main/installer-arm64/current/images/netboot/grubaa64.efi \
     -O files/debian-rescue-arm64/grubaa64.efi

# DTB — copy from a running Rock5B or Armbian SD card
cp /boot/dtb/rockchip/rk3588-rock-5b.dtb files/debian-rescue-arm64/dtb/rockchip/
```

### x86 / x86_64 (iPXE profiles)

Download iPXE binaries from [boot.ipxe.org](https://boot.ipxe.org):

```bash
mkdir -p files/shared/ipxe

wget https://boot.ipxe.org/ipxe.efi        -O files/shared/ipxe/ipxe.efi      # x86_64 EFI
wget https://boot.ipxe.org/undionly.kpxe   -O files/shared/ipxe/undionly.kpxe  # x86 BIOS
```

Then place OS-specific assets in `files/<profile-id>/`:

```bash
# Example: Debian x86_64 netboot
mkdir -p files/debian-install-x86_64
wget <debian-x86_64-netboot-url>/linux     -O files/debian-install-x86_64/linux
wget <debian-x86_64-netboot-url>/initrd.gz -O files/debian-install-x86_64/initrd.gz

# Example: SystemRescue ISO
mkdir -p files/sysrescue-x86
wget https://downloads.sourceforge.net/project/systemrescuecd/sysrescue/<ver>/systemrescue-<ver>.iso \
     -O files/sysrescue-x86/systemrescue.iso
```

---

## Adding a new profile

1. Create `profiles/<id>/profile.json` — copy an example below and edit it.
2. Place boot assets in `files/<id>/`.
3. Restart the server — the new profile appears in the selection list automatically.

No code changes required.

---

### Example 1 — Debian installer, x86_64, any EFI machine (iPXE)

Boots the Debian text installer on any x86_64 EFI machine that PXE boots. DHCP detects arch from option 60, serves the iPXE binary, then chainloads to the Debian netboot kernel.

**`profiles/debian-install-x86_64/profile.json`:**
```json
{
  "id": "debian-install-x86_64",
  "name": "Debian Installer — x86_64",
  "description": "Debian 12 netboot installer for any x86_64 EFI machine via iPXE.",
  "arch": "x86_64",
  "bootMethod": "ipxe",
  "mac": null,
  "assignedIp": null,
  "bootFile": "files/shared/ipxe/ipxe.efi",
  "ipxe": {
    "kernel": "http://{serverIp}:{httpPort}/files/debian-install-x86_64/linux",
    "initrd": "http://{serverIp}:{httpPort}/files/debian-install-x86_64/initrd.gz",
    "append": "auto=true priority=critical preseed/url=http://{serverIp}:{httpPort}/profiles/debian-install-x86_64/preseed.cfg"
  }
}
```

**`profiles/debian-install-x86_64/preseed.cfg`** (optional — for unattended installs):
```
d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string debian
d-i netcfg/get_domain string
d-i anna/choose_modules string network-console
d-i network-console/password password rescue123
d-i network-console/password-again password rescue123
d-i network-console/start boolean true
```

**Boot files:**
```bash
BASE=https://deb.debian.org/debian/dists/stable/main/installer-amd64/current/images/netboot/debian-installer/amd64
mkdir -p files/debian-install-x86_64
wget $BASE/linux     -O files/debian-install-x86_64/linux
wget $BASE/initrd.gz -O files/debian-install-x86_64/initrd.gz
```

---

### Example 2 — SystemRescue ISO, x86 BIOS (iPXE sanboot)

Boots SystemRescue directly from an ISO over HTTP. Works on old BIOS machines. No extraction — the ISO is streamed via iPXE's sanboot.

**`profiles/sysrescue-x86/profile.json`:**
```json
{
  "id": "sysrescue-x86",
  "name": "SystemRescue — x86 BIOS ISO",
  "description": "Boots SystemRescue live ISO via iPXE HTTP sanboot. For BIOS machines, no extraction needed.",
  "arch": "x86",
  "bootMethod": "ipxe-iso",
  "mac": null,
  "assignedIp": null,
  "bootFile": "files/shared/ipxe/undionly.kpxe",
  "ipxe": {
    "sanboot": "http://{serverIp}:{httpPort}/files/sysrescue-x86/systemrescue.iso"
  }
}
```

**Boot files:**
```bash
VER=11.02
mkdir -p files/sysrescue-x86
wget "https://downloads.sourceforge.net/project/systemrescuecd/sysrescue/${VER}/systemrescue-${VER}.iso" \
     -O files/sysrescue-x86/systemrescue.iso
```

---

### Example 3 — SystemRescue ISO, x86_64 EFI (iPXE sanboot)

Same as above but targets EFI machines. Uses the EFI iPXE binary.

**`profiles/sysrescue-x86_64/profile.json`:**
```json
{
  "id": "sysrescue-x86_64",
  "name": "SystemRescue — x86_64 EFI ISO",
  "description": "Boots SystemRescue live ISO via iPXE HTTP sanboot. For x86_64 EFI machines.",
  "arch": "x86_64",
  "bootMethod": "ipxe-iso",
  "mac": null,
  "assignedIp": null,
  "bootFile": "files/shared/ipxe/ipxe.efi",
  "ipxe": {
    "sanboot": "http://{serverIp}:{httpPort}/files/sysrescue-x86_64/systemrescue.iso"
  }
}
```

**Boot files:**
```bash
VER=11.02
mkdir -p files/sysrescue-x86_64
wget "https://downloads.sourceforge.net/project/systemrescuecd/sysrescue/${VER}/systemrescue-${VER}.iso" \
     -O files/sysrescue-x86_64/systemrescue.iso
```

> Note: The same ISO file works for both BIOS and EFI profiles. You can point both `sysrescue-x86` and `sysrescue-x86_64` at the same ISO by symlinking on Linux, or just copy it.

---

### Example 4 — Ubuntu Server 24.04, specific machine by MAC (iPXE autoinstall)

Targets one specific server by MAC address. Gives it a fixed IP and boots Ubuntu's autoinstall (cloud-init). The autoinstall config is served from `profiles/ubuntu-server-x86_64/`.

**`profiles/ubuntu-server-x86_64/profile.json`:**
```json
{
  "id": "ubuntu-server-x86_64",
  "name": "Ubuntu Server 24.04 — rack node",
  "description": "Unattended Ubuntu Server 24.04 install for the rack node (MAC aa:bb:cc:dd:ee:ff).",
  "arch": "x86_64",
  "bootMethod": "ipxe",
  "mac": "aa:bb:cc:dd:ee:ff",
  "assignedIp": "192.168.50.5",
  "bootFile": "files/shared/ipxe/ipxe.efi",
  "ipxe": {
    "kernel": "http://{serverIp}:{httpPort}/files/ubuntu-server-x86_64/vmlinuz",
    "initrd": "http://{serverIp}:{httpPort}/files/ubuntu-server-x86_64/initrd",
    "append": "root=/dev/ram0 ramdisk_size=1500000 ip=dhcp url=http://{serverIp}:{httpPort}/files/ubuntu-server-x86_64/ubuntu-24.04-live-server-amd64.iso autoinstall ds=nocloud-net;s=http://{serverIp}:{httpPort}/profiles/ubuntu-server-x86_64/"
  }
}
```

**`profiles/ubuntu-server-x86_64/user-data`** (cloud-init autoinstall config — minimal example):
```yaml
#cloud-config
autoinstall:
  version: 1
  locale: en_US.UTF-8
  keyboard:
    layout: us
  network:
    network:
      version: 2
      ethernets:
        any:
          match:
            name: "en*"
          dhcp4: true
  storage:
    layout:
      name: lvm
  identity:
    hostname: rack-node
    username: rob
    password: "$6$rounds=4096$saltsalt$hashedpassword"
  ssh:
    install-server: true
    allow-pw: true
  late-commands:
    - echo 'rob ALL=(ALL) NOPASSWD:ALL' > /target/etc/sudoers.d/rob
```

**`profiles/ubuntu-server-x86_64/meta-data`** (required by cloud-init, can be empty):
```yaml
instance-id: rack-node-01
```

**Boot files:**
```bash
mkdir -p files/ubuntu-server-x86_64

# Download the live server ISO
wget https://releases.ubuntu.com/24.04/ubuntu-24.04-live-server-amd64.iso \
     -O files/ubuntu-server-x86_64/ubuntu-24.04-live-server-amd64.iso

# Extract vmlinuz and initrd from the ISO
ISO=files/ubuntu-server-x86_64/ubuntu-24.04-live-server-amd64.iso
TMP=$(mktemp -d)
mount -o loop,ro "$ISO" "$TMP"
cp "$TMP/casper/vmlinuz" files/ubuntu-server-x86_64/vmlinuz
cp "$TMP/casper/initrd"  files/ubuntu-server-x86_64/initrd
umount "$TMP"
```

---

### Example 5 — Windows PE, x86_64 EFI (iPXE + wimboot)

Boots a Windows PE environment over the network using [wimboot](https://ipxe.org/wimboot). Requires a Windows ADK WIM file and `wimboot` binary.

**`profiles/winpe-x86_64/profile.json`:**
```json
{
  "id": "winpe-x86_64",
  "name": "Windows PE — x86_64",
  "description": "Windows Preinstallation Environment via iPXE + wimboot. Requires Windows ADK WIM.",
  "arch": "x86_64",
  "bootMethod": "ipxe",
  "mac": null,
  "assignedIp": null,
  "bootFile": "files/shared/ipxe/ipxe.efi",
  "ipxe": {
    "kernel": "http://{serverIp}:{httpPort}/files/winpe-x86_64/wimboot",
    "initrd": "http://{serverIp}:{httpPort}/files/winpe-x86_64/BCD      BCD\nhttp://{serverIp}:{httpPort}/files/winpe-x86_64/boot.sdi     boot.sdi\nhttp://{serverIp}:{httpPort}/files/winpe-x86_64/winpe.wim   winpe.wim",
    "append": ""
  }
}
```

> **Note:** wimboot uses a special multi-file initrd syntax. The `initrd` field above shows the format — each line is `<url> <target-name>`. This is passed as separate `initrd` lines in the generated iPXE script.

**Boot files** (requires Windows ADK installed):
```bash
mkdir -p files/winpe-x86_64

# Download wimboot
wget https://github.com/ipxe/wimboot/releases/latest/download/wimboot \
     -O files/winpe-x86_64/wimboot

# From Windows ADK (run on Windows):
# copype amd64 C:\WinPE
# Copy these files from C:\WinPE\media\Boot\ and C:\WinPE\media\sources\:
#   BCD, boot.sdi, boot.wim (rename to winpe.wim)
```

---

## Boot flow — ARM64 (pxelinux)

```
Rock5B U-Boot (SPI)
  │
  ├─ DHCP DISCOVER ──────────────────────────────────────────────────────┐
  │    ← OFFER: ip=192.168.50.2, server=192.168.50.1                    │
  │       boot-file=pxelinux.cfg/default                         [this server]
  │
  ├─ TFTP GET pxelinux.cfg/default
  │    ← contains HTTP URLs for kernel, initrd, DTB
  │
  ├─ HTTP GET /files/debian-rescue-arm64/linux        ← ARM64 kernel
  ├─ HTTP GET /files/debian-rescue-arm64/initrd.gz    ← initrd
  ├─ HTTP GET /profiles/debian-rescue-arm64/preseed.cfg
  │
  └─ Debian installer boots → SSH on 192.168.50.2:22
```

## Boot flow — x86 iPXE chainload

```
x86 client (BIOS/EFI)
  │
  ├─ DHCP DISCOVER (option 60 = "PXEClient:Arch:00007")
  │    ← OFFER: ip=192.168.50.10, boot-file=files/shared/ipxe/ipxe.efi
  │
  ├─ TFTP GET files/shared/ipxe/ipxe.efi       ← iPXE binary
  │
  ├─ iPXE DHCP DISCOVER (option 60 = "iPXEClient:...")
  │    ← OFFER: boot-file=http://192.168.50.1:8080/profiles/<id>/boot.ipxe
  │
  ├─ HTTP GET /profiles/<id>/boot.ipxe         ← iPXE script
  │
  ├─ HTTP GET /files/<id>/linux                ← kernel  (ipxe method)
  ├─ HTTP GET /files/<id>/initrd.gz            ← initrd  (ipxe method)
  │    — or —
  └─ HTTP GET /files/<id>/<name>.iso           ← ISO     (ipxe-iso sanboot)
```

---

## Rock5B rescue procedure

### 1. SSH into the installer

```bash
ssh installer@192.168.50.2
# Password: rescue123
```

### 2. Open a shell

In the Debian installer text menu: **Execute a shell** → **Continue**

### 3. Mount and chroot the NVMe

```bash
lsblk
# nvme0n1p1 = EFI, nvme0n1p2 = root (typical)

mount /dev/nvme0n1p2 /mnt
mount /dev/nvme0n1p1 /mnt/boot/efi
mount --bind /dev  /mnt/dev
mount --bind /proc /mnt/proc
mount --bind /sys  /mnt/sys
chroot /mnt
```

### 4. Common fixes

**Re-flash U-Boot to SPI** (if NVMe PCIe doesn't initialize — Pe812 = patched U-Boot with delay):

```bash
dd if=/home/rob/u-boot-pe812.bin of=/dev/mtdblock0 bs=4k && sync
```

**Rebuild kernel / ZFS DKMS:**

```bash
dpkg --configure -a
update-initramfs -u -k all
```

**Reinstall kernel:**

```bash
apt-get install --reinstall linux-image-$(uname -r)
```

**Fix ZFS pool auto-import:**

```bash
zpool import data
# Writes /etc/zfs/zpool.cache — pool auto-imports on subsequent boots
```

### 5. Exit and reboot

```bash
exit
umount -R /mnt
reboot
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `⚠ files missing` at startup | `files/<profile-id>/` doesn't exist or is empty | Create the directory and place boot files in it |
| No DHCP log entries | Cable not linked, or competing DHCP server won | Check physical link; ensure no other DHCP server is on the segment |
| DHCP seen but no TFTP | U-Boot didn't try TFTP, or wrong boot file path | Verify DHCP log shows the correct `bootFile` from the profile |
| TFTP serves file but no HTTP | `pxelinux.cfg/default` has stale URLs | Restart server — file is regenerated from the active profile at startup |
| `ABORT` in HTTP log | Client dropped the connection mid-download | Check cable quality; try a different NIC or switch port |
| SSH connection refused | Installer not ready yet | Wait 60–90 s after HTTP downloads finish, then retry |
| SSH password rejected | `preseed.cfg` not fetched | Check HTTP log for `GET /profiles/<id>/preseed.cfg` |
| iPXE loops (keeps re-downloading iPXE binary) | Option 60 iPXE detection not working | Check that DHCP log shows `iPXEClient` being detected and `.ipxe` URL served |
| Kernel panic on boot | Kernel/initrd version mismatch | Re-download a matching kernel + initrd pair |
| Port 67/69 permission denied | Not running as admin/root | Windows: run terminal as Administrator; Linux: `sudo npm start` |

---

## Using with MikroTik (external DHCP)

Answer **N** to the DHCP prompt and configure the router to point clients at this machine:

```routeros
# Set TFTP server and boot file for the LAN
/ip dhcp-server network set [find] \
  next-server=<this-machine-ip> \
  boot-file-name="pxelinux.cfg/default"

# Prevent MikroTik from answering the Rock5B's DHCP (if using built-in DHCP for other clients)
/ip dhcp-server lease add mac-address=BA:BD:81:07:BE:E4 blocked=yes
```

After rescue, revert:

```routeros
/ip dhcp-server network set [find] next-server="" boot-file-name=""
```
