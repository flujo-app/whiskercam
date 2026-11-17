// Surface shader for everything in the world.
//
// Light comes from three places:
//   1. the sun, per pixel (so bumps and gloss stay crisp), switched on and off by the baked
//      "how much sun reaches this spot" map and by the live shadow of moving things
//   2. baked sky + bounce light (the slow film-quality part, worked out in Blender)
//   3. mirror-like reflection of the surroundings, dimmed where the baked light says a spot is enclosed
//
// Light source variants (pick one with a #define):
//   LM_UV      baked maps, addressed by the mesh's second UV set          (buildings, kerbs, props)
//   LM_PLANAR  baked maps, addressed by world position (top-down)         (ground, markings, litter)
//   LM_VERTEX  baked into vertex colours                                  (leaves)
//   LM_PROBE   one value for the whole object, updated as it moves        (cats, loose things)

export const worldVertex = /* glsl */ `
precision highp float;

#ifdef USE_INSTANCING
  // instanceMatrix is declared by three.js
#endif

attribute vec2 uv1;
#ifdef LM_VERTEX
  attribute vec4 color;
  varying vec4 vBaked;
#endif

uniform vec2 uUvScale;
uniform vec4 uLmXform;      // LM_PLANAR: lm uv = world.xz * xy + zw
uniform float uTime;
uniform vec3 uWind;         // xy = direction on the ground plane, z = strength

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec2 vLmUv;

void main() {
  vec4 local = vec4(position, 1.0);
  mat4 world = modelMatrix;
  #ifdef USE_INSTANCING
    world = modelMatrix * instanceMatrix;
  #endif
  vec4 wp = world * local;
  vec3 n = normalize(mat3(world) * normal);

  #ifdef WIND
    // leaves and blades sway; anchored parts (low vertices in object space) move less
    float sway = uWind.z * clamp(position.y * WIND_HEIGHT_SCALE, 0.0, 1.0);
    float phase = dot(wp.xz, vec2(0.37, 0.53));
    wp.xz += uWind.xy * sway * (sin(uTime * 1.7 + phase) * 0.6 + sin(uTime * 4.3 + phase * 2.7) * 0.25);
    wp.y += sway * 0.2 * sin(uTime * 3.1 + phase * 1.9);
  #endif

  vWorldPos = wp.xyz;
  vNormal = n;
  vUv = uv * uUvScale;
  #if defined(LM_PLANAR)
    vLmUv = wp.xz * uLmXform.xy + uLmXform.zw;
  #elif defined(LM_UV)
    vLmUv = uv1;
  #else
    vLmUv = vec2(0.0);
  #endif
  #ifdef LM_VERTEX
    vBaked = color;
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const worldFragment = /* glsl */ `
precision highp float;

#define PI 3.141592653589793

uniform sampler2D uMapDiff;
uniform sampler2D uMapNor;
uniform sampler2D uMapArm;
uniform vec3 uColor;          // multiplies the diffuse picture (or is the colour when there is none)
uniform float uRough;         // multiplies ARM roughness (or is the roughness)
uniform float uMetal;
uniform float uNormalScale;
uniform float uDetail;        // strength of the close-up detail layer
uniform float uAlphaTest;

uniform sampler2D uLmSun;
uniform sampler2D uLmIrr;
uniform vec2 uLmSunSize;
uniform float uIrrRange;
uniform vec3 uProbeIrrUp;     // LM_PROBE: light on up-facing / down-facing surfaces
uniform vec3 uProbeIrrDown;
uniform float uProbeSun;

uniform vec3 uSunDir;
uniform vec3 uSunColor;       // irradiance on a surface facing the sun
uniform vec3 uSkyUp;          // white-surface brightness under the open sky (for "how enclosed is this spot")
uniform samplerCube uEnvMap;
uniform float uEnvMaxLod;
uniform float uEnvIntensity;
uniform vec3 uFogColor;
uniform float uFogDensity;

uniform sampler2D uShadowNear;   // live shadows of moving things (depth from the sun's point of view)
uniform sampler2D uShadowFar;
uniform mat4 uShadowNearMat;
uniform mat4 uShadowFarMat;
uniform vec2 uShadowTexel;       // 1/size of near, far
uniform float uShadowOn;

#ifdef PAINT
  uniform vec3 uPaintColor;
  uniform float uPaintWear;
#endif
#ifdef LM_VERTEX
  varying vec4 vBaked;
#endif

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec2 vLmUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// smoother than plain bilinear when a light map texel covers many screen pixels
float sampleSunSmooth(vec2 uv) {
  vec2 st = uv * uLmSunSize - 0.5;
  vec2 i = floor(st), f = fract(st);
  f = f * f * (3.0 - 2.0 * f);
  return texture2D(uLmSun, (i + f + 0.5) / uLmSunSize).r;
}

mat3 tangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-20);
  return mat3(T * invmax, B * invmax, N);
}

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}

float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / (gv + gl + 1e-5);
}

vec3 envBrdfApprox(vec3 f0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

float shadowTap(sampler2D map, vec3 sc) {
  return step(sc.z, texture2D(map, sc.xy).r);
}

float shadowPcf(sampler2D map, vec3 sc, float texel) {
  float s = 0.0;
  float j = hash12(gl_FragCoord.xy) * 6.2831;
  mat2 rot = mat2(cos(j), -sin(j), sin(j), cos(j));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(-0.94, -0.40) * texel, sc.z));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(0.95, -0.77) * texel, sc.z));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(-0.09, -0.93) * texel, sc.z));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(0.34, 0.29) * texel, sc.z));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(-0.92, 0.46) * texel, sc.z));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(-0.82, -0.88) * texel, sc.z));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(-0.38, 0.28) * texel, sc.z));
  s += shadowTap(map, vec3(sc.xy + rot * vec2(0.97, 0.45) * texel, sc.z));
  return s / 8.0;
}

float liveShadow(vec3 wp, vec3 n) {
  if (uShadowOn < 0.5) return 1.0;
  vec3 p = wp + n * 0.006;
  vec4 a = uShadowNearMat * vec4(p, 1.0);
  vec3 sa = a.xyz * 0.5 + 0.5;
  if (all(greaterThan(sa.xy, vec2(0.02))) && all(lessThan(sa.xy, vec2(0.98)))) {
    return shadowPcf(uShadowNear, vec3(sa.xy, sa.z - 0.0012), uShadowTexel.x * 1.6);
  }
  vec4 b = uShadowFarMat * vec4(p, 1.0);
  vec3 sb = b.xyz * 0.5 + 0.5;
  if (all(greaterThan(sb.xy, vec2(0.0))) && all(lessThan(sb.xy, vec2(1.0)))) {
    return shadowPcf(uShadowFar, vec3(sb.xy, sb.z - 0.002), uShadowTexel.y * 1.4);
  }
  return 1.0;
}

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  float dist = length(cameraPosition - vWorldPos);
  vec3 Ng = normalize(vNormal);
  #ifdef DOUBLE_SIDED
    if (!gl_FrontFacing) Ng = -Ng;
  #endif

  float alphaOut = 1.0;

  // ---- surface description
  #ifdef USE_MAP
    vec4 texel = texture2D(uMapDiff, vUv);
    #ifdef ALPHATEST
      if (texel.a < uAlphaTest) discard;
    #endif
    vec3 albedo = texel.rgb * uColor;
    vec3 arm = texture2D(uMapArm, vUv).rgb;
    vec3 nt = texture2D(uMapNor, vUv).xyz * 2.0 - 1.0;
    #ifdef DETAIL
      // close-up layer: the same scan again at a finer scale, faded in near the camera
      float k = uDetail * (1.0 - smoothstep(0.25, 2.6, dist));
      if (k > 0.001) {
        vec2 duv = vUv * 5.31 + 0.37;
        vec3 mean = texture2D(uMapDiff, vUv, 15.0).rgb + 0.004;
        vec3 fine = texture2D(uMapDiff, duv).rgb;
        albedo *= mix(vec3(1.0), clamp(fine / mean, 0.4, 1.9), k);
        vec3 nd = texture2D(uMapNor, duv).xyz * 2.0 - 1.0;
        nt = normalize(vec3(nt.xy + nd.xy * k, nt.z));
        arm.g = mix(arm.g, texture2D(uMapArm, duv).g, k * 0.6);
      }
    #endif
    float ao = arm.r;
    float rough = clamp(arm.g * uRough, 0.06, 1.0);
    float metal = arm.b * uMetal;
    nt.xy *= uNormalScale;
    nt.y = -nt.y;   // scans are OpenGL-style, glTF UVs run downwards
    vec3 N = normalize(tangentFrame(Ng, vWorldPos, vUv) * nt);
  #else
    vec3 albedo = uColor;
    float ao = 1.0;
    float rough = clamp(uRough, 0.06, 1.0);
    float metal = uMetal;
    vec3 N = Ng;
  #endif

  #ifdef PAINT
    // old road paint: chipped where the noise says so, a little glossier than the stone under it
    // (height is mixed in so upright faces such as kerb fronts get a pattern too)
    vec2 pp = vWorldPos.xz + vWorldPos.yy * vec2(1.7, 2.3);
    float chip = fbm(pp * 9.0) * 0.65 + fbm(pp * 41.0) * 0.35;
    float cover = smoothstep(uPaintWear - 0.08, uPaintWear + 0.10, chip);
    #ifdef DECAL
      // a marking lying on top of the road: only the paint that is left gets drawn
      if (cover < 0.02) discard;
      alphaOut = cover;
      albedo = uPaintColor * (0.85 + 0.3 * fbm(pp * 3.0));
      rough = 0.6;
    #else
      albedo = mix(albedo, uPaintColor * (0.85 + 0.3 * fbm(pp * 3.0)), cover);
      rough = mix(rough, 0.55, cover * 0.6);
    #endif
  #endif

  #ifdef MACRO
    // large-scale blotches so a tiled scan does not read as a pattern
    float blot = fbm(vWorldPos.xz * 0.21) * 0.6 + fbm(vWorldPos.xz * 1.3) * 0.4;
    albedo *= 0.86 + 0.28 * blot;
    rough = clamp(rough * (0.93 + 0.16 * blot), 0.06, 1.0);
  #endif

  // ---- baked light
  float sunVis = 1.0;
  vec3 irr = vec3(0.0);
  #if defined(LM_PLANAR)
    sunVis = sampleSunSmooth(vLmUv);
    vec3 e = texture2D(uLmIrr, vLmUv).rgb;
    irr = e * e * uIrrRange;
  #elif defined(LM_UV)
    sunVis = texture2D(uLmSun, vLmUv).r;
    vec3 e = texture2D(uLmIrr, vLmUv).rgb;
    irr = e * e * uIrrRange;
  #elif defined(LM_VERTEX)
    sunVis = vBaked.a;
    irr = vBaked.rgb * vBaked.rgb * uIrrRange;
  #else
    sunVis = uProbeSun;
    irr = mix(uProbeIrrDown, uProbeIrrUp, N.y * 0.5 + 0.5);
  #endif
  sunVis *= liveShadow(vWorldPos, Ng);

  // ---- sunlight
  vec3 L = uSunDir;
  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 diffuse = albedo * (1.0 - metal);
  vec3 H = normalize(L + V);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float a = rough * rough;
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
  vec3 spec = F * (D_GGX(NoH, a) * V_SmithGGX(NoV, NoL, a));
  vec3 color = (diffuse / PI + spec) * uSunColor * (NoL * sunVis);

  #ifdef TRANSLUCENT
    // sun shining through a leaf from behind
    float back = max(dot(-N, L), 0.0);
    color += diffuse * vec3(0.55, 0.75, 0.25) / PI * uSunColor * (back * sunVis * 0.55);
  #endif

  // ---- sky + bounce light
  color += diffuse * irr * ao;

  // ---- reflection of the surroundings
  float open = clamp(dot(irr, vec3(0.3, 0.5, 0.2)) / (dot(uSkyUp, vec3(0.3, 0.5, 0.2)) * mix(0.55, 1.0, N.y * 0.5 + 0.5)), 0.0, 1.0);
  vec3 R = reflect(-V, N);
  R = normalize(mix(R, N, a * a));
  float lod = uEnvMaxLod * rough * (2.0 - rough);
  vec3 env = textureLod(uEnvMap, R, lod).rgb * uEnvIntensity;
  float specOcc = clamp(pow(NoV + open * ao, exp2(-16.0 * rough - 1.0)) - 1.0 + open * ao, 0.0, 1.0);
  color += env * envBrdfApprox(f0, rough, NoV) * specOcc;

  #ifdef COAT
    // clear lacquer on car paint
    float Fc = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
    vec3 Rc = reflect(-V, Ng);
    color = color * (1.0 - Fc) + textureLod(uEnvMap, Rc, 0.6).rgb * uEnvIntensity * Fc * mix(0.35, 1.0, open);
    float NoHc = max(dot(Ng, H), 0.0);
    color += uSunColor * (max(dot(Ng, L), 0.0) * sunVis) * (0.04 + 0.96 * pow(1.0 - VoH, 5.0)) * D_GGX(NoHc, 0.0025) * 0.25;
  #endif

  // ---- thin haze with distance
  float fog = 1.0 - exp(-dist * uFogDensity);
  color = mix(color, uFogColor, fog);

  gl_FragColor = vec4(color, alphaOut);
}
`;
