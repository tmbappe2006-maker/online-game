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

// 3つの部屋（locked = 一度2人で開始したら両者が戻るまで“試合中”ロック）
const rooms = [
  { id: 1, players: [], locked: false },
  { id: 2, players: [], locked: false },
  { id: 3, players: [], locked: false }
];

// 退出/戻るのトラッキング（roomId -> { returned: {sid:bool} }）
const gameState = new Map();

io.on('connection', (socket) => {
  console.log('接続:', socket.id);
  emitRooms();

  // 入室
  socket.on('joinRoom', (roomId) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    // locked の部屋は人数が1でも入れない（途中参戦不可）
    if (room.locked) {
      socket.emit('roomFull');
      return;
    }

    // まだロックされていない部屋は 0 or 1 人まで入室可
    if (room.players.length >= 2) {
      socket.emit('roomFull');
      return;
    }

    // 入室処理
    room.players = room.players.filter(p => p !== socket.id);
    room.players.push(socket.id);
    socket.roomId = room.id;

    if (room.players.length === 1) {
      // 一人目：待機（部屋の見た目は “相手待機中”）
      socket.emit('waitingOpponent');
      emitRooms();
    } else if (room.players.length === 2) {
      // 二人目：試合開始 → locked = true
      room.locked = true;
      gameState.set(room.id, { returned: {} });

      // 先手/後手ランダム
      const firstIdx = Math.random() < 0.5 ? 0 : 1;
      const secondIdx = 1 - firstIdx;
      io.to(room.players[firstIdx]).emit('startGame', { yourTurn: true });
      io.to(room.players[secondIdx]).emit('startGame', { yourTurn: false });

      emitRooms();
    }
  });

  // 手の通知（簡易：合法判定は省略）
  socket.on('move', ({ x, y }) => {
    const room = getMyRoom(socket);
    if (!room || !room.locked) return;
    const other = room.players.find(p => p !== socket.id);
    if (other) io.to(other).emit('opponentMove', { x, y });
  });

  // 自分が「退出」ボタン（UIを閉じるが、入室中判定は維持）
  socket.on('exitGame', () => {
    const room = getMyRoom(socket);
    if (!room) return;

    const other = room.players.find(p => p !== socket.id);
    if (other) io.to(other).emit('opponentLeft');

    // 入室中人数は減らさない（2→1でも“試合中”を維持）
    emitRooms();
  });

  // 「ルーム選択に戻る」ボタン（実際に部屋から離脱する）
  socket.on('returnToLobby', () => {
    const room = getMyRoom(socket);
    if (!room) return;

    // 戻ったフラグ
    const st = gameState.get(room.id) || { returned: {} };
    st.returned[socket.id] = true;
    gameState.set(room.id, st);

    // 自分を部屋から外す（入室人数を減らす）
    room.players = room.players.filter(p => p !== socket.id);
    socket.roomId = null;

    // 0人になったら完全リセット（空きにする・ロック解除）
    if (room.players.length === 0) {
      room.locked = false;
      gameState.delete(room.id);
      emitRooms();
      return;
    }

    // 1人残っている間は“試合中（locked）”のまま
    emitRooms();
  });

  // 切断時
  socket.on('disconnect', () => {
    const room = getMyRoom(socket);
    if (!room) return;

    // 戻った扱いにして人数を減らす
    const st = gameState.get(room.id) || { returned: {} };
    st.returned[socket.id] = true;
    gameState.set(room.id, st);

    room.players = room.players.filter(p => p !== socket.id);

    const other = room.players[0];
    if (other) io.to(other).emit('opponentLeft');

    if (room.players.length === 0) {
      room.locked = false;
      gameState.delete(room.id);
    }
    emitRooms();
  });

  // ユーティリティ
  function getMyRoom(s) {
    const id = s.roomId;
    if (!id) return null;
    return rooms.find(r => r.id === id) || null;
  }

  function emitRooms() {
    // state 表示の決め方：
    //   players.length === 0 → 'empty'
    //   players.length === 1 かつ !locked → 'waiting'（初期の待機のみ）
    //   それ以外（locked で 2→1 も含む）→ 'playing'
    const payload = rooms.map(r => ({
      id: r.id,
      state:
        r.players.length === 0
          ? 'empty'
          : (!r.locked && r.players.length === 1 ? 'waiting' : 'playing')
    }));
    io.emit('updateRooms', payload);
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
