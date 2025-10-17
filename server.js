const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const CANNON = require("cannon-es");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.solver.iterations = 12;
world.solver.tolerance = 0.001;

const FIELD_W = 60, FIELD_L = 36, WALL_H = 8;
(function addWalls(){
  const ground = new CANNON.Body({ type: CANNON.Body.STATIC });
  ground.addShape(new CANNON.Box(new CANNON.Vec3(FIELD_W/2,0.5,FIELD_L/2)));
  ground.position.set(0,-0.5,0); world.addBody(ground);
  function addWall(x,y,z,sx,sy,sz){
    const b = new CANNON.Body({ type: CANNON.Body.STATIC });
    b.addShape(new CANNON.Box(new CANNON.Vec3(sx/2,sy/2,sz/2)));
    b.position.set(x,y,z); world.addBody(b);
  }
  addWall( 0, WALL_H/2, -FIELD_L/2, FIELD_W, WALL_H, 1);
  addWall( 0, WALL_H/2,  FIELD_L/2, FIELD_W, WALL_H, 1);
  addWall(-FIELD_W/2, WALL_H/2, 0, 1, WALL_H, FIELD_L);
  addWall( FIELD_W/2, WALL_H/2, 0, 1, WALL_H, FIELD_L);
})();

const BALL_R = 1.2;
const ballBody = new CANNON.Body({
  mass: 3,
  shape: new CANNON.Sphere(BALL_R),
  angularDamping: 0.05,
  linearDamping: 0.01,
});
world.addBody(ballBody);
function resetBall(){
  ballBody.velocity.set(0,0,0);
  ballBody.angularVelocity.set(0,0,0);
  ballBody.position.set(0,2,0);
}
resetBall();

const ROOM = "match-1";
const players = new Map();
const GOAL_W = 14, GOAL_H = 5, GOAL_D = 2;
const goalBlue  = { min:{x:-GOAL_W/2,y:0,z:-FIELD_L/2-0.5}, max:{x:GOAL_W/2,y:GOAL_H,z:-FIELD_L/2+GOAL_D} };
const goalOrng  = { min:{x:-GOAL_W/2,y:0,z: FIELD_L/2-GOAL_D}, max:{x:GOAL_W/2,y:GOAL_H,z: FIELD_L/2+0.5} };
let blue = 0, orange = 0;

io.on("connection", (socket) => {
  const blueCount = Array.from(players.values()).filter(p=>p.team==="blue").length;
  const orangeCount = Array.from(players.values()).filter(p=>p.team==="orange").length;
  const team = blueCount <= orangeCount ? "blue" : "orange";
  players.set(socket.id, { x:0, y:1.2, z:(team==="blue"? 12 : -12), qy:0, team });
  socket.join(ROOM);
  socket.emit("hello", {
    id: socket.id, team,
    scores: { blue, orange },
    ball: { p: ballBody.position, v: ballBody.velocity }
  });
  io.to(ROOM).emit("players", Object.fromEntries(players));
  socket.on("pose", (d)=>{ const p=players.get(socket.id); if(!p) return; p.x=d.x; p.y=d.y; p.z=d.z; p.qy=d.qy; });
  socket.on("disconnect", ()=>{ players.delete(socket.id); io.to(ROOM).emit("players", Object.fromEntries(players)); });
});

const CAR_BOX = { x:2.2, y:1.0, z:3.2 };
function applyCarCollisions(){
  const bp = ballBody.position;
  for (const p of players.values()){
    const min = { x:p.x-CAR_BOX.x/2, y:p.y-CAR_BOX.y/2, z:p.z-CAR_BOX.z/2 };
    const max = { x:p.x+CAR_BOX.x/2, y:p.y+CAR_BOX.y/2, z:p.z+CAR_BOX.z/2 };
    const cx = Math.max(min.x, Math.min(bp.x, max.x));
    const cy = Math.max(min.y, Math.min(bp.y, max.y));
    const cz = Math.max(min.z, Math.min(bp.z, max.z));
    const dx = bp.x-cx, dy = bp.y-cy, dz = bp.z-cz;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 < BALL_R*BALL_R){
      const len = Math.max(Math.sqrt(d2), 0.001);
      const nx = dx/len, ny = dy/len, nz = dz/len;
      const strength = 30;
      ballBody.velocity.x += nx*strength;
      ballBody.velocity.y += ny*strength*0.6;
      ballBody.velocity.z += nz*strength;
    }
  }
}
function inAABB(p, a){ return p.x>=a.min.x && p.x<=a.max.x && p.y>=a.min.y && p.y<=a.max.y && p.z>=a.min.z && p.z<=a.max.z; }

const FIXED_DT = 1/60;
let last = Date.now(), acc = 0;
setInterval(()=>{
  const now = Date.now();
  const dt = Math.min(0.05, (now-last)/1000);
  last = now; acc += dt;
  while (acc >= FIXED_DT){
    applyCarCollisions();
    world.step(FIXED_DT);
    const bp = ballBody.position;
    if (inAABB(bp, goalBlue)) { orange++; resetBall(); io.to(ROOM).emit("score", { blue, orange }); }
    if (inAABB(bp, goalOrng)) { blue++;   resetBall(); io.to(ROOM).emit("score", { blue, orange }); }
    acc -= FIXED_DT;
  }
  io.to(ROOM).emit("state", {
    ball: { p: ballBody.position, v: ballBody.velocity },
    players: Object.fromEntries(players)
  });
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log(`http://localhost:${PORT}`));
