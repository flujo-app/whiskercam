import * as THREE from 'three';
import { setProbe, type Materials } from '../engine/materials';
import type { Physics } from '../engine/physics';
import { SHADOW_LAYER } from '../engine/shadows';
import type { GroundLight, GroundSample } from '../engine/world';
import type { Nav } from './nav';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export type Coat = 'tabby' | 'ginger' | 'black' | 'white' | 'grey' | 'tux';

export const COAT_COLOURS: Record<Coat, [number, number, number]> = {
  tabby: [0.22, 0.16, 0.1],
  ginger: [0.5, 0.24, 0.07],
  black: [0.02, 0.02, 0.022],
  white: [0.72, 0.7, 0.66],
  grey: [0.2, 0.21, 0.23],
  tux: [0.03, 0.03, 0.034],
};

/** What a cat is doing, in the terms the drawing code needs. */
export interface CatLook {
  /** 'stand' | 'sit' | 'move' | 'fight' | 'crouch' */
  stance: 'stand' | 'sit' | 'move' | 'fight' | 'crouch';
  speed: number;
  /** stride cycle 0..1 */
  phase: number;
  /** 0..1 how far each front paw is raised / swung (fights, swipes) */
  pawLeft: number;
  pawRight: number;
  /** -1..1 head turned left / right */
  headTurn: number;
  /** 0..1 flinching back */
  flinch: number;
  /** 0..1 fur on end, back arched */
  puff: number;
  /** metres the throat is carried below its normal height (neck stretched low when running) */
  headLow: number;
}

export const restLook = (): CatLook => ({ stance: 'stand', speed: 0, phase: 0, pawLeft: 0, pawRight: 0, headTurn: 0, flinch: 0, puff: 0, headLow: 0 });

/** How a cat is drawn. The stand-in below is replaced by the furry model once that is loaded. */
export interface CatVisual {
  readonly root: THREE.Object3D;
  update(look: CatLook, dt: number): void;
  setLight(sample: GroundSample): void;
  setVisible(mainView: boolean): void;
  /** how far the camera is, so far-away cats can be drawn more cheaply (or not at all) */
  setDetail?(distance: number): void;
  /** where the collar sits in the cat's own space (x right, y up, z back), for hanging the camera on it */
  readonly collarAt: THREE.Vector3;
  /** where the collar is right now in the world, after the pose (the furry cat only) */
  collarWorld?(out: THREE.Vector3): THREE.Vector3;
}

export type CatVisualFactory = (coat: Coat, name: string) => CatVisual;

/** Placeholder cat made of a few rounded shapes; enough to test chases and fights. */
export class StandInCat implements CatVisual {
  readonly root = new THREE.Group();
  readonly collarAt = new THREE.Vector3(0, 0.175, -0.19);
  private readonly mat: THREE.ShaderMaterial;
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Group;
  private readonly paws: THREE.Mesh[] = [];
  private readonly tail: THREE.Mesh;
  private t = 0;

  constructor(private readonly materials: Materials, coat: Coat, name: string) {
    const c = COAT_COLOURS[coat];
    this.mat = materials.custom(`standin_${name}`, { kind: 'flat', color: c, rough: 0.85, metal: 0 });
    const bodyGeo = new THREE.CapsuleGeometry(0.058, 0.25, 6, 12);
    bodyGeo.rotateX(Math.PI / 2);
    this.body = new THREE.Mesh(bodyGeo, this.mat);
    this.body.position.set(0, 0.17, 0.02);
    this.head = new THREE.Group();
    this.head.position.set(0, 0.215, -0.2);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 12), this.mat);
    const earGeo = new THREE.ConeGeometry(0.02, 0.045, 6);
    const earL = new THREE.Mesh(earGeo, this.mat);
    earL.position.set(-0.03, 0.05, 0.005);
    const earR = new THREE.Mesh(earGeo, this.mat);
    earR.position.set(0.03, 0.05, 0.005);
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), this.mat);
    muzzle.position.set(0, -0.012, -0.042);
    this.head.add(skull, earL, earR, muzzle);
    const tailGeo = new THREE.CylinderGeometry(0.011, 0.016, 0.27, 6);
    tailGeo.translate(0, 0.135, 0);
    this.tail = new THREE.Mesh(tailGeo, this.mat);
    this.tail.position.set(0, 0.19, 0.2);
    this.tail.rotation.x = Math.PI / 2.3;
    this.root.add(this.body, this.head, this.tail);
    const legGeo = new THREE.CylinderGeometry(0.016, 0.014, 0.16, 6);
    legGeo.translate(0, -0.08, 0);
    for (const [x, z] of [[-0.04, -0.12], [0.04, -0.12], [-0.045, 0.14], [0.045, 0.14]] as const) {
      const leg = new THREE.Mesh(legGeo, this.mat);
      leg.position.set(x, 0.16, z);
      this.paws.push(leg);
      this.root.add(leg);
    }
    this.root.traverse((o) => o.layers.enable(SHADOW_LAYER));
  }

  update(look: CatLook, dt: number): void {
    this.t += dt;
    const a = look.phase * Math.PI * 2;
    const run = clamp(look.speed / 6, 0, 1);
    const swing = look.stance === 'move' ? 0.5 + 0.6 * run : 0;
    const gallop = look.speed > 4.2;
    // front pair and hind pair move together in a gallop, diagonals in a trot
    const ph = gallop ? [0, 0.12, 0.5, 0.62] : [0, 0.5, 0.5, 0];
    for (let i = 0; i < 4; i++) this.paws[i].rotation.x = Math.sin(a + ph[i] * Math.PI * 2) * swing;
    this.paws[0].rotation.x -= look.pawLeft * 1.9;
    this.paws[1].rotation.x -= look.pawRight * 1.9;
    const sit = look.stance === 'sit' ? 1 : 0;
    const low = look.stance === 'crouch' ? 1 : 0;
    this.body.rotation.x = -sit * 0.55 + Math.sin(a) * 0.08 * run + look.flinch * 0.2;
    this.body.position.y = 0.17 - sit * 0.02 - low * 0.07 + (gallop ? Math.abs(Math.sin(a)) * 0.02 : 0) + look.puff * 0.02;
    this.head.position.y = 0.215 + sit * 0.06 - low * 0.08 + look.puff * 0.02;
    this.head.position.z = -0.2 + sit * 0.07 + look.flinch * 0.05;
    this.head.rotation.y = -look.headTurn * 0.9;
    this.paws[2].visible = this.paws[3].visible = true;
    this.tail.rotation.x = Math.PI / 2.3 - sit * 0.9 + Math.sin(this.t * 2.2) * 0.12 - look.puff * 0.7;
    this.tail.rotation.z = Math.sin(this.t * 1.7) * 0.25;
    this.root.scale.setScalar(1 + look.puff * 0.08);
  }

  setLight(sample: GroundSample): void {
    setProbe(this.mat, sample, this.materials.globals);
  }

  setVisible(mainView: boolean): void {
    this.root.traverse((o) => {
      if (mainView) o.layers.enable(0);
      else o.layers.disable(0);
    });
  }
}

/** A cat somewhere on the estate that is not the player. */
export class Npc {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  speed = 0;
  readonly look: CatLook = restLook();
  path: number[] = [];
  pathIndex = 0;
  private readonly sample: GroundSample = { r: 0, g: 0, b: 0, sun: 1 };
  private litX = 1e9;
  private litZ = 1e9;

  constructor(
    readonly name: string,
    readonly coat: Coat,
    readonly visual: CatVisual,
    private readonly physics: Physics,
    private readonly light: GroundLight,
  ) {}

  place(x: number, z: number, heading: number): void {
    this.x = x;
    this.z = z;
    this.heading = heading;
    const g = this.physics.groundBelow(x, 3, z, 6);
    this.y = g ? g.y : 0;
    this.sync(0);
  }

  distanceTo(x: number, z: number): number {
    return Math.hypot(this.x - x, this.z - z);
  }

  face(x: number, z: number, dt: number, rate = 8): void {
    const want = Math.atan2(x - this.x, -(z - this.z)) / DEG;
    let d = ((want - this.heading + 540) % 360) - 180;
    d *= 1 - Math.exp(-rate * dt);
    this.heading = (this.heading + d + 360) % 360;
  }

  setPath(path: number[]): void {
    this.path = path;
    this.pathIndex = path.length > 1 ? 1 : 0;
  }

  get arrived(): boolean {
    return this.pathIndex >= this.path.length;
  }

  /** Run along the current path at up to `speed`. Returns true while still under way. */
  follow(nav: Nav, speed: number, dt: number): boolean {
    if (this.arrived) {
      this.speed += (0 - this.speed) * (1 - Math.exp(-8 * dt));
      return false;
    }
    const [tx, tz] = nav.nodes[this.path[this.pathIndex]];
    const dx = tx - this.x;
    const dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.7) {
      this.pathIndex++;
      return !this.arrived;
    }
    // slow a little into sharp corners
    let corner = 1;
    if (this.pathIndex + 1 < this.path.length) {
      const [nx, nz] = nav.nodes[this.path[this.pathIndex + 1]];
      const a = Math.atan2(dx, -dz);
      const b = Math.atan2(nx - tx, -(nz - tz));
      const turn = Math.abs(((b - a) / DEG + 540) % 360 - 180);
      corner = clamp(1 - (turn / 180) * 0.75 * clamp(1 - d / 5, 0, 1), 0.4, 1);
    }
    const want = speed * corner;
    this.speed += clamp(want - this.speed, -14 * dt, 9 * dt);
    this.face(tx, tz, dt, 7 + this.speed);
    const h = this.heading * DEG;
    this.x += Math.sin(h) * this.speed * dt;
    this.z -= Math.cos(h) * this.speed * dt;
    return true;
  }

  /** Stick to the ground, advance the stride, refresh light, push the pose to the drawing. (viewX, viewZ) = where the camera is. */
  sync(dt: number, viewX = this.x, viewZ = this.z): void {
    this.visual.setDetail?.(Math.hypot(this.x - viewX, this.z - viewZ));
    const g = this.physics.groundBelow(this.x, this.y + 0.6, this.z, 2);
    if (g) this.y += (g.y - this.y) * (dt > 0 ? 1 - Math.exp(-18 * dt) : 1);
    const v = Math.abs(this.speed);
    if (v > 0.15) {
      this.look.phase = (this.look.phase + (v / (0.34 + 0.165 * v)) * dt) % 1;
      this.look.stance = 'move';
    } else if (this.look.stance === 'move') {
      this.look.stance = 'stand';
    }
    this.look.speed = v;
    if ((this.x - this.litX) ** 2 + (this.z - this.litZ) ** 2 > 0.09) {
      this.visual.setLight(this.light.sample(this.x, this.z, this.sample));
      this.litX = this.x;
      this.litZ = this.z;
    }
    this.visual.root.position.set(this.x, this.y, this.z);
    this.visual.root.rotation.y = -this.heading * DEG;
    this.visual.update(this.look, dt);
  }
}
