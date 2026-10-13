// The e2e's "internet": a CONNECT proxy that routes GitHub's Copilot hosts to
// the local fake and refuses everything else. Iron Proxy dials through it.
// Env: E2E_PORT (fake API), E2E_ROUTER_PORT.
import http from 'node:http';
import net from 'node:net';

const ROUTED = /^(api\.github\.com|([a-z0-9-]+\.)*githubcopilot\.com):443$/;
const server = http.createServer((_req, res) => {
  res.writeHead(405);
  res.end();
});
server.on('connect', (req, socket, head) => {
  if (!ROUTED.test(req.url ?? '')) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = net.connect(Number(process.env.E2E_PORT ?? 18443), '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
server.listen(Number(process.env.E2E_ROUTER_PORT ?? 18444), '127.0.0.1', () => console.log('upstream router ready'));
