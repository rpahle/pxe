module.exports = {
  // IP of this machine on the rescue network interface
  serverIp:   '192.168.50.1',

  // Rock5B identity
  rock5bMac:  'ba:bd:81:07:be:e4',
  rock5bIp:   '192.168.50.2',
  subnetMask: '255.255.255.0',

  // PXE boot file served via TFTP (first file U-Boot downloads)
  bootFile:   'pxelinux.cfg/default',

  // HTTP port for boot files
  httpPort:   8080,
};
