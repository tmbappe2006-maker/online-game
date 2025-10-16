// server.js — デバッグ用に詳細ログを出して安全に起動するバージョン
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason && reason.stack ? reason.stack : reason);
});

const app = express();
const server = http.createServer(app);

// socket.io を server に結びつける（CORS を必要なら編集）
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

console.log('Starting app — will try to serve static files from:', __dirname);

// 静的ファイルの配信（index.html がここにある前提）
app.use(express.static(__dirname));

// 簡易なヘルスチェック
app.get('/_health', (req, res) => res.send('OK'));

// ソケットのログを詳細に出す
let players = [];

io.on('connection', (socket) => {
  console.log('接続:', socket.id);

  try {
    players.push(socket.id);
    console.log('players now:', players);

    if (players.length >= 2) {
      console.log('sending start to first two players');
      io.to(players[0]).emit('start', { yourTurn: true });
      io.to(players[1]).emit('start', { yourTurn: false });
    }

    socket.on('move', (data) => {
      console.log('move from', socket.id, data);
      socket.broadcast.emit('opponentMove', data);
    });

    socket.on('disconnect', () => {
      console.log('切断:', socket.id);
      players = players.filter(id => id !== socket.id);
      console.log('players after disconnect:', players);
      io.emit('opponentLeft');
    });
  } catch (e) {
    console.error('error in connection handler', e && e.stack ? e.stack : e);
  }
});

// 明示的に listen してログ出力（これが出なければ即終了している）
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// 万が一プロセス終了のときに reason をログに
process.on('exit', (code) => {
  console.log('Process exit, code=', code);
});
