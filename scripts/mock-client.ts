// A tiny stand-in for node-tlcv, for fast local iteration on the server.
//
// It does what node-tlcv's transport does: binds the broadcast port, sends
// LOGONv15, pings every 10s, ACKs every `<NNN>` message, and pretty-prints what
// it receives. To avoid the same-host bind clash (node-tlcv binds the same port
// it sends to), run the SERVER on one loopback address and this client on
// another — e.g. server --bind 127.0.0.1, client --bind 127.0.0.2.
//
//   tsx scripts/mock-client.ts --server 127.0.0.1 --port 16066 --bind 127.0.0.2

import { createSocket } from 'node:dgram';

interface Opts {
  server: string;
  port: number;
  bind: string;
  user: string;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { server: '127.0.0.1', port: 16066, bind: '127.0.0.2', user: 'tester' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') o.server = argv[++i];
    else if (a === '--port') o.port = parseInt(argv[++i], 10);
    else if (a === '--bind') o.bind = argv[++i];
    else if (a === '--user') o.user = argv[++i];
  }
  return o;
}

const opts = parseOpts(process.argv.slice(2));
const sock = createSocket('udp4');
let lastId: number | undefined;

const send = (msg: string) => sock.send(msg, opts.port, opts.server);

sock.on('listening', () => {
  console.log(`[mock] bound ${opts.bind}:${opts.port}, logging on to ${opts.server}:${opts.port} as "${opts.user}"`);
  send(`LOGONv15:${opts.user}`);
  send('RESULTTABLE');
  setInterval(() => send('PING'), 10000);
});

sock.on('message', (buf) => {
  const raw = buf.toString().trim();
  if (raw.startsWith('<')) {
    const idStr = raw.slice(1, raw.indexOf('>'));
    const id = parseInt(idStr, 10);
    send(`ACK: ${id}`);
    if (lastId !== undefined && id < lastId) {
      console.log(`[mock] !! out-of-order id ${id} (last ${lastId}) — node-tlcv would DROP this`);
    }
    lastId = id;
    console.log(`[mock] <${id}> ${raw.slice(raw.indexOf('>') + 1)}`);
  } else {
    console.log(`[mock]     ${raw}`);
  }
});

sock.on('error', (err) => {
  console.error(`[mock] socket error: ${err}`);
  process.exit(1);
});

sock.bind(opts.port, opts.bind);

process.on('SIGINT', () => {
  send('LOGOFF');
  setTimeout(() => process.exit(0), 100);
});
