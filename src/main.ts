import * as THREE from 'three';
import { LensRig } from './engine/lens';
import { Post } from './engine/post';
import { Sky } from './engine/sky';
import { loadWorld } from './engine/world';

const params = new URLSearchParams(location.search);
const setName = params.get('set') ?? 'estate';
const manual = params.has('manual'); // frames are only drawn when a test asks for one
const quality = Number(params.get('q') ?? '1');

const canvas = document.getElementById('view') as HTMLCanvasElement;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootText = document.getElementById('boot-text') as HTMLElement;
const boot = document.getElementById('boot') as HTMLElement;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  depth: false,
  stencil: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: manual,
});
renderer.autoClear = true;
renderer.setClearColor(0x000000, 1);
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const rig = new LensRig();
scene.add(rig.rig);
const post = new Post(renderer, rig);

/** The picture is always upright (9:16 at most), like the phone clip it imitates. */
function layout(): void {
  const forced = params.get('size')?.split('x').map(Number);
  let w: number;
  let h: number;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (forced && forced.length === 2) {
    [w, h] = forced;
    dpr = 1;
  } else {
    h = window.innerHeight;
    w = Math.min(window.innerWidth, Math.round((h * 9) / 16));
  }
  const pw = Math.max(2, Math.round(w * dpr));
  const ph = Math.max(2, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  renderer.setSize(pw, ph, false);
  post.setSize(pw, ph, quality);
}

const pose = { x: 0, y: 0.12, z: 0, heading: 0, pitch: -6, roll: 0 };
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('resize', layout);

function fly(dt: number): void {
  const speed = (keys.has('ShiftLeft') ? 9 : 2.2) * dt;
  const turn = 70 * dt;
  if (keys.has('ArrowLeft')) pose.heading -= turn;
  if (keys.has('ArrowRight')) pose.heading += turn;
  if (keys.has('ArrowUp')) pose.pitch = Math.min(80, pose.pitch + turn);
  if (keys.has('ArrowDown')) pose.pitch = Math.max(-80, pose.pitch - turn);
  const h = THREE.MathUtils.degToRad(pose.heading);
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  let mx = 0;
  let mz = 0;
  if (keys.has('KeyW')) { mx += fx; mz += fz; }
  if (keys.has('KeyS')) { mx -= fx; mz -= fz; }
  if (keys.has('KeyD')) { mx -= fz; mz += fx; }
  if (keys.has('KeyA')) { mx += fz; mz -= fx; }
  pose.x += mx * speed;
  pose.z += mz * speed;
  if (keys.has('KeyE')) pose.y += speed;
  if (keys.has('KeyQ')) pose.y = Math.max(0.03, pose.y - speed);
}

function frame(dt: number): void {
  rig.setPose(pose.x, pose.y, pose.z, pose.heading, pose.pitch, pose.roll);
  renderer.info.reset();
  post.render(scene, dt);
}

async function start(): Promise<void> {
  layout();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const world = await loadWorld(setName, Math.min(16, maxAniso), (done, total) => {
    bootFill.style.width = `${Math.round((done / total) * 90)}%`;
  });
  bootText.textContent = 'Checking the camera';
  const sky = new Sky(world.materials.globals);
  await sky.load(renderer, world.base + world.info.sky.file, world.info.sky.range);
  scene.add(world.group, sky.mesh);

  const [sx, sy, sz] = world.info.spawn.pos;
  pose.x = sx;
  pose.y = sy + 0.12;
  pose.z = sz;
  pose.heading = world.info.spawn.heading;

  bootFill.style.width = '100%';
  boot.classList.add('done');

  // hooks for automated test pictures (tools/shots.mjs)
  const api = {
    pose,
    look: post.look,
    info: world.info,
    globals: world.materials.globals,
    /** advance and draw `n` frames of `dt` seconds */
    step(dt = 1 / 60, n = 1) {
      for (let i = 0; i < n; i++) frame(dt);
    },
    cut() {
      post.cut();
    },
    stats() {
      const r = renderer.info.render;
      return { calls: r.calls, triangles: r.triangles, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0 };
    },
    shot(): string {
      return canvas.toDataURL('image/jpeg', 0.92);
    },
  };
  (window as unknown as { __wc: typeof api }).__wc = api;

  if (!manual) {
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      fly(dt);
      frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } else {
    frame(1 / 60);
  }
}

start().catch((err) => {
  console.error(err);
  bootText.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
