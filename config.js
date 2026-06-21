module.exports = {
  // IP assigned to this machine on the rescue network interface
  serverIp:   '192.168.50.1',
  subnetMask: '255.255.255.0',

  // HTTP port for boot files
  httpPort:   8080,

  // IP pool for arch-matched clients (no fixed MAC assignment)
  // Assigned round-robin; persists for the lifetime of the process.
  archPool:   ['192.168.50.10', '192.168.50.11', '192.168.50.12'],
};
