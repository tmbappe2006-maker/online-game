// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get('/_health', (_, res) => res.send('OK'));

// 3つの部屋
const rooms = [
  { id: 1, players: [], state: 'empty' },   // state: 'empty' | 'waiting' | 'playing'
  { id: 2, players: [], state: 'empty' },
  { id: 3, players: [], state: 'empty' }
];

// ルームごとのゲーム状態管理（退出/戻るのフラグ）
const gameState = new Map(); // roomId -> { exited: {sid:bool}, returned: {sid:bool} }

io.on('connection', (socket) => {
  console.log('接続:', socket.id);
  socket.emit('updateRooms', rooms);

  // 入室
  socket.on('joinRoom', (roomId) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    // すでに試合中は入れない
    if (room.state === 'playing') {
      socket.emit('roomFull');
      return;
    }

    // 既に同じ人が入室していないか念のため除去
    room.players = room.players.filter(p => p !== socket.id);
    room.players.push(socket.id);
    socket.roomId = room.id;

    if (room.players.length === 1) {
      // 一人目：待機
      room.state = 'waiting';
      socket.emit('waitingOpponent');
      io.emit('updateRooms', rooms);
    } else if (room.players.length === 2) {
      // 二人目：試合開始
      room.state = 'playing';

      // ゲーム状態初期化
      gameState.set(room.id, { exited: {}, returned: {} });

      // 先手（黒）・後手（白）をランダム決定
      const firstIdx = Math.random() < 0.5 ? 0 : 1;
      const secondIdx = 1 - firstIdx;

      // yourTurn: true の方が先手（＝黒）
      io.to(room.players[firstIdx]).emit('startGame', { yourTurn: true });
      io.to(room.players[secondIdx]).emit('startGame', { yourTurn: false });

      io.emit('updateRooms', rooms);
    }
  });

  // 石を置いた（今回はサーバーは合法判定を省き、座標のみブロードキャスト）
  socket.on('move', ({ x, y }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.find(r => r.id === roomId);
    if (!room || room.state !== 'playing') return;

    const other = room.players.find(p => p !== socket.id);
    if (other) io.to(other).emit('opponentMove', { x, y });
  });

  // 退出ボタン：UIを抜けるが、部屋は playing のまま
  socket.on('exitGame', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    const st = gameState.get(room.id) || { exited: {}, returned: {} };
    st.exited[socket.id] = true;
    gameState.set(room.id, st);

    const other = room.players.find(p => p !== socket.id);
    if (other) io.to(other).emit('opponentLeft');

    // 部屋は playing のまま（新規入室不可）
    room.state = 'playing';
    io.emit('updateRooms', rooms);
  });

  // ルーム選択に戻るボタン：両者押したら完全に部屋を空に
  socket.on('returnToLobby', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    const st = gameState.get(room.id) || { exited: {}, returned: {} };
    st.returned[socket.id] = true;
    gameState.set(room.id, st);

    const other = room.players.find(p => p !== socket.id);
    const otherReturned = other ? !!st.returned[other] : true; // 相手が切断済みなら true 扱い

    // 自分の roomId は即クリア（再入室できるように）
    socket.roomId = null;

    if (otherReturned) {
      // 二人ともロビーへ戻った → 完全リセット
      room.players.forEach(pid => {
        const s = io.sockets.sockets.get(pid);
        if (s) s.roomId = null;
      });
      room.players = [];
      room.state = 'empty';
      gameState.delete(room.id);
      io.emit('updateRooms', rooms);
    } else {
      // 片方だけなら playing 維持
      room.state = 'playing';
      io.emit('updateRooms', rooms);
    }
  });

  // 切断時：抜けた人は exit & return 済み扱い。残った人が戻れば部屋が空になる。
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    const st = gameState.get(room.id) || { exited: {}, returned: {} };
    st.exited[socket.id] = true;
    st.returned[socket.id] = true;
    gameState.set(room.id, st);

    const other = room.players.find(p => p !== socket.id);
    if (other) io.to(other).emit('opponentLeft');

    // 相手がすでに戻っているなら今ここで空に
    const otherReturned = other ? !!st.returned[other] : true;
    if (otherReturned) {
      room.players = [];
      room.state = 'empty';
      gameState.delete(room.id);
      io.emit('updateRooms', rooms);
    } else {
      room.state = 'playing';
      io.emit('updateRooms', rooms);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
