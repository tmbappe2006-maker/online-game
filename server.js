// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

process.on('uncaughtException', (err) => { console.error('uncaughtException', err && err.stack ? err.stack : err); });
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection', reason && reason.stack ? reason.stack : reason); });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));
app.get('/_health', (req, res) => res.send('OK'));

// マッチングキュー（"対戦する" を押した人を待たせる）
let waiting = null; // socket.id of waiting player
const games = new Map();

function makeEmptyBoard(size=15){
  return Array.from({length:size}, () => Array(size).fill(null));
}

function checkWin(board, x, y, symbol){
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  const n = board.length;
  for (const [dx,dy] of dirs) {
    let cnt = 1;
    for (let step=1; step<5; step++){
      const nx = x + dx*step, ny = y + dy*step;
      if (nx<0||ny<0||nx>=n||ny>=n) break;
      if (board[ny][nx] === symbol) cnt++; else break;
    }
    for (let step=1; step<5; step++){
      const nx = x - dx*step, ny = y - dy*step;
      if (nx<0||ny<0||nx>=n||ny>=n) break;
      if (board[ny][nx] === symbol) cnt++; else break;
    }
    if (cnt >= 5) return true;
  }
  return false;
}

io.on('connection', (socket) => {
  console.log('接続:', socket.id);

  // ここでは自動マッチングしない。クライアントから 'findMatch' を待つ。
  socket.on('findMatch', () => {
    try {
      console.log(`${socket.id} が対戦要求`);
      if (!waiting) {
        waiting = socket.id;
        socket.emit('waitingForOpponent');
        console.log('待機プレイヤー:', socket.id);
      } else if (waiting === socket.id) {
        // すでに待機中の同じソケット
        socket.emit('message', '既に対戦待ちです');
      } else {
        // ペア作成
        const a = waiting;
        const b = socket.id;
        waiting = null;

        // notify second that opponent was waiting
        socket.emit('opponentWasWaiting');

        const roomId = `room-${a}-${b}`;
        socket.join(roomId);
        const sockA = io.sockets.sockets.get(a);
        if (sockA) sockA.join(roomId);

        // ゲーム初期化
        const board = makeEmptyBoard(15);
        const game = {
          roomId,
          players: [a, b],
          turnIndex: 0, // a が先手
          board,
          over: false,
        };
        games.set(roomId, game);

        // symbol map: 先手 = black, 後手 = white
        const mapSymbol = {};
        mapSymbol[a] = 'black';
        mapSymbol[b] = 'white';
        game.symbolMap = mapSymbol;

        // start を送る（先に押した人を a とする）
        if (sockA) sockA.emit('start', { roomId, yourSymbol: mapSymbol[a], yourTurn: true });
        if (io.sockets.sockets.get(b)) io.to(b).emit('start', { roomId, yourSymbol: mapSymbol[b], yourTurn: false });

        console.log('マッチング完了', a, b, 'room:', roomId);
      }
    } catch (e) {
      console.error('findMatch error', e && e.stack ? e.stack : e);
      socket.emit('message', 'サーバーエラー（マッチング）');
    }
  });

  socket.on('play', (data) => {
    try {
      const { roomId, x, y } = data || {};
      const game = games.get(roomId);
      if (!game) {
        socket.emit('invalidMove', 'ゲームが見つかりません');
        return;
      }
      if (game.over) {
        socket.emit('invalidMove', 'ゲームは終了しています');
        return;
      }
      const playerIndex = game.players.indexOf(socket.id);
      if (playerIndex === -1) {
        socket.emit('invalidMove', 'あなたはこのゲームの参加者ではありません');
        return;
      }
      if (playerIndex !== game.turnIndex) {
        socket.emit('invalidMove', '現在あなたの番ではありません');
        return;
      }
      const n = game.board.length;
      if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || y < 0 || x >= n || y >= n) {
        socket.emit('invalidMove', '座標が範囲外です');
        return;
      }
      if (game.board[y][x] !== null) {
        socket.emit('invalidMove', 'そのマスは既に置かれています');
        return;
      }

      const symbol = game.symbolMap[socket.id];
      game.board[y][x] = symbol;

      // 勝利チェック
      const isWin = checkWin(game.board, x, y, symbol);

      // 次の手番
      game.turnIndex = 1 - game.turnIndex;

      io.to(roomId).emit('move', {
        roomId,
        x, y, symbol,
        nextTurn: game.symbolMap[game.players[game.turnIndex]]
      });

      if (isWin) {
        game.over = true;
        io.to(roomId).emit('gameOver', { roomId, winnerSymbol: symbol, reason: 'five-in-a-row' });
        console.log(`ゲーム終了: ${roomId} 勝者 ${symbol}`);
        return;
      }

      // 引き分け判定（盤が埋まった）
      const full = game.board.every(row => row.every(cell => cell !== null));
      if (full) {
        game.over = true;
        io.to(roomId).emit('gameOver', { roomId, winnerSymbol: null, reason: 'draw' });
        console.log(`ゲーム引き分け: ${roomId}`);
      }

    } catch (e) {
      console.error('play handler error', e && e.stack ? e.stack : e);
      socket.emit('invalidMove', 'サーバーエラー');
    }
  });

  socket.on('requestRestart', ({ roomId }) => {
    const game = games.get(roomId);
    if (!game) return;
    game.board = makeEmptyBoard(15);
    game.turnIndex = 0;
    game.over = false;
    io.to(roomId).emit('start', { roomId, yourSymbol: game.symbolMap[game.players[0]], yourTurn: true });
    io.to(roomId).emit('message', '再戦開始（サーバーによる簡易再戦）');
    console.log('restarted room', roomId);
  });

  socket.on('leave', () => {
    socket.disconnect(true);
  });

  socket.on('disconnect', () => {
    console.log('切断:', socket.id);
    if (waiting === socket.id) waiting = null;

    for (const [roomId, game] of games.entries()) {
      if (game.players.includes(socket.id)) {
        const other = game.players.find(id => id !== socket.id);
        if (other) {
          io.to(other).emit('opponentLeft');
        }
        games.delete(roomId);
        console.log('ゲーム破棄:', roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
