# PXE Rescue Server — Rock5B

Self-contained Node.js PXE boot server for rescuing a Rock5B (RK3588, ARM64) when NVMe boot is broken. Runs on Windows or Linux. No external DHCP server, no MikroTik required — plug a cable directly from your laptop to the Rock5B and run `npm start`.

Serves DHCP (port 67), TFTP (port 69), and HTTP (port 8080) all from one process. Prompts you at startup to pick which NIC gets the rescue IP, and restores the original IP automatically when you exit.

---

## Repository layout

```
pxe/
├── bin/
│   ├── server.js          # Entry point — HTTP server + startup prompts
│   ├── dhcp-server.js     # DHCP — responds only to Rock5B MAC
│   ├── tftp-server.js     # TFTP — serves pxelinux.cfg/default to U-Boot
│   └── iface-manager.js   # NIC selection + IP assign/restore
├── config.js              # All configurable values (IPs, MAC, ports)
├── pxelinux.cfg/
│   └── default            # Auto-generated at startup from config.js
├── files/                 # Boot files — gitignored, place here manually
│   ├── linux              # Debian ARM64 netboot kernel (~36 MB)
│   ├── initrd.gz          # Debian ARM64 netboot initrd (~41 MB)
│   ├── grubaa64.efi       # GRUB EFI binary for ARM64
│   ├── preseed.cfg        # Debian preseed config (enables SSH console)
│   └── dtb/rockchip/
│       └── rk3588-rock-5b.dtb
└── package.json
```

---

## Prerequisites

- Node.js 18 or later
- Run as **Administrator** on Windows / **sudo** on Linux (ports 67 and 69 require elevated privileges)
- A direct Ethernet cable from your machine to the Rock5B, or both on the same switch with no other DHCP server on that segment

---

## Installation

```bash
git clone https://dev.netfusion.io/netfusion/pxe.git
cd pxe
npm install
```

Then place the boot files in `files/` — see [Boot files](#boot-files).

---

## Configuration

All values live in `config.js`. Edit this file before first run:

```js
module.exports = {
  serverIp:   '192.168.50.1',      // IP that will be assigned to your NIC
  rock5bMac:  'ba:bd:81:07:be:e4', // Rock5B Ethernet MAC (check armbianEnv or ifconfig)
  rock5bIp:   '192.168.50.2',      // IP the DHCP server offers to the Rock5B
  subnetMask: '255.255.255.0',
  bootFile:   'pxelinux.cfg/default',
  httpPort:   8080,
};
```

`pxelinux.cfg/default` is **regenerated at every startup** from these values — you never need to edit it manually.

---

## Starting the server

```bash
npm start
```

### Prompt 1 — DHCP

```
Start DHCP server? [y/N]:
```

- **Y** — enables the built-in DHCP server. The Rock5B will get its IP from this machine. You will then be asked to pick a NIC.
- **N** — skips DHCP and NIC management. Use this when your router (e.g. MikroTik) is already handling DHCP and you only need HTTP + TFTP from this machine.

### Prompt 2 — NIC selection (only shown if DHCP = Y)

```
Available interfaces:
  [1] Ethernet                          192.168.1.5
  [2] Ethernet 2                        no IPv4
  [3] Wi-Fi                             192.168.1.10
  [0] Skip — manage IP manually

Select interface:
```

Pick the NIC connected to the Rock5B. The server will:
1. Save the current IP configuration for that interface
2. Assign `serverIp` from `config.js` to it (e.g. `192.168.50.1`)
3. Restore the original configuration when you press Ctrl+C

If you pick **0**, no IP change is made — you are responsible for having `serverIp` already on that interface.

### Startup output

```
╔══════════════════════════════════════════════════════════╗
║          PXE HTTP Boot Server  —  Rock5B Rescue          ║
╠══════════════════════════════════════════════════════════╣
║  Server : http://192.168.50.1:8080                       ║
║  Serving: C:\Users\Rob\Code\pxe\files                    ║
╠══════════════════════════════════════════════════════════╣
║  linux  (36.1 MB)                                        ║
║  initrd.gz  (41.3 MB)                                    ║
║  preseed.cfg  (0.0 MB)                                   ║
╚══════════════════════════════════════════════════════════╝

[...] IFACE    Ethernet 2 → 192.168.50.1/24 assigned
[...] DHCP listening on 0.0.0.0:67 — ba:bd:81:07:be:e4 → 192.168.50.2
[...] TFTP listening on 0.0.0.0:69
[...] HTTP listening on 0.0.0.0:8080 — ready for PXE boot requests
```

### Shutdown

Press **Ctrl+C**. The server will restore the NIC's original IP before exiting:

```
[...] SIGINT received — shutting down...
[...] IFACE    Ethernet 2 → restored to DHCP
```

---

## Boot files

The `files/` directory is gitignored — download these once and place them there manually.

### Download from Debian

```bash
BASE=https://deb.debian.org/debian/dists/stable/main/installer-arm64/current/images/netboot/debian-installer/arm64

wget $BASE/linux        -O files/linux
wget $BASE/initrd.gz    -O files/initrd.gz
```

For GRUB EFI (needed by some U-Boot versions):
```bash
wget $BASE/../../../grub/grubaa64.efi -O files/grubaa64.efi
```

### DTB

The Rock5B DTB is included with Armbian. Copy it from a running system or from the SD card:

```bash
cp /boot/dtb/rockchip/rk3588-rock-5b.dtb files/dtb/rockchip/rk3588-rock-5b.dtb
```

### preseed.cfg

The included `preseed.cfg` configures the Debian installer to:
- Skip disk partitioning
- Start `network-console` (SSH access to the installer)
- Set the SSH password to `rescue123`

Edit it if you need a different password or locale.

---

## Boot flow

Once the Rock5B powers on with U-Boot on SPI:

```
Rock5B U-Boot (SPI)
  │
  ├─ DHCP request (broadcast) ──────────────────────────────────────────────┐
  │    ← DHCP offer: ip=192.168.50.2, next-server=192.168.50.1             │
  │       boot-file=pxelinux.cfg/default                                    │
  │                                                                          ▼
  ├─ TFTP GET pxelinux.cfg/default  (from 192.168.50.1:69)          [this server]
  │    ← file contains HTTP URLs for kernel, initrd, DTB
  │
  ├─ HTTP GET /linux        (from 192.168.50.1:8080)  ← ARM64 kernel
  ├─ HTTP GET /initrd.gz    (from 192.168.50.1:8080)  ← initrd
  ├─ HTTP GET /preseed.cfg  (from 192.168.50.1:8080)  ← installer config
  │
  └─ Debian installer boots, starts SSH on 192.168.50.2:22
```

The server log will show each request with size and speed:

```
[...] DHCP DISC  ba:bd:81:07:be:e4 → offering 192.168.50.2
[...] DHCP REQ   ba:bd:81:07:be:e4 → ACK 192.168.50.2
[...] TFTP GET   192.168.50.2 "pxelinux.cfg/default" (312 B, blksize=512, window=1)
[...] TFTP DONE  192.168.50.2 pxelinux.cfg/default | 312 B | 0.0s | ...
[...] REQUEST    192.168.50.2  GET /linux
[...] TFTP ...   192.168.50.2 linux | 45% | 5,242,880 B/s
[...] DONE       192.168.50.2  /linux | 200 | 36.1 MB | 12.4s | 2.91 MB/s
[...] REQUEST    192.168.50.2  GET /initrd.gz
[...] DONE       192.168.50.2  /initrd.gz | 200 | 41.3 MB | 14.1s | 2.93 MB/s
[...] REQUEST    192.168.50.2  GET /preseed.cfg
[...] DONE       192.168.50.2  /preseed.cfg | 200 | 0.0 MB | 0.0s | ?
```

The installer takes about **60–90 seconds** after the HTTP downloads finish to initialize and start the SSH server.

---

## Rescue procedure

### 1. SSH into the installer

```bash
ssh installer@192.168.50.2
# Password: rescue123
```

### 2. Open a shell

In the Debian installer text menu, navigate to:
**"Execute a shell"** → **Continue**

### 3. Mount the NVMe

```bash
lsblk
# Identify your partitions — typically:
#   nvme0n1p1 = EFI (vfat)
#   nvme0n1p2 = root (ext4 or btrfs)

mount /dev/nvme0n1p2 /mnt
mount /dev/nvme0n1p1 /mnt/boot/efi   # if EFI partition exists

# Bind mounts for chroot
mount --bind /dev  /mnt/dev
mount --bind /proc /mnt/proc
mount --bind /sys  /mnt/sys

chroot /mnt
```

### 4. Common fixes

**Re-flash U-Boot to SPI** (Rock5B specific — use if NVMe PCIe doesn't init at boot):

```bash
# Pe812 = custom U-Boot with NVMe PCIe delay patch
dd if=/home/rob/u-boot-pe812.bin of=/dev/mtdblock0 bs=4k
sync
```

**Rebuild broken kernel / ZFS DKMS:**

```bash
dpkg -l | grep linux-image
dpkg --configure -a
update-initramfs -u -k all
```

**Reinstall kernel:**

```bash
apt-get install --reinstall linux-image-$(uname -r)
```

**Fix ZFS pool after recovery:**

```bash
zpool import data
# Sets /etc/zfs/zpool.cache for auto-import on next boot
```

### 5. Exit and reboot

```bash
exit          # leave chroot
umount -R /mnt
reboot
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No DHCP log entries | Cable not linked, or another DHCP server replied first | Check physical link; verify `rock5bMac` in `config.js` |
| DHCP seen but no TFTP request | U-Boot didn't try TFTP, or wrong `boot-file` in DHCP options | Check DHCP log shows correct `bootFile` option |
| TFTP serves file but no HTTP | `pxelinux.cfg/default` has wrong `serverIp` | Restart server — file is regenerated at startup |
| `ABORT` in HTTP log | Rock5B dropped the connection mid-download | Usually a U-Boot HTTP timeout; try a shorter cable or different switch |
| SSH connection refused | Installer not ready yet | Wait 60–90 s after HTTP downloads finish, then retry |
| SSH password rejected | `preseed.cfg` wasn't fetched by installer | Check HTTP log for a `GET /preseed.cfg` line |
| Kernel panic at boot | Kernel/initrd mismatch in `files/` | Re-download matching kernel + initrd pair |
| Port 67/69 permission denied | Not running as admin/root | Windows: run terminal as Administrator; Linux: use `sudo` |

---

## Using with MikroTik instead of built-in DHCP

If you want the MikroTik to handle DHCP and PXE options, answer **N** to the DHCP prompt and configure the router:

```routeros
# Point DHCP clients to this machine for TFTP + boot file
/ip dhcp-server network set [find] \
  next-server=<this-machine-ip> \
  boot-file-name="pxelinux.cfg/default"

# Optional: block MikroTik from assigning a lease to Rock5B
# (so only your built-in DHCP responds to it)
/ip dhcp-server lease add \
  mac-address=BA:BD:81:07:BE:E4 \
  blocked=yes
```

After rescue, revert the boot file:

```routeros
/ip dhcp-server network set [find] next-server="" boot-file-name=""
```
