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

/** The solid world: what the cat stands on and bumps into. */
export class Physics {
  readonly R = RAPIER;
  readonly world: RAPIER.World;
  private surfaces: string[] = [];
  private solidSurf: Uint8Array = new Uint8Array(0);
  private solid: RAPIER.Collider | null = null;
  private soft: RAPIER.Collider | null = null;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

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
    p.surfaces = index.surfaces;
    const fixed = p.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const key of ['solid', 'soft'] as const) {
      const g = index.groups[key];
      if (!g || g.triangles === 0) continue;
      const pos = new Float32Array(blob, g.pos, g.vertices * 3);
      const idx = new Uint32Array(blob, g.idx, g.triangles * 3);
      const desc = RAPIER.ColliderDesc.trimesh(pos, idx);
      if (key === 'solid') {
        desc.setCollisionGroups(groups(G.WORLD, 0xffff)).setFriction(0.9);
        p.solid = p.world.createCollider(desc, fixed);
        p.solidSurf = new Uint8Array(blob.slice(g.surf, g.surf + g.triangles));
      } else {
        desc.setCollisionGroups(groups(G.SOFT, 0xffff)).setSensor(true);
        p.soft = p.world.createCollider(desc, fixed);
      }
    }
    p.world.step();
    return p;
  }

  step(): void {
    this.world.step();
  }

  /** Look straight down from (x, yFrom, z); returns the first solid ground within `reach` metres. */
  groundBelow(x: number, yFrom: number, z: number, reach = 3): GroundHit | null {
    this.ray.origin.x = x;
    this.ray.origin.y = yFrom;
    this.ray.origin.z = z;
    this.ray.dir.x = 0;
    this.ray.dir.y = -1;
    this.ray.dir.z = 0;
    const hit = this.world.castRayAndGetNormal(this.ray, reach, true, undefined, groups(G.NPC, G.WORLD));
    if (!hit) return null;
    let surface = 'asphalt';
    if (hit.collider === this.solid && hit.featureId !== undefined && hit.featureId < this.solidSurf.length) {
      surface = this.surfaces[this.solidSurf[hit.featureId]] ?? surface;
    }
    return { y: yFrom - hit.timeOfImpact, surface, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z };
  }

  /** Distance to the first solid thing along a ray, or `max` when nothing is hit. */
  rayDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    this.ray.origin.x = ox;
    this.ray.origin.y = oy;
    this.ray.origin.z = oz;
    this.ray.dir.x = dx;
    this.ray.dir.y = dy;
    this.ray.dir.z = dz;
    const hit = this.world.castRay(this.ray, max, true, undefined, groups(G.NPC, G.WORLD | G.PROP));
    return hit ? hit.timeOfImpact : max;
  }

  /** Is the point inside something soft (a hedge)? */
  insideSoft(x: number, y: number, z: number, radius: number): boolean {
    if (!this.soft) return false;
    let found = false;
    this.world.intersectionsWithShape(
      { x, y, z },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Ball(radius),
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

  constructor(private readonly physics: Physics, radius = 0.075) {
    this.radius = radius;
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    this.collider = physics.world.createCollider(
      R.ColliderDesc.ball(radius).setCollisionGroups(groups(G.PLAYER, G.WORLD | G.PROP)),
      this.body,
    );
    this.cc = physics.world.createCharacterController(0.012);
    this.cc.enableAutostep(0.19, 0.04, false);
    this.cc.enableSnapToGround(0.1);
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

  jump(speed: number): void {
    if (this.grounded) {
      this.vy = speed;
      this.grounded = false;
    }
  }

  /** Move by (dx, dz) metres this step; gravity and jumping are handled here. Returns the distance really covered. */
  move(dx: number, dz: number, dt: number): number {
    this.vy -= 9.81 * 1.6 * dt; // cats come down fast; a little extra gravity reads better at this scale
    if (this.grounded && this.vy < 0) this.vy = -0.6;
    this.delta.x = dx;
    this.delta.y = this.vy * dt;
    this.delta.z = dz;
    const rising = this.vy > 0.5;
    if (rising) this.cc.disableSnapToGround();
    else this.cc.enableSnapToGround(0.1);
    this.cc.computeColliderMovement(this.collider, this.delta, undefined, groups(G.PLAYER, G.WORLD | G.PROP));
    const m = this.cc.computedMovement();
    this.grounded = this.cc.computedGrounded() && !rising;
    if (this.grounded && this.vy < 0) this.vy = 0;
    if (!this.grounded && this.vy > 0 && m.y < this.delta.y * 0.5) this.vy = 0; // bumped the head
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
