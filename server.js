import express from "express";
import http from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import * as CANNON from "cannon-es";

// __dirname の再構築
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =======================
// Express サーバー設定
// =======================
const app = express();
app.use(express.static(__dirname)); // index.htmlなどを配信

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =======================
// 物理ワールド設定
// =======================
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.solver.iterations = 12;
world.solver.tolerance = 0.001;

const FIELD_W = 60, FIELD_L = 36, WALL_H = 8;

// 地面
{
  const ground = new CANNON.Body({ type: CANNON.Body.STATIC });
  ground.addShape(new CANNON.Box(new CANNON.Vec3(FIELD_W / 2, 0.5, FIELD_L / 2)));
  ground.position.set(0, -0.5, 0);
  world.addBody(ground);
}

// 壁4枚
function addWall(x, y, z, sx, sy, sz) {
  const wall = new CANNON.Body({ type: CANNON.Body.STATIC });
  wall.addShape(new CANNON.Box(new CANNON.Vec3(sx / 2, sy / 2, sz / 2)));
  wall.position.set(x, y, z);
  world.addBody(wall);
}
addWall(0, WALL_H / 2, -FIELD_L / 2, FIELD_W, WALL_H, 1);
addWall(0, WALL_H / 2, FIELD_L / 2, FIELD_W, WALL_H, 1);
addWall(-FIELD_W / 2, WALL_H / 2, 0, 1, WALL_H, FIELD_L);
addWall(FIELD_W / 2, WALL_H / 2, 0, 1, WALL_H, FIELD_L);

// ボール
const BALL_R = 1.2;
const ballBody = new CANNON.Body({
  mass: 3,
  shape: new CANNON.Sphere(BALL_R),
  angularDamping: 0.05,
  linearDamping: 0.01,
});
world.addBody(ballBody);

function resetBall() {
  ballBody.velocity.set(0, 0, 0);
  ballBody.angularVelocity.set(0, 0, 0);
  ballBody.position.set(0, 2, 0);
}
resetBall();

// =======================
// プレイヤー情報
// =======================
const ROOM = "match-1";
const players = new Map(); // socket.id -> {x,y,z,qy,team}

// ゴール位置
const GOAL_W = 14, GOAL_H = 5, GOAL_D = 2;
const goalBlue = { min: { x: -GOAL_W / 2, y: 0, z: -FIELD_L / 2 - 0.5 }, max: { x: GOAL_W / 2, y: GOAL_H, z: -FIELD_L / 2 + GOAL_D } };
const goalOrange = { min: { x: -GOAL_W / 2, y: 0, z: FIELD_L / 2 - GOAL_D }, max: { x: GOAL_W / 2, y: GOAL_H, z: FIELD_L / 2 + 0.5 } };

let blueScore = 0, orangeScore = 0;

// =======================
// Socket.IO 通信
// =======================
io.on("connection", (socket) => {
  // チーム自動振り分け
  const blueCount = Array.from(players.values()).filter(p => p.team === "blue").length;
  const orangeCount = Array.from(players.values()).filter(p => p.team === "orange").length;
  const team = blueCount <= orangeCount ? "blue" : "orange";

  players.set(socket.id, { x: 0, y: 1.2, z: team === "blue" ? 12 : -12, qy: 0, team });
  socket.join(ROOM);

  // 初期データ送信
  socket.emit("hello", {
    id: socket.id,
    team,
    scores: { blue: blueScore, orange: orangeScore },
    ball: { p: ballBody.position, v: ballBody.velocity },
  });

  io.to(ROOM).emit("players", Object.fromEntries(players));

  // クライアントから自分の位置を受け取る
  socket.on("pose", (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = data.x; p.y = data.y; p.z = data.z; p.qy = data.qy;
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    io.to(ROOM).emit("players", Object.fromEntries(players));
  });
});

// =======================
// 車とボールの当たり処理（簡易）
// =======================
const CAR_SIZE = { x: 2.2, y: 1.0, z: 3.2 };

function applyCarBallCollisions() {
  const bp = ballBody.position;
  for (const p of players.values()) {
    const min = { x: p.x - CAR_SIZE.x / 2, y: p.y - CAR_SIZE.y / 2, z: p.z - CAR_SIZE.z / 2 };
    const max = { x: p.x + CAR_SIZE.x / 2, y: p.y + CAR_SIZE.y / 2, z: p.z + CAR_SIZE.z / 2 };
    const closestX = Math.max(min.x, Math.min(bp.x, max.x));
    const closestY = Math.max(min.y, Math.min(bp.y, max.y));
    const closestZ = Math.max(min.z, Math.min(bp.z, max.z));
    const dx = bp.x - closestX, dy = bp.y - closestY, dz = bp.z - closestZ;
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 < BALL_R * BALL_R) {
      const len = Math.max(Math.sqrt(dist2), 0.001);
      const nx = dx / len, ny = dy / len, nz = dz / len;
      const strength = 30;
      ballBody.velocity.x += nx * strength;
      ballBody.velocity.y += ny * strength * 0.6;
      ballBody.velocity.z += nz * strength;
    }
  }
}

// ゴール判定
function inAABB(p, box) {
  return (
    p.x >= box.min.x && p.x <= box.max.x &&
    p.y >= box.min.y && p.y <= box.max.y &&
    p.z >= box.min.z && p.z <= box.max.z
  );
}

// =======================
// メインループ（20Hzブロードキャスト）
// =======================
const FIXED_DT = 1 / 60;
let last = Date.now(), acc = 0;

setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  acc += dt;

  while (acc >= FIXED_DT) {
    applyCarBallCollisions();
    world.step(FIXED_DT);

    const bp = ballBody.position;
    if (inAABB(bp, goalBlue)) { orangeScore++; resetBall(); io.to(ROOM).emit("score", { blue: blueScore, orange: orangeScore }); }
    if (inAABB(bp, goalOrange)) { blueScore++; resetBall(); io.to(ROOM).emit("score", { blue: blueScore, orange: orangeScore }); }

    acc -= FIXED_DT;
  }

  // 20Hz更新送信
  io.to
