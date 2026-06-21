module.exports = {
  serverIp:   '192.168.1.73',
  subnetMask: '255.255.255.0',
  gateway:    '192.168.1.1',

  // HTTP port for boot files
  httpPort:   8080,

  // IP pool for arch-matched clients (no fixed MAC assignment)
  // Assigned round-robin; persists for the lifetime of the process.
  archPool:   ['192.168.1.220', '192.168.1.221', '192.168.1.222'],
};
