const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

const PORT = 3000;

// ルーム管理
const rooms = [
  { id: 1, players: [], state: 'empty' },
  { id: 2, players: [], state: 'empty' },
  { id: 3, players: [], state: 'empty' }
];

app.use(express.static(__dirname));

io.on('connection', socket => {
  console.log('接続:', socket.id);

  // 入室リクエスト
  socket.on('joinRoom', roomId => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    if (room.state === 'playing') {
      socket.emit('roomFull');
      return;
    }

    room.players.push(socket.id);
    socket.roomId = roomId;
    console.log(`Room${roomId} players:`, room.players);

    if (room.players.length === 1) {
      room.state = 'waiting';
      socket.emit('waitingOpponent');
      io.emit('updateRooms', rooms);
    } else if (room.players.length === 2) {
      room.state = 'playing';
      // 先手後手ランダム決定
      const first = Math.random() < 0.5 ? 0 : 1;
      io.to(room.players[first]).emit('startGame', { yourTurn: true });
      io.to(room.players[1-first]).emit('startGame', { yourTurn: false });
      io.emit('updateRooms', rooms);
    }
  });

  // 石を置いた
  socket.on('move', data => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    socket.to(room.players.find(p => p !== socket.id)).emit('opponentMove', data);
  });

  // 再戦リクエスト
  socket.on('rematch', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    socket.rematch = true;
    const bothReady = room.players.every(p => io.sockets.sockets.get(p)?.rematch);
    if (bothReady) {
      // 先手後手ランダム
      const first = Math.random() < 0.5 ? 0 : 1;
      room.players.forEach(p => io.sockets.sockets.get(p).rematch = false);
      io.to(room.players[first]).emit('startGame', { yourTurn: true });
      io.to(room.players[1-first]).emit('startGame', { yourTurn: false });
    }
  });

  // 退出
  socket.on('leaveRoom', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });

  function leaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    room.players = room.players.filter(p => p !== socket.id);
    room.state = room.players.length === 1 ? 'waiting' : 'empty';

    // 残ったプレイヤーに相手が退出した通知
    room.players.forEach(p => {
      io.to(p).emit('opponentLeft');
    });

    io.emit('updateRooms', rooms);
    socket.roomId = null;
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
