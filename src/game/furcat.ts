import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { setProbe, type Globals, type Materials } from '../engine/materials';
import { furFragment, furVertex } from '../engine/shaders/fur.glsl';
import { SHADOW_LAYER } from '../engine/shadows';
import type { GroundSample } from '../engine/world';
import type { CatLook, CatVisual, Coat } from './cats';

import { CatMoves, CH, FRONT, HIND, TAIL } from './catmoves';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The collar camera hangs this far below the neck bone and this far ahead of it (metres). */
const COLLAR_DROP = 0.082;
const COLLAR_AHEAD = 0.047;

const SIDES = ['L', 'R'] as const;

/** A bone and its rest turn. */
interface Joint {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
}
interface LegJoints {
  scapula: Joint | null; upperarm: Joint | null; forearm: Joint | null; wrist: Joint | null; paw: Joint | null;
  thigh: Joint | null; shin: Joint | null; hock: Joint | null; hindpaw: Joint | null;
}
interface Joints {
  hips: Joint | null; spine1: Joint | null; spine2: Joint | null; chest: Joint | null; neck: Joint | null; head: Joint | null; jaw: Joint | null;
  earL: Joint | null; earR: Joint | null; tail: (Joint | null)[]; legs: LegJoints[];
}

/** One leg's bones and what the reaching maths needs to know about them. */
interface Limb {
  /** 0 = the cat's left, 1 = its right */
  side: 0 | 1;
  upper: THREE.Bone;
  lower: THREE.Bone;
  end: THREE.Bone;
  /** upper and lower bone lengths (metres) */
  l1: number;
  l2: number;
  /** each bone's rest turn, relative to a frame with X = the cat's right and Y = along the bone */
  offU: THREE.Quaternion;
  offL: THREE.Quaternion;
  /** the end bone's turn at rest, in the cat's own space */
  endRest: THREE.Quaternion;
  /** the end bone's own rest turn (relative to its parent), inverted */
  endLocalInv: THREE.Quaternion;
  /** +1 front legs (elbow behind), -1 hind legs (knee in front) */
  bend: number;
}

/** The cat model, loaded once and copied for every cat on screen. */
export class CatModel {
  private constructor(
    private readonly template: THREE.Object3D,
    private readonly coats: Map<Coat, THREE.Texture>,
    private readonly furMap: THREE.Texture,
    private readonly eyeMap: THREE.Texture | null,
    private readonly materials: Materials,
  ) {}

  static async load(base: string, materials: Materials, coats: Coat[]): Promise<CatModel> {
    const gltf = await new GLTFLoader().loadAsync(`${base}cat.glb`);
    const loader = new THREE.TextureLoader();
    const tex = async (file: string, srgb: boolean) => {
      const t = await loader.loadAsync(base + file);
      t.flipY = false;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      return t;
    };
    const map = new Map<Coat, THREE.Texture>();
    await Promise.all(coats.map(async (c) => map.set(c, await tex(`cat_${c}_diff.webp`, true))));
    const fur = await tex('cat_fur.webp', false);
    let eyes: THREE.Texture | null = null;
    try {
      eyes = await tex('cat_eyes.webp', true);
    } catch {
      eyes = null;
    }
    return new CatModel(gltf.scene, map, fur, eyes, materials);
  }

  /** how many fur layers a cat right in front of the camera gets */
  shells = 16;
  /** phones: thin the fur out sooner with distance */
  lean = false;
  /** 1 = all the fur the distance calls for; less on a device that cannot keep up (applies to every cat at once) */
  thrift = 1;

  make(coat: Coat, name: string): FurCat {
    const cat = new FurCat(cloneSkinned(this.template), this.coats.get(coat) ?? [...this.coats.values()][0], this.furMap, this.eyeMap, this.materials, name, this.shells);
    cat.lean = this.lean;
    cat.model = this;
    return cat;
  }
}

export class FurCat implements CatVisual {
  readonly root = new THREE.Group();
  /** where the collar camera sits (under the throat), in the model's own space */
  readonly collarAt = new THREE.Vector3(0, 0.17, -0.19);
  private neck: THREE.Object3D | null = null;
  shellCount = 18;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<string, THREE.Quaternion>();
  private readonly restPos = new Map<string, THREE.Vector3>();
  private readonly fur: THREE.ShaderMaterial;
  private readonly shells: THREE.SkinnedMesh;
  private readonly shellGeo: THREE.InstancedBufferGeometry;
  private readonly extra: THREE.ShaderMaterial[] = [];
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly lag = new THREE.Vector3();
  private readonly lastPos = new THREE.Vector3();
  private whiskerMat: THREE.ShaderMaterial | null = null;
  /** the movement brain: turns the look into a pose */
  private readonly moves = new CatMoves();
  private readonly limbs: Limb[] = [];
  private joints: Joints | null = null;
  private headBone: THREE.Bone | null = null;
  private readonly headRest = new THREE.Quaternion();
  private readonly neckRest = new THREE.Vector3();
  /** set once the game hangs its camera on this cat */
  private carriesCamera = false;
  // scratch space for the per-frame maths (nothing is allocated while the game runs)
  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();
  private readonly v5 = new THREE.Vector3();
  private readonly v6 = new THREE.Vector3();
  private readonly v7 = new THREE.Vector3();
  private readonly q1 = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly q3 = new THREE.Quaternion();
  private readonly q4 = new THREE.Quaternion();
  private readonly m0 = new THREE.Matrix4();
  private readonly e2 = new THREE.Euler();

  constructor(model: THREE.Object3D, coat: THREE.Texture, furMap: THREE.Texture, eyeMap: THREE.Texture | null, private readonly materials: Materials, name: string, shells = 16) {
    this.shellCount = shells;
    const g: Globals = materials.globals;
    this.root.add(model);
    this.root.name = `cat:${name}`;
    let body: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      const bone = o as THREE.Bone;
      if (bone.isBone) {
        // the loader drops the dot from "paw.L"; keep both spellings so either finds the bone
        const names = /^[a-z]+[LR]$/.test(bone.name) ? [bone.name, `${bone.name.slice(0, -1)}.${bone.name.slice(-1)}`] : [bone.name];
        for (const n of names) {
          this.bones.set(n, bone);
          this.rest.set(n, bone.quaternion.clone());
          this.restPos.set(n, bone.position.clone());
        }
      }
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        mesh.frustumCulled = false;
        const matName = (mesh.material as THREE.Material).name;
        if (matName === 'cat_body' || mesh.name.toLowerCase().includes('body')) body = mesh;
        else {
          // eyes and other smooth parts: ordinary shiny surface, lit like the rest of the cat
          const m = materials.custom(`${name}_${matName}`, eyeMap ? { kind: 'flat', color: [1, 1, 1], rough: 0.08, metal: 0 } : { kind: 'flat', color: [0.35, 0.3, 0.08], rough: 0.08, metal: 0 });
          if (eyeMap) {
            m.defines.USE_MAP = 1;
            m.uniforms.uMapDiff.value = eyeMap;
            m.uniforms.uRough.value = 0.08;
            m.uniforms.uMetal.value = 0;
            m.needsUpdate = true;
          }
          mesh.material = m;
          this.extra.push(m);
        }
      }
    });
    if (!body) throw new Error('cat model has no body mesh');
    const base = body as THREE.SkinnedMesh;

    this.fur = new THREE.ShaderMaterial({
      vertexShader: furVertex,
      fragmentShader: furFragment,
      uniforms: {
        uCoat: { value: coat },
        uFurMap: { value: furMap },
        uShells: { value: this.shellCount },
        uFurLength: { value: 0.026 },
        uDensity: { value: 520 },
        uPuff: { value: 0 },
        uLag: { value: this.lag },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uOwn: { value: 0 },
        uCoatSat: { value: 1 },
        uProbeIrrUp: { value: new THREE.Color(0.3, 0.4, 0.6) },
        uProbeIrrDown: { value: new THREE.Color(0.2, 0.18, 0.15) },
        uProbeSun: { value: 1 },
        uSunDir: g.uSunDir,
        uSunColor: g.uSunColor,
        uFogColor: g.uFogColor,
        uFogDensity: g.uFogDensity,
        uShadowNear: g.uShadowNear,
        uShadowNearMat: g.uShadowNearMat,
        uShadowTexel: g.uShadowTexel,
        uShadowOn: g.uShadowOn,
      },
    });
    // the same body, drawn once per shell in a single call
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = base.geometry.index;
    for (const [key, attr] of Object.entries(base.geometry.attributes)) ig.setAttribute(key, attr);
    ig.instanceCount = this.shellCount;
    ig.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    this.shellGeo = ig;
    this.shells = new THREE.SkinnedMesh(ig, this.fur);
    this.shells.bind(base.skeleton, base.bindMatrix);
    this.shells.frustumCulled = false;
    base.parent!.add(this.shells);
    // the plain body only exists to throw the shadow
    base.material = new THREE.MeshBasicMaterial();
    base.layers.set(SHADOW_LAYER);

    this.root.updateMatrixWorld(true);
    this.measureRest();
    this.joints = this.buildJoints();
    this.addWhiskers();
    const neck = this.bones.get('neck') ?? this.bones.get('chest');
    if (neck) {
      // the camera hangs from the collar: below the throat and a little ahead of it, clear of the chest fur
      this.neck = neck;
      neck.getWorldPosition(this.collarAt);
      this.collarAt.y -= COLLAR_DROP;
      this.collarAt.z -= COLLAR_AHEAD;
    }
  }

  /** Where the collar camera hangs right now (world space), after the pose has been applied. */
  collarWorld(out: THREE.Vector3): THREE.Vector3 {
    // only the cat that carries the camera is asked this: from now on it keeps its head still in the picture
    this.carriesCamera = true;
    if (!this.neck) return this.root.localToWorld(out.copy(this.collarAt));
    this.root.updateMatrixWorld(true);
    this.neck.getWorldPosition(out);
    const yaw = this.root.rotation.y;
    out.y -= COLLAR_DROP;
    out.x -= Math.sin(yaw) * COLLAR_AHEAD;
    out.z -= Math.cos(yaw) * COLLAR_AHEAD;
    return out;
  }

  /** Long white whiskers on both sides of the muzzle: thin lines that ride on the head. */
  private addWhiskers(): void {
    const head = this.bones.get('head');
    if (!head) return;
    const pts: number[] = [];
    const v = new THREE.Vector3();
    const push = (x: number, y: number, z: number) => {
      head.worldToLocal(v.set(x, y, z));
      pts.push(v.x, v.y, v.z);
    };
    for (const side of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const row = k % 3;
        const col = Math.floor(k / 3);
        const x0 = side * (0.011 + col * 0.006);
        const y0 = 0.2395 - row * 0.005;
        const z0 = -0.251 + col * 0.007;
        const len = 0.062 + 0.018 * ((k * 37) % 5) / 4;
        const up = (1 - row) * 0.22 - 0.05;          // top row fans up, bottom row down
        const fwd = -0.1 - col * 0.25;
        const n = 7;
        let px = x0;
        let py = y0;
        let pz = z0;
        for (let i = 1; i <= n; i++) {
          const f = i / n;
          const nx = x0 + side * len * f;
          const ny = y0 + len * (up * f - 0.35 * f * f);  // a gentle droop towards the tip
          const nz = z0 + len * fwd * f;
          push(px, py, pz);
          push(nx, ny, nz);
          px = nx;
          py = ny;
          pz = nz;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    // plain lines; the last number written is the "rides with the camera" mark (see setOwn)
    this.whiskerMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uMark: { value: 1 } },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uMark; void main() { gl_FragColor = vec4(uColor, uMark); }',
    });
    const lines = new THREE.LineSegments(geo, this.whiskerMat);
    lines.frustumCulled = false;
    head.add(lines);
  }

  lean = false;
  /** the model this cat was made from (for settings that apply to every cat) */
  model: CatModel | null = null;

  /** Fewer shells for cats far from the camera; none at all when too far to see fur. */
  setDetail(distance: number): void {
    const far = this.lean
      ? distance < 7 ? 6 : distance < 16 ? 4 : distance < 34 ? 2 : 1
      : distance < 7 ? 12 : distance < 16 ? 8 : distance < 34 ? 5 : 3;
    const n = Math.max(1, Math.round(Math.min(this.shellCount, distance < 2.5 ? this.shellCount : far) * (this.model?.thrift ?? 1)));
    this.shellGeo.instanceCount = n;
    this.fur.uniforms.uShells.value = n;
    this.root.visible = distance < 75;
  }

  setLight(sample: GroundSample): void {
    // whiskers are white hairs: as bright as a white thing would be in this light
    const sun = this.materials.globals.uSunColor.value;
    const k = (sample.sun * 0.5) / Math.PI;
    (this.whiskerMat?.uniforms.uColor.value as THREE.Color | undefined)?.setRGB((sample.r + sun.r * k) * 0.8, (sample.g + sun.g * k) * 0.8, (sample.b + sun.b * k) * 0.8);
    setProbe(this.fur, sample, this.materials.globals);
    for (const m of this.extra) setProbe(m, sample, this.materials.globals);
  }

  /** This is the player's own cat: it rides with the camera, so its picture must not be streaked or dragged. */
  setOwn(own: boolean): void {
    this.fur.uniforms.uOwn.value = own ? 1 : 0;
    if (this.whiskerMat) this.whiskerMat.uniforms.uMark.value = own ? 0 : 1;
  }

  setVisible(mainView: boolean): void {
    this.shells.visible = mainView;
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh !== this.shells && !mesh.layers.isEnabled(SHADOW_LAYER)) mesh.visible = mainView;
    });
  }

  /** Turn a bone by (x, y, z) about its own axes, on top of its rest turn. */
  private bend(j: Joint | null, x: number, y = 0, z = 0): void {
    if (!j) return;
    this.e.set(x, y, z, 'XYZ');
    j.bone.quaternion.copy(j.rest).multiply(this.q.setFromEuler(this.e));
  }

  /** Look the bones up once, so posing them every frame needs no names. */
  private buildJoints(): Joints | null {
    const j = (name: string): Joint | null => {
      const bone = this.bones.get(name);
      const rest = this.rest.get(name);
      return bone && rest ? { bone, rest } : null;
    };
    const legs = SIDES.map((s) => ({
      scapula: j(`scapula.${s}`), upperarm: j(`upperarm.${s}`), forearm: j(`forearm.${s}`), wrist: j(`wrist.${s}`), paw: j(`paw.${s}`),
      thigh: j(`thigh.${s}`), shin: j(`shin.${s}`), hock: j(`hock.${s}`), hindpaw: j(`hindpaw.${s}`),
    }));
    return {
      hips: j('hips'), spine1: j('spine1'), spine2: j('spine2'), chest: j('chest'), neck: j('neck'), head: j('head'), jaw: j('jaw'),
      earL: j('ear.L'), earR: j('ear.R'), tail: [1, 2, 3, 4, 5].map((i) => j(`tail${i}`)), legs,
    };
  }

  private turn(name: string, x: number, y = 0, z = 0, order: THREE.EulerOrder = 'XYZ'): void {
    const bone = this.bones.get(name);
    const rest = this.rest.get(name);
    if (!bone || !rest) return;
    this.e.set(x, y, z, order);
    bone.quaternion.copy(rest).multiply(this.q.setFromEuler(this.e));
  }

  /** Measure the legs and head at rest (the model is still at the origin, so world = the cat's own space). */
  private measureRest(): void {
    const pos = (b: THREE.Object3D, out: THREE.Vector3) => out.setFromMatrixPosition(b.matrixWorld);
    const right = new THREE.Vector3(1, 0, 0);
    const offset = (bone: THREE.Bone, child: THREE.Bone): THREE.Quaternion => {
      const y = pos(child, new THREE.Vector3()).sub(pos(bone, new THREE.Vector3())).normalize();
      const x = right.clone().addScaledVector(y, -right.dot(y)).normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      const basis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      const world = bone.getWorldQuaternion(new THREE.Quaternion());
      return basis.invert().multiply(world);
    };
    const get = (n: string) => this.bones.get(n);
    for (const side of SIDES) {
      for (const [u, l, e, bend] of [['upperarm', 'forearm', 'wrist', 1], ['thigh', 'shin', 'hock', -1]] as const) {
        const upper = get(`${u}.${side}`);
        const lower = get(`${l}.${side}`);
        const end = get(`${e}.${side}`);
        if (!upper || !lower || !end) continue;
        const a = pos(upper, new THREE.Vector3());
        const b = pos(lower, new THREE.Vector3());
        const c = pos(end, new THREE.Vector3());
        this.limbs.push({
          side: side === 'L' ? 0 : 1,
          upper,
          lower,
          end,
          l1: a.distanceTo(b),
          l2: b.distanceTo(c),
          offU: offset(upper, lower),
          offL: offset(lower, end),
          endRest: end.getWorldQuaternion(new THREE.Quaternion()),
          endLocalInv: end.quaternion.clone().invert(),
          bend,
        });
      }
    }
    const head = get('head');
    if (head) {
      this.headBone = head;
      head.getWorldQuaternion(this.headRest);
    }
    const neck = get('neck');
    if (neck) pos(neck, this.neckRest);
  }

  update(look: CatLook, dt: number): void {
    const m = this.moves;
    m.carriesCamera = this.carriesCamera;
    m.update(look, dt);
    const P = m.pose;

    // ---- whole body: moved and tipped about the ground point under the hips
    const root = this.bones.get('root');
    const rp = this.restPos.get('root');
    this.root.children[0].position.y = 0;
    if (root && rp) {
      root.position.set(rp.x + P[CH.bodyX], rp.y + P[CH.bodyY], rp.z - P[CH.bodyF]);
      // the root bone points forwards: X = right, Y = forwards, Z = up. Turn first, then tip, then roll.
      this.turn('root', P[CH.bodyPitch], P[CH.bodyRoll], P[CH.bodyYaw], 'ZXY');
    }
    const J = this.joints;
    if (J) {
      this.bend(J.hips, P[CH.hipsB], P[CH.hipsT], P[CH.hipsS]);
      this.bend(J.spine1, P[CH.sp1B], P[CH.sp1T], P[CH.sp1S]);
      this.bend(J.spine2, P[CH.sp2B], P[CH.sp2T], P[CH.sp2S]);
      this.bend(J.chest, P[CH.chestB], P[CH.chestT], P[CH.chestS]);
      this.bend(J.neck, P[CH.neckB], P[CH.neckT], P[CH.neckS]);
      this.bend(J.head, P[CH.headB], P[CH.headT], P[CH.headS]);
      this.bend(J.jaw, P[CH.jaw]);
      this.bend(J.earL, -P[CH.earLBack], P[CH.earLTurn], P[CH.earLOut]);
      this.bend(J.earR, -P[CH.earRBack], -P[CH.earRTurn], -P[CH.earROut]);
      for (let i = 0; i < 5; i++) this.bend(J.tail[i], P[TAIL.lift[i]], 0, P[TAIL.side[i]]);
      for (let s = 0; s < 2; s++) {
        const F = FRONT[s];
        const H = HIND[s];
        const j = J.legs[s];
        this.bend(j.scapula, P[F.scap], 0, P[F.scapOut]);
        this.bend(j.upperarm, P[F.upper], 0, P[F.upperOut]);
        this.bend(j.forearm, P[F.fore]);
        this.bend(j.wrist, P[F.wrist]);
        this.bend(j.paw, P[F.paw]);
        this.bend(j.thigh, P[H.thigh], 0, P[H.thighOut]);
        this.bend(j.shin, P[H.shin]);
        this.bend(j.hock, P[H.hock]);
        this.bend(j.hindpaw, P[H.paw]);
      }
    }

    // far away nobody sees the paws: skip the reaching maths
    if (this.root.visible && this.limbs.length) {
      this.root.updateMatrixWorld(true);
      const still = clamp(Math.min(P[FRONT[0].ik], P[FRONT[1].ik]), 0, 1);
      if (this.carriesCamera && root && rp && still > 0.01) {
        // the camera hangs from this neck: keep the neck where the body offset alone would put it, so that
        // tipping the body back or forwards moves the hind end and the paws stay on the ground
        const n = this.neck ?? root;
        const at = this.root.worldToLocal(this.v0.setFromMatrixPosition(n.matrixWorld));
        root.position.x += (this.neckRest.x + P[CH.bodyX] - at.x) * still;
        root.position.y += (this.neckRest.y + P[CH.bodyY] - at.y) * still;
        root.position.z += (this.neckRest.z - P[CH.bodyF] - at.z) * still;
        this.root.updateMatrixWorld(true);
      }
      this.aimHead(P);
      for (let i = 0; i < this.limbs.length; i++) this.reach(this.limbs[i], P);
    }

    // ---- fur: stands on end when scared, trails behind when running
    this.fur.uniforms.uPuff.value = look.puff * m.puffScale;
    this.root.getWorldPosition(this.q0);
    if (dt > 0) {
      const vx = (this.q0.x - this.lastPos.x) / dt;
      const vz = (this.q0.z - this.lastPos.z) / dt;
      this.lag.set(clamp(-vx * 0.045, -0.5, 0.5), -0.28, clamp(-vz * 0.045, -0.5, 0.5));
    }
    this.lastPos.copy(this.q0);
  }

  /** Point the head where the pose wants it in the cat's own space, whatever the neck and body are doing. */
  private aimHead(P: Float32Array): void {
    const head = this.headBone;
    const w = P[CH.gaze];
    if (!head || !head.parent || w < 0.001) return;
    // cat space: yaw about up (+ = left), pitch about right (+ = nose up), roll about forwards (+ = top to the right)
    this.e2.set(P[CH.headP], P[CH.headY], -P[CH.headR], 'YXZ');
    const want = this.q1.copy(this.root.quaternion).multiply(this.q2.setFromEuler(this.e2)).multiply(this.headRest);
    head.parent.matrixWorld.decompose(this.v0, this.q3, this.v1);
    const local = this.q3.invert().multiply(want);
    head.quaternion.slerp(local, clamp(w, 0, 1));
  }

  /**
   * Two-bone reach: put the leg's end joint (front wrist, hind ankle) on the pose's target, bending the
   * middle joint towards the pose's pole, then set the foot's angle to the ground. Blended with the
   * joint angles already on the bones by the pose's `ik` weight.
   */
  private reach(limb: Limb, P: Float32Array): void {
    const front = limb.bend > 0;
    const si = limb.side;
    const w = clamp(front ? P[FRONT[si].ik] : P[HIND[si].ik], 0, 1);
    if (w < 0.001) return;
    const sx = si === 0 ? -1 : 1;
    const { upper, lower, end, l1, l2 } = limb;
    const rootQ = this.root.quaternion;
    // shoulder / hip, target and pole, all in world space
    const S = this.v0.setFromMatrixPosition(upper.matrixWorld);
    const T = this.v1;
    const pole = this.v2;
    if (front) {
      const F = FRONT[si];
      this.root.localToWorld(T.set(P[F.x], P[F.y], -P[F.f]));
      pole.set(P[F.px], P[F.py], -P[F.pf]).applyQuaternion(rootQ);
    } else {
      const H = HIND[si];
      this.root.localToWorld(T.set(P[H.x], P[H.y], -P[H.f]));
      pole.set(sx * P[H.knee], 0, -1).applyQuaternion(rootQ);
    }
    const d = this.v3.subVectors(T, S);
    let dist = d.length();
    if (dist < 1e-5) return;
    d.divideScalar(dist);
    dist = clamp(dist, Math.abs(l1 - l2) + 0.004, (l1 + l2) * 0.997);
    // the pole, made square to the reach direction
    pole.addScaledVector(d, -pole.dot(d));
    if (pole.lengthSq() < 1e-8) {
      pole.set(0, 0, front ? 1 : -1).applyQuaternion(rootQ);
      pole.addScaledVector(d, -pole.dot(d));
    }
    pole.normalize();
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    // both bones bend about the same axis, square to the plane of the leg
    const n = this.v5.crossVectors(pole, d).normalize().multiplyScalar(limb.bend);
    // upper bone: towards the elbow / knee
    const yU = this.v4.copy(d).multiplyScalar(a).addScaledVector(pole, h).normalize();
    this.m0.makeBasis(n, yU, this.v6.crossVectors(n, yU));
    const wantU = this.q1.setFromRotationMatrix(this.m0).multiply(limb.offU);
    upper.parent!.matrixWorld.decompose(this.v6, this.q2, this.v7);
    upper.quaternion.slerp(this.q3.copy(this.q2).invert().multiply(wantU), w);
    const upperQ = this.q2.multiply(upper.quaternion); // the upper bone's world turn now
    // lower bone: from the elbow / knee on to the target
    const yL = this.v4.copy(d).multiplyScalar(dist - a).addScaledVector(pole, -h).normalize();
    this.m0.makeBasis(n, yL, this.v6.crossVectors(n, yL));
    const wantL = this.q1.setFromRotationMatrix(this.m0).multiply(limb.offL);
    lower.quaternion.slerp(this.q3.copy(upperQ).invert().multiply(wantL), w);
    const lowerQ = upperQ.multiply(lower.quaternion); // the lower bone's world turn now
    // the foot: keeps its own angle to the ground (planted), turned with the stance
    const plant = clamp(front ? P[FRONT[si].plant] : P[HIND[si].plant], 0, 1) * w;
    if (plant > 0.001) {
      const tip = front ? 0 : P[HIND[si].hockAbs];
      this.e2.set(tip, P[CH.bodyYaw], 0, 'YXZ');
      const wantE = this.q1.copy(rootQ).multiply(this.q4.setFromEuler(this.e2)).multiply(limb.endRest);
      // on top of that, whatever bend the pose gave the foot bone
      const extra = this.q4.copy(end.quaternion).premultiply(limb.endLocalInv);
      const local = this.q3.copy(lowerQ).invert().multiply(wantE).multiply(extra);
      end.quaternion.slerp(local, plant);
    }
  }

  private readonly q0 = new THREE.Vector3();
}
