# PXE Boot Server — Multi-Profile

Self-contained Node.js PXE boot server. Serves DHCP (port 67), ProxyDHCP (port 4011), TFTP (port 69), and HTTP (port 8080) from one process. Supports multiple OS and architecture targets simultaneously via a profile system — adding a new boot target requires no code changes, just a new folder.

Primary use case: rescuing a Rock5B (RK3588, ARM64) when NVMe boot is broken. Also supports x86/x86_64 netboot, ISO booting via iPXE, and netboot.xyz for interactive OS selection.

Runs on Windows or Linux. Direct-cable connection supported — prompts you to pick a NIC, assigns the rescue IP, and restores the original IP on exit.

---

## Repository layout

```
pxe/
├── bin/
│   ├── server.js            # Entry point — HTTP server + startup prompts
│   ├── dhcp-server.js       # DHCP (port 67) + ProxyDHCP (port 4011)
│   ├── tftp-server.js       # TFTP — serves boot files from project root
│   ├── iface-manager.js     # NIC selection + IP assign/restore (Windows + Linux)
│   └── profile-manager.js   # Profile loading, config generation, DHCP table building
├── config.js                # Server IP, gateway, port, subnet, arch IP pool
├── profiles/                # Tracked in git — one folder per boot target
│   ├── debian-rescue-arm64/
│   │   ├── profile.json     # Boot config, metadata, file paths
│   │   └── preseed.cfg      # Debian installer config (SSH console, password)
│   ├── alpine-rescue-arm64/
│   │   └── profile.json     # Alpine 3.24 HTTP netboot for any UEFI ARM64 machine
│   ├── alpine-rock5b/
│   │   └── profile.json     # Alpine 3.24 for Rock5B via U-Boot — SSH auto-enabled
│   ├── sysrescue-x86_64/
│   │   └── profile.json     # SystemRescue 13 HTTP netboot for x86_64 EFI
│   ├── netbootxyz-bios/
│   │   └── profile.json     # netboot.xyz for legacy BIOS/x86 clients
│   ├── netbootxyz-uefi/
│   │   └── profile.json     # netboot.xyz for UEFI x86_64 clients
│   └── netbootxyz-arm64/
│       └── profile.json     # netboot.xyz for UEFI ARM64 clients
├── files/                   # Boot assets — gitignored, place manually
│   ├── shared/
│   │   ├── ipxe/
│   │   │   ├── ipxe.efi           # x86_64 EFI iPXE binary (~1.1 MB)
│   │   │   ├── ipxe-arm64.efi     # ARM64 EFI iPXE binary (~1.1 MB)
│   │   │   └── undionly.kpxe      # x86 BIOS iPXE binary (~70 KB)
│   │   └── netboot.xyz/
│   │       ├── netboot.xyz.kpxe       # netboot.xyz BIOS binary
│   │       ├── netboot.xyz.efi        # netboot.xyz UEFI x86_64 binary
│   │       └── netboot.xyz-arm64.efi  # netboot.xyz UEFI ARM64 binary
│   ├── debian-rescue-arm64/
│   │   ├── linux                # ARM64 netboot kernel (~36 MB)
│   │   ├── initrd.gz            # ARM64 netboot initrd (~41 MB)
│   │   ├── grubaa64.efi         # GRUB EFI binary for ARM64
│   │   └── dtb/rockchip/rk3588-rock-5b.dtb
│   ├── alpine-rock5b/           # Rock5B-specific apkovl (used by alpine-rock5b profile)
│   │   └── apkovl.tar.gz        # Boot overlay: installs openssh, sets root password
│   ├── alpine-rescue-arm64/     # Alpine 3.24 ARM64 netboot files (~290 MB total, shared)
│   │   ├── vmlinuz-lts          # Kernel (~12 MB)
│   │   ├── initramfs-lts        # Initramfs (~27 MB)
│   │   ├── modloop-lts          # Kernel modules (~252 MB)
│   │   ├── apkovl.tar.gz        # Boot overlay: installs openssh from local packages
│   │   ├── dtb/rockchip/rk3588-rock-5b.dtb
│   │   └── apk/v3.24/main/aarch64/
│   │       ├── APKINDEX.tar.gz  # Alpine package index
│   │       └── openssh-*.apk    # openssh and deps — no CDN needed at boot
│   └── sysrescue-x86_64/        # SystemRescue 13 netboot files (~1.3 GB total)
│       └── sysresccd/
│           ├── boot/
│           │   ├── intel_ucode.img    # Intel CPU microcode (~14 MB)
│           │   ├── amd_ucode.img      # AMD CPU microcode (~0.3 MB)
│           │   └── x86_64/
│           │       ├── vmlinuz        # Kernel (~16 MB)
│           │       └── sysresccd.img  # Initramfs (~175 MB)
│           └── x86_64/
│               ├── airootfs.sfs       # Squashfs root filesystem (~1.08 GB)
│               └── airootfs.sha512
└── pxelinux.cfg/
    └── default                  # Auto-generated at startup from active profile
```

---

## Prerequisites

- Node.js 18 or later
- Run as **Administrator** on Windows / **sudo** on Linux (ports 67 and 69 require elevated privileges)
- Ethernet connection to the target machine (direct cable or same switch segment)

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
  serverIp:   '192.168.1.73',  // IP this machine has on the rescue network
  subnetMask: '255.255.255.0',
  gateway:    '192.168.1.1',   // Router IP sent to clients via DHCP option 3

  httpPort:   8080,

  // IPs offered to arch-matched clients (no fixed MAC).
  // Assigned round-robin; persist for the lifetime of the process.
  archPool:   ['192.168.1.220', '192.168.1.221', '192.168.1.222'],
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
  [2] alpine-rock5b          Alpine Linux 3.24 — Rock5B
                             Lightweight live rescue for Rock5B via U-Boot PXE. SSH enabled at boot.
                             arch: arm64 | method: pxelinux | MAC: ba:bd:81:07:be:e4
                             ssh: root / rescue123
  [3] alpine-rescue-arm64    Alpine Linux 3.24 — ARM64
                             Minimal live rescue environment for any UEFI ARM64 machine.
                             arch: arm64 | method: ipxe | any arm64 client
  [4] sysrescue-x86_64       SystemRescue 13 — x86_64
                             Full rescue toolkit: ZFS, disk repair, filesystem tools, SSH server.
                             arch: x86_64 | method: ipxe | any x86_64 client
                             ssh: root / rescue123
  [5] netbootxyz-bios        netboot.xyz — BIOS
                             netboot.xyz interactive boot menu for legacy BIOS/PXE clients.
                             arch: x86 | method: direct | any x86 client
  [6] netbootxyz-uefi        netboot.xyz — UEFI x86_64
                             netboot.xyz interactive boot menu for UEFI x86_64 clients.
                             arch: x86_64 | method: direct | MAC: 68:f7:28:b2:8f:29
  [7] netbootxyz-arm64       netboot.xyz — UEFI ARM64
                             netboot.xyz interactive boot menu for UEFI ARM64 clients.
                             arch: arm64 | method: direct | any arm64 client
  [0] All profiles
```

Enter a number, comma-separated numbers (e.g. `1,2`), `0` for all, or press Enter for the default (first profile). Active profiles determine which clients get DHCP responses and which boot files are served.

Only one profile can be active per arch in the arch table — if two arch-matched profiles share the same arch (e.g. `sysrescue-x86_64` and `netbootxyz-uefi` both use `x86_64`), the last one selected wins for that arch. MAC-pinned profiles always take priority and don't conflict.

### Prompt 2 — DHCP

```
Start DHCP server? [y/N]:
```

- **Y** — starts the built-in DHCP server (port 67) and ProxyDHCP server (port 4011). Clients get their IP from this machine. You'll then be asked to pick a NIC.
- **N** — skips DHCP and NIC management. Use this when your router handles DHCP and you only need HTTP + TFTP.

### Prompt 3 — NIC selection (only if DHCP = Y)

Pick the NIC connected to the target. The server saves the current IP config, assigns `serverIp` from `config.js`, and restores the original on Ctrl+C. Pick `0` to skip — useful if the IP is already set.

### Shutdown

Press **Ctrl+C**. The NIC IP is restored before exit.

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
| `bootMethod` | `pxelinux`, `ipxe`, `ipxe-iso`, or `direct` — drives which config is generated. |
| `mac` | Single MAC for MAC-matched routing. `null` for arch-detected clients. |
| `macs` | Array of `{mac, assignedIp}` (or `{mac, assignedIp, bootFileByArch}`) objects — use instead of `mac`/`assignedIp` to pin multiple machines to one profile. |
| `assignedIp` | Static IP offered to a single `mac`. `null` for arch clients (uses `archPool`). |
| `bootFile` | Default TFTP boot file (DHCP option 67). Used when `bootFileByArch` is absent. |
| `bootFileByArch` | Per-entry map of arch string → boot file. When set on a `macs` entry, the server reads the client's arch from DHCP option 60 and picks the matching file automatically — useful when you don't know if a machine is BIOS or UEFI. Keys: `x86`, `x86_64`, `arm64`. |
| `filesDir` | Override for which `files/` subdirectory to check for boot assets. Defaults to `id`. |
| `pxelinux` | Boot config block for `bootMethod: "pxelinux"`. |
| `grub` | GRUB config block — served dynamically at `/profiles/<id>/grub.cfg`. |
| `ipxe` | iPXE config block for `bootMethod: "ipxe"` or `"ipxe-iso"`. |

Template tokens `{serverIp}` and `{httpPort}` in any string value are expanded at startup from `config.js`.

### Boot methods

**`pxelinux`** — Used by U-Boot on ARM boards. DHCP sends `pxelinux.cfg/default` as the boot file. U-Boot fetches it via TFTP; the file contains HTTP URLs for kernel, initrd, DTB, and kernel args.

**`ipxe`** — DHCP sends an iPXE binary (`ipxe.efi` or `undionly.kpxe`) as the boot file. The client fetches it via TFTP, then makes a second DHCP request identified as `iPXEClient`. The server responds with `/profiles/<id>/boot.ipxe` as the boot file. iPXE fetches that script over HTTP and boots kernel + initrd.

**`ipxe-iso`** — Same iPXE chainload as above, but the generated script uses `sanboot <iso-url>` to boot an ISO file served directly over HTTP.

**`direct`** — DHCP serves `bootFile` directly via TFTP. The file is a self-contained bootloader (e.g. netboot.xyz). No iPXE script is generated. Used by the netboot.xyz profiles.

### DHCP routing

The DHCP server uses two-tier routing:

1. **MAC match** — if the client's MAC matches any entry in a profile's `mac` or `macs` fields, that profile is used and the client gets its `assignedIp`. Highest priority. If the entry has `bootFileByArch`, the boot file is selected based on the client's reported arch (DHCP option 60).

2. **Arch fallback** — if no MAC matches, the server reads DHCP option 60 (vendor class identifier). PXE clients send `PXEClient:Arch:NNNNN` where `NNNNN` is:
   - `00000` → x86 BIOS
   - `00007` → x86_64 EFI
   - `00011` → ARM64 EFI

   The server picks the active profile matching that arch and assigns an IP from `archPool`.

3. **iPXE loop prevention** — when an iPXE binary re-requests DHCP (option 60 = `iPXEClient:...`), the server serves the `.ipxe` script URL instead of the binary, preventing an infinite boot loop.

4. **ProxyDHCP (port 4011)** — when DHCP is enabled, a ProxyDHCP server also starts on port 4011. Some BIOS PXE ROMs get their IP from the network router and then separately query port 4011 for the boot file. ProxyDHCP responds with just the boot file (no IP assignment), covering this case alongside the regular DHCP server on port 67.

Unknown clients (no MAC match, no recognized arch) are silently ignored.

---

## Boot files

The `files/` directory is gitignored. Download once and place manually.

### netboot.xyz

Download from [netboot.xyz](https://netboot.xyz/downloads/):

```bash
mkdir -p files/shared/netboot.xyz

wget https://boot.netboot.xyz/ipxe/netboot.xyz.kpxe       -O files/shared/netboot.xyz/netboot.xyz.kpxe
wget https://boot.netboot.xyz/ipxe/netboot.xyz.efi         -O files/shared/netboot.xyz/netboot.xyz.efi
wget https://boot.netboot.xyz/ipxe/netboot.xyz-arm64.efi   -O files/shared/netboot.xyz/netboot.xyz-arm64.efi
```

### ARM64 (Rock5B rescue)

```bash
BASE=https://deb.debian.org/debian/dists/stable/main/installer-arm64/current/images/netboot/debian-installer/arm64

mkdir -p files/debian-rescue-arm64/dtb/rockchip

wget $BASE/linux     -O files/debian-rescue-arm64/linux
wget $BASE/initrd.gz -O files/debian-rescue-arm64/initrd.gz

wget https://deb.debian.org/debian/dists/stable/main/installer-arm64/current/images/netboot/grubaa64.efi \
     -O files/debian-rescue-arm64/grubaa64.efi

# DTB — copy from a running Rock5B or Armbian SD card
cp /boot/dtb/rockchip/rk3588-rock-5b.dtb files/debian-rescue-arm64/dtb/rockchip/
```

### x86 / x86_64 (iPXE profiles)

```bash
mkdir -p files/shared/ipxe

wget https://boot.ipxe.org/x86_64-efi/ipxe.efi  -O files/shared/ipxe/ipxe.efi
wget https://boot.ipxe.org/undionly.kpxe          -O files/shared/ipxe/undionly.kpxe
wget https://boot.ipxe.org/arm64-efi/ipxe.efi     -O files/shared/ipxe/ipxe-arm64.efi
```

---

## Adding a new profile

1. Create `profiles/<id>/profile.json` — copy an example below and edit it.
2. Place boot assets in `files/<id>/`.
3. Restart the server — the new profile appears in the selection list automatically.

No code changes required.

---

### Example 1 — netboot.xyz, arch-detected (direct)

The three netboot.xyz profiles are already in the repo. They use `bootMethod: "direct"` — DHCP serves the binary straight via TFTP and netboot.xyz presents its own interactive menu.

To pin a specific machine to netboot.xyz while auto-detecting whether it's BIOS or UEFI, add a `macs` entry with `bootFileByArch`:

```json
{
  "id": "netbootxyz-uefi",
  "name": "netboot.xyz — UEFI x86_64",
  "description": "netboot.xyz interactive boot menu for UEFI x86_64 clients.",
  "arch": "x86_64",
  "bootMethod": "direct",
  "mac": null,
  "assignedIp": null,
  "macs": [
    {
      "mac": "68:f7:28:b2:8f:29",
      "assignedIp": "192.168.1.9",
      "bootFileByArch": {
        "x86":    "files/shared/netboot.xyz/netboot.xyz.kpxe",
        "x86_64": "files/shared/netboot.xyz/netboot.xyz.efi"
      }
    }
  ],
  "bootFile": "files/shared/netboot.xyz/netboot.xyz.efi",
  "filesDir": "shared/netboot.xyz"
}
```

The server reads the client's arch from DHCP option 60 at request time and serves the correct binary automatically.

---

### Example 2 — Debian installer, x86_64, any EFI machine (iPXE)

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

---

### Example 3 — Alpine Linux 3.24, ARM64 UEFI (HTTP netboot) ← included

**`profiles/alpine-rescue-arm64/profile.json`** (already in repo):
```json
{
  "id": "alpine-rescue-arm64",
  "name": "Alpine Linux 3.24 — ARM64",
  "description": "Minimal live rescue environment for any UEFI ARM64 machine.",
  "arch": "arm64",
  "bootMethod": "ipxe",
  "mac": null,
  "assignedIp": null,
  "bootFile": "files/shared/ipxe/ipxe-arm64.efi",
  "ssh": "root / rescue123",
  "ipxe": {
    "kernel": "http://{serverIp}:{httpPort}/files/alpine-rescue-arm64/vmlinuz-lts",
    "initrd": "http://{serverIp}:{httpPort}/files/alpine-rescue-arm64/initramfs-lts",
    "append": "ip=dhcp modloop=http://{serverIp}:{httpPort}/files/alpine-rescue-arm64/modloop-lts apkovl=http://{serverIp}:{httpPort}/files/alpine-rescue-arm64/apkovl.tar.gz console=tty0"
  }
}
```

**Boot files:**
```bash
BASE=https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/netboot
mkdir -p files/alpine-rescue-arm64/apk/v3.24/main/aarch64

wget $BASE/vmlinuz-lts    -O files/alpine-rescue-arm64/vmlinuz-lts
wget $BASE/initramfs-lts  -O files/alpine-rescue-arm64/initramfs-lts
wget $BASE/modloop-lts    -O files/alpine-rescue-arm64/modloop-lts

REPO=https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64
APK_DST=files/alpine-rescue-arm64/apk/v3.24/main/aarch64
wget $REPO/APKINDEX.tar.gz -O $APK_DST/APKINDEX.tar.gz

for pkg in libcrypto3 openssh openssh-client-common openssh-client-default \
           openssh-keygen openssh-server openssh-server-common openssh-sftp-server; do
  VER=$(tar -xOf $APK_DST/APKINDEX.tar.gz APKINDEX | awk "/^P:$pkg$/{found=1} found && /^V:/{print substr(\$0,3); exit}")
  wget $REPO/${pkg}-${VER}.apk -O $APK_DST/${pkg}-${VER}.apk
done
```

---

### Example 4 — SystemRescue 13, x86_64 EFI (HTTP netboot) ← included

**`profiles/sysrescue-x86_64/profile.json`** (already in repo):
```json
{
  "id": "sysrescue-x86_64",
  "name": "SystemRescue 13 — x86_64",
  "description": "Full rescue toolkit: ZFS, disk repair, filesystem tools, SSH server.",
  "arch": "x86_64",
  "bootMethod": "ipxe",
  "mac": null,
  "assignedIp": null,
  "bootFile": "files/shared/ipxe/ipxe.efi",
  "ipxe": {
    "kernel": "http://{serverIp}:{httpPort}/files/sysrescue-x86_64/sysresccd/boot/x86_64/vmlinuz",
    "initrd": [
      "http://{serverIp}:{httpPort}/files/sysrescue-x86_64/sysresccd/boot/intel_ucode.img",
      "http://{serverIp}:{httpPort}/files/sysrescue-x86_64/sysresccd/boot/amd_ucode.img",
      "http://{serverIp}:{httpPort}/files/sysrescue-x86_64/sysresccd/boot/x86_64/sysresccd.img"
    ],
    "append": "archisobasedir=sysresccd archiso_http_srv=http://{serverIp}:{httpPort}/files/sysrescue-x86_64/ ip=dhcp rootpass=rescue123"
  }
}
```

**Boot files** — extract from ISO on Linux:
```bash
VER=13.01
ISO=systemrescue-${VER}-amd64.iso
wget "https://fastly-cdn.system-rescue.org/releases/${VER}/${ISO}"

TMP=$(mktemp -d) && mount -o loop,ro "$ISO" "$TMP"
mkdir -p files/sysrescue-x86_64/sysresccd/{boot/x86_64,x86_64}
cp "$TMP/sysresccd/boot/x86_64/vmlinuz"       files/sysrescue-x86_64/sysresccd/boot/x86_64/vmlinuz
cp "$TMP/sysresccd/boot/x86_64/sysresccd.img" files/sysrescue-x86_64/sysresccd/boot/x86_64/sysresccd.img
cp "$TMP/sysresccd/boot/intel_ucode.img"       files/sysrescue-x86_64/sysresccd/boot/intel_ucode.img
cp "$TMP/sysresccd/boot/amd_ucode.img"         files/sysrescue-x86_64/sysresccd/boot/amd_ucode.img
cp "$TMP/sysresccd/x86_64/airootfs.sfs"        files/sysrescue-x86_64/sysresccd/x86_64/airootfs.sfs
cp "$TMP/sysresccd/x86_64/airootfs.sha512"     files/sysrescue-x86_64/sysresccd/x86_64/airootfs.sha512
umount "$TMP" && rm "$ISO"
```

SSH credentials: `root / rescue123` (set via `rootpass=` in the `append` field).

---

## Boot flow — ARM64 (pxelinux)

```
Rock5B U-Boot (SPI)
  │
  ├─ DHCP DISCOVER ──────────────────────────────────────────────────────┐
  │    ← OFFER: ip=192.168.1.2, server=192.168.1.73                     │
  │       boot-file=pxelinux.cfg/default                         [this server]
  │
  ├─ TFTP GET pxelinux.cfg/default
  │    ← contains HTTP URLs for kernel, initrd, DTB
  │
  ├─ HTTP GET /files/debian-rescue-arm64/linux        ← ARM64 kernel
  ├─ HTTP GET /files/debian-rescue-arm64/initrd.gz    ← initrd
  ├─ HTTP GET /profiles/debian-rescue-arm64/preseed.cfg
  │
  └─ Debian installer boots → SSH on 192.168.1.2:22
```

## Boot flow — x86 iPXE chainload

```
x86 client (BIOS/EFI)
  │
  ├─ DHCP DISCOVER (option 60 = "PXEClient:Arch:00007")
  │    ← OFFER: ip=192.168.1.220, boot-file=files/shared/ipxe/ipxe.efi
  │
  ├─ TFTP GET files/shared/ipxe/ipxe.efi       ← iPXE binary
  │
  ├─ iPXE DHCP DISCOVER (option 60 = "iPXEClient:...")
  │    ← OFFER: boot-file=http://192.168.1.73:8080/profiles/<id>/boot.ipxe
  │
  ├─ HTTP GET /profiles/<id>/boot.ipxe         ← iPXE script
  │
  ├─ HTTP GET /files/<id>/linux                ← kernel  (ipxe method)
  ├─ HTTP GET /files/<id>/initrd.gz            ← initrd  (ipxe method)
  │    — or —
  └─ HTTP GET /files/<id>/<name>.iso           ← ISO     (ipxe-iso sanboot)
```

## Boot flow — netboot.xyz (direct)

```
x86 client (BIOS or UEFI)
  │
  ├─ DHCP DISCOVER (option 60 = "PXEClient:Arch:NNNNN")
  │    ← OFFER: ip=192.168.1.9, boot-file=files/shared/netboot.xyz/netboot.xyz.kpxe
  │       (boot file chosen automatically from bootFileByArch based on arch code)
  │
  ├─ TFTP GET files/shared/netboot.xyz/netboot.xyz.kpxe
  │
  └─ netboot.xyz menu — pick any OS to boot from the internet
```

---

## Rock5B rescue procedure

### 1. SSH into the installer

```bash
ssh installer@192.168.1.2
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

**Re-flash U-Boot to SPI:**
```bash
dd if=/home/rob/u-boot-pe812.bin of=/dev/mtdblock0 bs=4k && sync
```

**Rebuild kernel / ZFS DKMS:**
```bash
dpkg --configure -a
update-initramfs -u -k all
```

**Fix ZFS pool auto-import:**
```bash
zpool import data
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
| `⚠ files missing` at startup | `files/<profile-id>/` doesn't exist | Create the directory and place boot files in it |
| No DHCP log entries | Cable not linked, or no matching profile | Check physical link; verify a profile is active for this client's arch or MAC |
| DHCP DISC loop — no REQ | Client receiving OFFER but rejecting it | See MikroTik section — a blocked DHCP lease sends NAK and wins over your OFFER |
| DHCP DISC loop — no REQ (no MikroTik) | Old BIOS PXE ROM strict about option 43 | Already handled; if still failing, capture with Wireshark and check packet content |
| DHCP seen but no TFTP | Wrong boot file path in profile | Verify DHCP log shows the correct `bootFile`; check file exists in `files/` |
| TFTP serves file but no HTTP | `pxelinux.cfg/default` has stale URLs | Restart server — file is regenerated at startup |
| `ABORT` in HTTP log | Client dropped connection mid-download | Check cable quality; try different switch port |
| SSH connection refused | Installer/OS not ready yet | Wait 60–90 s after HTTP downloads finish, then retry |
| iPXE loops (keeps re-downloading binary) | iPXE re-request not detected | Check DHCP log shows `iPXEClient` being detected and `.ipxe` URL served |
| Port 67/69 permission denied | Not running as admin/root | Windows: run terminal as Administrator; Linux: `sudo npm start` |
| netboot.xyz: "no DHCP offers received" | Another DHCP server on network sending NAK | See MikroTik section below |

---

## Using with MikroTik

### Option A — let MikroTik handle DHCP, this server does TFTP + HTTP only

Answer **N** to the DHCP prompt and configure MikroTik to point clients at this machine:

```routeros
/ip dhcp-server network set [find] \
  next-server=192.168.1.73 \
  boot-file-name="pxelinux.cfg/default"
```

After rescue, revert:
```routeros
/ip dhcp-server network set [find] next-server="" boot-file-name=""
```

### Option B — this server handles DHCP for specific clients (recommended)

Answer **Y** to the DHCP prompt. This server handles DHCP only for clients whose MAC or arch matches an active profile. All other clients continue to get DHCP from MikroTik normally.

**Critical: use a firewall filter, not a blocked lease**

To prevent MikroTik from responding to a client you want this server to handle, you must **drop the DHCP request in MikroTik's firewall** — do NOT use a blocked DHCP lease.

**Why blocked leases are wrong:** MikroTik's `blocked=yes` DHCP lease does not mean "ignore this client." It means "actively send DHCPNAK to this client." The NAK arrives alongside your server's OFFER, and the NAK wins — the client resets and retries DISCOVER forever, never getting an IP from either server.

**Correct approach — drop in firewall so MikroTik is silent:**

```routeros
# Remove any blocked lease for this MAC first
/ip dhcp-server lease remove [find mac-address="68:F7:28:B2:8F:29"]

# Drop DHCP requests from this MAC before MikroTik's DHCP server sees them
/ip firewall filter add \
  chain=input action=drop protocol=udp dst-port=67 \
  src-mac-address=68:F7:28:B2:8F:29 \
  comment="PXE client — handled by external PXE server"
```

This drops the packet on MikroTik's input chain (so its DHCP server never processes it and never responds), while your PXE server independently receives the same broadcast and responds normally.

To revert:
```routeros
/ip firewall filter remove [find comment="PXE client — handled by external PXE server"]
```

**Check for blocked leases** if you see a DISCOVER loop with no REQUEST:
```routeros
/ip dhcp-server lease print where mac-address="68:F7:28:B2:8F:29"
```
A `B` flag in the output means MikroTik is sending NAK. Remove it and add the firewall rule above.
