# Rock5B PXE HTTP Boot Server

Boots a Rock5B (RK3588, ARM64) into Debian installer rescue mode with SSH access, so you can fix the NVMe boot partition remotely.

## Network layout

| Host | IP | Role |
|------|----|------|
| MikroTik CRS309 | 192.168.1.1 | DHCP + TFTP server, routes LAN ↔ WireGuard |
| Rock5B | 192.168.1.6 | target (MAC `BA:BD:81:07:BE:E4`) |
| Windows (this machine) | 192.168.4.6 | HTTP boot server (WireGuard) |

## Boot flow

```
Rock5B U-Boot (SPI)
  → DHCP → 192.168.1.6
  → TFTP 192.168.1.1 → pxelinux.cfg/default
  → HTTP 192.168.4.6:8080 → linux (kernel, 35 MB)
  → HTTP 192.168.4.6:8080 → initrd.gz (40 MB)
  → HTTP 192.168.4.6:8080 → preseed.cfg
  → Debian installer network-console → SSH on 192.168.1.6:22
  → Fix NVMe → reboot normally
```

---

## Step 1 — Start the HTTP server (Windows)

```powershell
cd C:\Users\Rob\Code\pxe
npm start
```

You should see the startup banner listing `linux`, `initrd.gz`, and `preseed.cfg`.  
Leave this running while the Rock5B boots.

---

## Step 2 — Upload pxelinux.cfg to MikroTik

From a bash/PowerShell terminal on Windows (requires SSH access to MikroTik):

```bash
scp pxelinux.cfg/default admin@192.168.1.1:/pxelinux.cfg/default
```

Or use Winbox → Files → drag `pxelinux.cfg/default` to the router filesystem under a `pxelinux.cfg/` folder.

Verify it's there in RouterOS terminal:
```routeros
/file print where name~"pxelinux"
```

---

## Step 3 — Configure MikroTik DHCP

### 3a. Static lease for Rock5B

```routeros
/ip dhcp-server lease add \
  mac-address=BA:BD:81:07:BE:E4 \
  address=192.168.1.6 \
  comment="Rock5B rescue"
```

### 3b. Set PXE boot file

This tells U-Boot to fetch `pxelinux.cfg/default` from MikroTik's TFTP:

```routeros
/ip dhcp-server network set [find address=192.168.1.0/24] \
  next-server=192.168.1.1 \
  boot-file-name="pxelinux.cfg/default"
```

> **Note:** This affects all clients on the LAN. Revert after rescue (Step 7).

---

## Step 4 — Check firewall (if Rock5B can't reach 192.168.4.6)

MikroTik should already route LAN → WireGuard. If HTTP downloads time out, add:

```routeros
/ip firewall filter add \
  chain=forward \
  src-address=192.168.1.0/24 \
  dst-address=192.168.4.6 \
  action=accept \
  place-before=0 \
  comment="Rock5B → PXE HTTP server"
```

---

## Step 5 — Boot Rock5B

Power on (or reset) the Rock5B. Watch the server console on Windows — you should see:

```
[2026-06-17T...] REQUEST  192.168.1.6  GET /linux
[2026-06-17T...] DONE     192.168.1.6  /linux | 200 | 35.9 MB | 12.3s | 2.92 MB/s
[2026-06-17T...] REQUEST  192.168.1.6  GET /initrd.gz
[2026-06-17T...] DONE     192.168.1.6  /initrd.gz | 200 | 40.3 MB | 14.1s | 2.86 MB/s
[2026-06-17T...] REQUEST  192.168.1.6  GET /preseed.cfg
[2026-06-17T...] DONE     192.168.1.6  /preseed.cfg | 200 | 0.0 MB | 0.0s | ? MB/s
```

The installer will take ~60–90 seconds to initialize and start the SSH server.

---

## Step 6 — SSH into the installer

```bash
ssh installer@192.168.1.6
# Password: rescue123
```

You'll get the Debian installer text menu over SSH.

### Fix the NVMe boot partition

```bash
# In the installer menu, choose: "Execute a shell"

# Find partitions
lsblk
# Typically: nvme0n1p1 = EFI, nvme0n1p2 = /boot or /, etc.

# Mount root filesystem
mount /dev/nvme0n1p2 /mnt

# Mount EFI partition (if exists)
mount /dev/nvme0n1p1 /mnt/boot/efi

# Bind mounts for chroot
mount --bind /dev /mnt/dev
mount --bind /proc /mnt/proc
mount --bind /sys /mnt/sys

# Enter chroot
chroot /mnt

# --- Common fixes ---

# Reinstall the bad kernel (check what's installed):
dpkg -l | grep linux-image
apt-get install --reinstall linux-image-<version>-arm64

# Rebuild initramfs:
update-initramfs -u -k all

# Reinstall GRUB (EFI):
grub-install --target=arm64-efi --efi-directory=/boot/efi --recheck
update-grub

# Check/fix fstab:
cat /etc/fstab
# Make sure NVMe UUIDs match:  blkid /dev/nvme0n1p1 /dev/nvme0n1p2

# Exit chroot
exit
umount -R /mnt
```

---

## Step 7 — Revert MikroTik DHCP

After the Rock5B boots normally from NVMe, restore the original DHCP boot file:

```routeros
/ip dhcp-server network set [find address=192.168.1.0/24] \
  boot-file-name="netboot.xyz-arm64.efi"
```

Or clear it entirely if you don't need PXE for other clients:

```routeros
/ip dhcp-server network set [find address=192.168.1.0/24] \
  next-server="" boot-file-name=""
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No HTTP requests in server log | U-Boot didn't find pxelinux.cfg — verify MikroTik TFTP has the file and DHCP option 67 is set |
| `ABORT` in server log | Rock5B dropped the connection — usually a U-Boot HTTP timeout; check network stability |
| SSH connection refused | Installer hasn't finished loading network-console yet — wait 60–90 s and retry |
| SSH password rejected | Preseed wasn't fetched; check server log for `/preseed.cfg` request |
| Kernel panic on boot | Kernel/initrd mismatch — re-download matching pair from `https://deb.debian.org/debian/dists/stable/main/installer-arm64/current/images/netboot/debian-installer/arm64/` |
