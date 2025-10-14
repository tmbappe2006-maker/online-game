// server.js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let switchState = false; // スイッチの状態

wss.on('connection', (ws) => {
  // 接続したら状態を送る
  ws.send(JSON.stringify({ type: 'update', state: switchState }));

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    if(data.type === 'toggle') {
      switchState = !switchState; // スイッチ切り替え
      // すべてのクライアントに通知
      wss.clients.forEach(client => {
        if(client.readyState === WebSocket.OPEN){
          client.send(JSON.stringify({ type: 'update', state: switchState }));
        }
      });
    }
  });
});
