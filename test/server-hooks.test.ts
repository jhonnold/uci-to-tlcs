import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { TlcsServer } from '../src/tlcs/server.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('onAcked fires with critical for the result only, never for control items; onClientsChanged and currentEpoch', async () => {
  const acked: Array<[string, number, boolean]> = [];
  let changed = 0;
  const server = new TlcsServer({
    port: 0, bindAddr: '127.0.0.1',
    onAcked: (d, e, c) => void acked.push([d, e, c]),
    onClientsChanged: () => void changed++,
  });
  await new Promise<void>((r) => server.start(r));
  const sock = createSocket('udp4');
  await new Promise<void>((r) => { sock.once('listening', () => r()); sock.bind(0, '127.0.0.1'); });
  sock.on('message', (b) => {
    const m = /^<(\d+)>/.exec(b.toString());
    if (m) sock.send(`ACK: ${m[1]}`, server.address().port, '127.0.0.1');
  });
  const dest = `127.0.0.1:${sock.address().port}`;
  server.addClient('127.0.0.1', sock.address().port, 'c');
  assert.equal(changed, 1);
  assert.equal(server.currentEpoch(), 0);
  server.setPlayers('W', 'B');
  assert.equal(server.currentEpoch(), 1);
  server.enqueue(dest, 'CHAT: hi'); // control: no hook
  server.emitResult('1-0');
  await sleep(150);
  assert.ok(acked.length >= 3);
  assert.ok(acked.every(([d, e]) => d === dest && e === 1));
  assert.deepEqual(acked.filter((a) => a[2]).length, 1);
  assert.equal(acked[acked.length - 1][2], true);
  server.removeClient(dest);
  assert.equal(changed, 2);
  server.setPlayers('W', 'B');
  assert.equal(server.currentEpoch(), 2);
  sock.close();
  server.close();
});
