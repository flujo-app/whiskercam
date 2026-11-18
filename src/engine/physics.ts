import RAPIER from '@dimforge/rapier3d-compat';

/** Collision layers (who is what, and what it bumps into). */
export const G = { WORLD: 1, SOFT: 2, PROP: 4, PLAYER: 8, NPC: 16 } as const;
const groups = (member: number, filter: number): number => (member << 16) | filter;

interface CollisionIndex {
  surfaces: string[];
  groups: Record<'solid' | 'soft', { vertices: number; triangles: number; pos: number; idx: number; surf: number }>;
}

export interface GroundHit {
  y: number;
  surface: string;
  nx: number;
  ny: number;
  nz: number;
}

export interface RayHit {
  /** distance along the ray */
  toi: number;
  nx: number;
  ny: number;
  nz: number;
  /** what the surface is made of ('wood' can be climbed) */
  surface: string;
}

/** How hard the cat is pulled down: going up, hanging at the top of a jump, coming down (metres per second squared). */
export const GRAVITY = { rise: 24, hang: 15, fall: 34, hangBand: 1.0, maxFall: 15 } as const;

/** The solid world: what the cat stands on and bumps into. */
export class Physics {
  readonly R = RAPIER;
  readonly world: RAPIER.World;
  /** which kind of surface each solid collision mesh is (one mesh per kind) */
  private readonly surfaceOf = new Map<number, string>();
  private soft: RAPIER.Collider | null = null;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly balls = new Map<number, RAPIER.Ball>();
  private readonly hitOut: RayHit = { toi: 0, nx: 0, ny: 0, nz: 0, surface: 'plaster' };
  private readonly nearOut = { x: 0, y: 0, z: 0, dist: 0 };
  private readonly at = { x: 0, y: 0, z: 0 };
  private readonly noTurn = { x: 0, y: 0, z: 0, w: 1 };

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
  }

  static async create(base: string): Promise<Physics> {
    await RAPIER.init();
    const p = new Physics();
    const [index, blob] = await Promise.all([
      fetch(`${base}collision.json`).then((r) => r.json() as Promise<CollisionIndex>),
      fetch(`${base}collision.bin`).then((r) => r.arrayBuffer()),
    ]);
    const fixed = p.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const key of ['solid', 'soft'] as const) {
      const g = index.groups[key];
      if (!g || g.triangles === 0) continue;
      const pos = new Float32Array(blob, g.pos, g.vertices * 3);
      const idx = new Uint32Array(blob, g.idx, g.triangles * 3);
      if (key === 'soft') {
        const desc = RAPIER.ColliderDesc.trimesh(pos, idx);
        desc.setCollisionGroups(groups(G.SOFT, 0xffff)).setSensor(true);
        p.soft = p.world.createCollider(desc, fixed);
        continue;
      }
      // One mesh per kind of surface, so that whatever a ray or a paw touches says what it is made of
      // (paw sounds; wood can be climbed). The physics library cannot say which triangle of a mesh was hit.
      const surf = new Uint8Array(blob.slice(g.surf, g.surf + g.triangles));
      const kinds = new Map<number, number[]>();
      for (let t = 0; t < g.triangles; t++) {
        let list = kinds.get(surf[t]);
        if (!list) kinds.set(surf[t], (list = []));
        list.push(t);
      }
      for (const [sid, tris] of kinds) {
        const remap = new Map<number, number>();
        const verts: number[] = [];
        const faces = new Uint32Array(tris.length * 3);
        tris.forEach((t, n) => {
          for (let k = 0; k < 3; k++) {
            const old = idx[t * 3 + k];
            let now = remap.get(old);
            if (now === undefined) {
              now = verts.length / 3;
              remap.set(old, now);
              verts.push(pos[old * 3], pos[old * 3 + 1], pos[old * 3 + 2]);
            }
            faces[n * 3 + k] = now;
          }
        });
        // "fix internal edges": without it the cat can catch on the seams between triangles of a flat surface
        const desc = RAPIER.ColliderDesc.trimesh(new Float32Array(verts), faces, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
        desc.setCollisionGroups(groups(G.WORLD, 0xffff)).setFriction(0.9);
        const collider = p.world.createCollider(desc, fixed);
        p.surfaceOf.set(collider.handle, index.surfaces[sid] ?? 'plaster');
      }
    }
    p.world.step();
    return p;
  }

  step(): void {
    this.world.step();
  }

  private aim(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    this.ray.origin.x = ox;
    this.ray.origin.y = oy;
    this.ray.origin.z = oz;
    this.ray.dir.x = dx;
    this.ray.dir.y = dy;
    this.ray.dir.z = dz;
  }

  /** Look straight down from (x, yFrom, z); returns the first solid ground within `reach` metres. */
  groundBelow(x: number, yFrom: number, z: number, reach = 3): GroundHit | null {
    this.aim(x, yFrom, z, 0, -1, 0);
    const hit = this.world.castRayAndGetNormal(this.ray, reach, true, undefined, groups(G.NPC, G.WORLD));
    if (!hit) return null;
    const surface = this.surfaceOf.get(hit.collider.handle) ?? 'asphalt';
    return { y: yFrom - hit.timeOfImpact, surface, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z };
  }

  /**
   * The spot on any solid surface that is nearest to (x, y, z), in whatever direction, and how far away it
   * is. (The returned object is reused: read it before asking again.)
   */
  nearestSurface(x: number, y: number, z: number): { x: number; y: number; z: number; dist: number } | null {
    const p = this.ray.origin;
    p.x = x;
    p.y = y;
    p.z = z;
    const hit = this.world.projectPoint(p, false, undefined, groups(G.NPC, G.WORLD | G.PROP));
    if (!hit) return null;
    const o = this.nearOut;
    o.x = hit.point.x;
    o.y = hit.point.y;
    o.z = hit.point.z;
    o.dist = Math.hypot(x - o.x, y - o.y, z - o.z);
    return o;
  }

  /** Distance to the first solid thing along a ray, or `max` when nothing is hit. */
  rayDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    this.aim(ox, oy, oz, dx, dy, dz);
    const hit = this.world.castRay(this.ray, max, true, undefined, groups(G.NPC, G.WORLD | G.PROP));
    return hit ? hit.timeOfImpact : max;
  }

  /** First solid thing along a ray: how far away it is, which way its surface faces, what it is made of. */
  rayHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, withProps = false): RayHit | null {
    this.aim(ox, oy, oz, dx, dy, dz);
    const hit = this.world.castRayAndGetNormal(this.ray, max, true, undefined, groups(G.NPC, withProps ? G.WORLD | G.PROP : G.WORLD));
    if (!hit) return null;
    const o = this.hitOut;
    o.toi = hit.timeOfImpact;
    o.nx = hit.normal.x;
    o.ny = hit.normal.y;
    o.nz = hit.normal.z;
    o.surface = this.surfaceOf.get(hit.collider.handle) ?? 'plaster';
    return o;
  }

  /**
   * Is this point inside something solid (a car body, a wall, a kerb, or under the ground)?
   * Counted the classic way: go straight up and count the surfaces crossed; an odd number means inside.
   * Rays that start inside a hollow shape find the inside of its floor or walls, so anything that looks for
   * ground or for room to put the lens asks this first.
   */
  insideSolid(x: number, y: number, z: number): boolean {
    // a slight lean, so the ray does not run exactly along the edges of box-shaped things
    const dx = 0.0131;
    const dy = 0.99988;
    const dz = 0.0077;
    let ox = x;
    let oy = y;
    let oz = z;
    let crossings = 0;
    for (let i = 0; i < 12; i++) {
      this.aim(ox, oy, oz, dx, dy, dz);
      const hit = this.world.castRay(this.ray, 60, false, undefined, groups(G.NPC, G.WORLD));
      if (!hit) break;
      crossings++;
      const step = hit.timeOfImpact + 0.002;
      ox += dx * step;
      oy += dy * step;
      oz += dz * step;
    }
    return (crossings & 1) === 1;
  }

  /** Is there room for a ball of this size here (no solid surface passes through it)? */
  freeAt(x: number, y: number, z: number, radius: number): boolean {
    let ball = this.balls.get(radius);
    if (!ball) this.balls.set(radius, (ball = new RAPIER.Ball(radius)));
    this.at.x = x;
    this.at.y = y;
    this.at.z = z;
    let free = true;
    this.world.intersectionsWithShape(
      this.at,
      this.noTurn,
      ball,
      () => {
        free = false;
        return false;
      },
      undefined,
      groups(G.NPC, G.WORLD),
    );
    return free;
  }

  /** Is the point inside something soft (a hedge)? */
  insideSoft(x: number, y: number, z: number, radius: number): boolean {
    if (!this.soft) return false;
    let ball = this.balls.get(radius);
    if (!ball) this.balls.set(radius, (ball = new RAPIER.Ball(radius)));
    this.at.x = x;
    this.at.y = y;
    this.at.z = z;
    let found = false;
    this.world.intersectionsWithShape(
      this.at,
      this.noTurn,
      ball,
      () => {
        found = true;
        return false;
      },
      undefined,
      groups(G.NPC, G.SOFT),
    );
    return found;
  }
}

/** A small ball that walks, steps up kerbs, falls and jumps: the cat's contact with the world. */
export class CharacterBody {
  readonly radius: number;
  x = 0;
  y = 0; // centre of the ball
  z = 0;
  vy = 0;
  grounded = false;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly cc: RAPIER.KinematicCharacterController;
  private readonly delta = { x: 0, y: 0, z: 0 };
  private pendingLift = 0;
  /** seconds left of being carried at step height (see `lift`) */
  private hover = 0;
  /** how much of the last sideways move was stopped by something, and in which direction (unit vector) */
  blocked = 0;
  blockX = 0;
  blockZ = 0;

  constructor(private readonly physics: Physics, radius = 0.075) {
    this.radius = radius;
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    this.collider = physics.world.createCollider(
      R.ColliderDesc.ball(radius).setCollisionGroups(groups(G.PLAYER, G.WORLD | G.PROP)),
      this.body,
    );
    this.cc = physics.world.createCharacterController(0.012);
    this.cc.enableAutostep(0.2, 0.03, false);
    this.cc.enableSnapToGround(0.22);
    this.cc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.cc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.cc.setApplyImpulsesToDynamicBodies(true);
    this.cc.setCharacterMass(4.2);
  }

  /** Feet position (the lowest point of the ball). */
  get feetY(): number {
    return this.y - this.radius;
  }

  teleport(x: number, feetY: number, z: number): void {
    this.x = x;
    this.y = feetY + this.radius + 0.01;
    this.z = z;
    this.vy = 0;
    this.body.setTranslation({ x: this.x, y: this.y, z: this.z }, true);
    this.body.setNextKinematicTranslation({ x: this.x, y: this.y, z: this.z });
  }

  /** Take off. The caller decides whether a jump is allowed right now. */
  jump(speed: number): void {
    this.vy = speed;
    this.grounded = false;
    this.hover = 0;
  }

  /** The jump button was let go early: stop rising so fast (a short hop instead of a full leap). */
  cutJump(to: number): void {
    if (!this.grounded && this.vy > to) this.vy = to;
  }

  /**
   * Step up onto something low just ahead: rise by `dy` on the next move and be carried at that height for a
   * moment, long enough to get the paws onto it. This is what takes kerbs and stairs smoothly at any angle.
   */
  lift(dy: number): void {
    this.pendingLift = Math.max(this.pendingLift, dy);
  }

  /** Put the ball somewhere without checking for collisions (scripted moves such as scrambling onto a ledge). */
  setPosition(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vy = 0;
    this.hover = 0;
    this.grounded = false;
    this.body.setNextKinematicTranslation({ x, y, z });
  }

  /** Move by (dx, dz) metres this step; gravity and jumping are handled here. Returns the distance really covered. */
  move(dx: number, dz: number, dt: number): number {
    const lift = this.pendingLift;
    this.pendingLift = 0;
    if (lift > 0) this.hover = 0.13;
    const stepping = this.hover > 0;
    if (stepping) {
      this.hover -= dt;
      this.vy = 0;
    } else {
      const G_ = GRAVITY;
      const g = this.grounded ? G_.fall : this.vy > G_.hangBand ? G_.rise : this.vy > -G_.hangBand ? G_.hang : G_.fall;
      this.vy = Math.max(-G_.maxFall, this.vy - g * dt);
      if (this.grounded && this.vy < 0) this.vy = -0.6;
    }
    this.delta.x = dx;
    this.delta.y = this.vy * dt + lift;
    this.delta.z = dz;
    const rising = this.vy > 0.5;
    if (rising || stepping) this.cc.disableSnapToGround();
    else this.cc.enableSnapToGround(this.grounded ? 0.22 : 0.04);
    this.cc.computeColliderMovement(this.collider, this.delta, undefined, groups(G.PLAYER, G.WORLD | G.PROP));
    const m = this.cc.computedMovement();
    // while being carried up a step the cat counts as having its paws down
    this.grounded = stepping || (this.cc.computedGrounded() && !rising);
    if (this.grounded && this.vy < 0) this.vy = 0;
    if (!this.grounded && this.vy > 0 && m.y < this.delta.y * 0.5) this.vy = 0; // bumped the head
    // how much of the sideways move something took away, and where that something is
    const want = Math.hypot(dx, dz);
    if (want > 1e-5) {
      const bx = dx - m.x;
      const bz = dz - m.z;
      const b = Math.hypot(bx, bz);
      this.blocked = b / want;
      if (b > 1e-6) {
        this.blockX = bx / b;
        this.blockZ = bz / b;
      }
    } else {
      this.blocked = 0;
    }
    this.x += m.x;
    this.y += m.y;
    this.z += m.z;
    this.body.setNextKinematicTranslation({ x: this.x, y: this.y, z: this.z });
    return Math.hypot(m.x, m.z);
  }

  /** Free height above the ball (how low the cat has to duck), up to `max` metres. */
  headroom(max: number): number {
    return this.physics.rayDistance(this.x, this.y, this.z, 0, 1, 0, max + this.radius) - this.radius;
  }
}
