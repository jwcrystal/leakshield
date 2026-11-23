const net = require('node:net');
const fs = require('node:fs');
const log = process.env.NET_LOG || '/tmp/net.log';
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  try {
    let opts = args[0];
    let port, host;
    if (Array.isArray(opts)) opts = opts[0];
    if (typeof opts === 'object' && opts) { port = opts.port; host = opts.host; }
    else if (typeof opts === 'number') { port = opts; host = (typeof args[1] === 'string') ? args[1] : undefined; }
    fs.appendFileSync(log, JSON.stringify({ port, host, stack: new Error().stack.split('\n').slice(2,5).join(' | ') }) + '\n');
  } catch {}
  return origConnect.apply(this, args);
};
