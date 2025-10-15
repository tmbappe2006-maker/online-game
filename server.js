const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('WebSocket server is running');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let state = { on: false };

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

wss.on('connection', (ws) => {
  // 接続直後に現状を送る
  ws.send(JSON.stringify({ type: 'state', payload: state }));

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'toggle') {
        state.on = !state.on;
        broadcast({ type: 'state', payload: state });
      }
    } catch (e) {
      // 無視
    }
  });

  // ヘルスチェック（ping/pong）
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log('Listening on', PORT);
});
