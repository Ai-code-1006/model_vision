const { spawn } = require('node:child_process');
const path = require('node:path');

const proxyPath = path.join(__dirname, 'proxy.js');
const child = spawn(process.execPath, [proxyPath], {
  cwd: __dirname,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.unref();
