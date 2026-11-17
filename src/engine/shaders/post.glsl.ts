// The "camera" part of the picture: everything a small action camera does to a scene.
//
//   lens     two flat renders (one tilted up, one tilted down) -> one fisheye picture + how far each pixel moved
//   blur     smear along the movement (shutter open while the cat runs)
//   bloom    glow around very bright things
//   meter    automatic exposure, like a phone: slow to settle, blown out when leaving shade
//   finish   exposure, tone curve, colour punch, sharpening halo, grain, dark corners

export const fullscreenVertex = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const lensFragment = /* glsl */ `
precision highp float;
layout(location = 0) out highp vec4 outColor;
layout(location = 1) out highp vec4 outVelocity;

uniform sampler2D uColUp;
uniform sampler2D uColDown;
uniform sampler2D uDepthUp;
uniform sampler2D uDepthDown;
uniform vec2 uTan;            // half-size of each view at distance 1 (x, y)
uniform float uPitch;         // how far the two views are tilted up / down (radians)
uniform vec2 uFrame;          // half picture size in "diagonal = 1" units
uniform float uSinHalfMax;    // sin(half of the corner-to-corner field of view / 2)
uniform vec2 uNearFar;
uniform mat4 uRigWorld;       // camera rig -> world
uniform mat4 uPrevRigInv;     // world -> where the rig was one shutter time ago
uniform float uVelScale;
uniform vec3 uFringe;         // colour fringing: radial scale per channel

varying vec2 vUv;

vec3 lensDir(vec2 p) {
  float r = length(p);
  float s = clamp(r * uSinHalfMax, 0.0, 0.9995);
  float theta = 2.0 * asin(s);
  vec2 d = r > 1e-6 ? p / r : vec2(0.0);
  return vec3(d * sin(theta), -cos(theta));
}

vec2 lensProject(vec3 dir) {
  float theta = acos(clamp(-dir.z, -1.0, 1.0));
  float r = sin(theta * 0.5) / uSinHalfMax;
  float l = length(dir.xy);
  return l > 1e-6 ? dir.xy / l * r : vec2(0.0);
}

// rig direction -> uv in the up or down view (and which one)
vec2 viewUv(vec3 dir, out float up) {
  up = step(0.0, dir.y);
  float a = up > 0.5 ? uPitch : -uPitch;
  float c = cos(a), s = sin(a);
  vec3 local = vec3(dir.x, c * dir.y + s * dir.z, -s * dir.y + c * dir.z);
  vec2 ndc = local.xy / max(-local.z, 1e-4) / uTan;
  return ndc * 0.5 + 0.5;
}

vec3 sampleScene(vec3 dir) {
  float up;
  vec2 uv = viewUv(dir, up);
  return up > 0.5 ? texture(uColUp, uv).rgb : texture(uColDown, uv).rgb;
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uFrame;
  vec3 dir = lensDir(p);

  // colour, with a little fringing towards the corners
  vec3 col;
  col.g = sampleScene(dir).g;
  col.r = sampleScene(lensDir(p * uFringe.r)).r;
  col.b = sampleScene(lensDir(p * uFringe.b)).b;

  // where was this point one shutter time ago?
  float up;
  vec2 uv = viewUv(dir, up);
  float depth = up > 0.5 ? texture(uDepthUp, uv).r : texture(uDepthDown, uv).r;
  vec3 prevDir;
  if (depth > 0.99999) {
    prevDir = mat3(uPrevRigInv) * (mat3(uRigWorld) * dir);
  } else {
    float zn = depth * 2.0 - 1.0;
    float viewZ = 2.0 * uNearFar.x * uNearFar.y / ((uNearFar.y + uNearFar.x) - zn * (uNearFar.y - uNearFar.x));
    float a = up > 0.5 ? uPitch : -uPitch;
    float c = cos(a), s = sin(a);
    vec3 local = vec3(dir.x, c * dir.y + s * dir.z, -s * dir.y + c * dir.z);
    vec3 rigPos = dir * (viewZ / max(-local.z, 1e-4));
    vec4 world = uRigWorld * vec4(rigPos, 1.0);
    prevDir = (uPrevRigInv * world).xyz;
  }
  prevDir = normalize(prevDir);
  vec2 prevUv = lensProject(prevDir) / uFrame * 0.5 + 0.5;
  vec2 vel = (vUv - prevUv) * uVelScale;
  if (prevDir.z > -0.05) vel = vec2(0.0);   // came from behind the lens: no sensible streak

  outColor = vec4(col, 1.0);
  outVelocity = vec4(vel, depth, 1.0);
}
`;

export const blurFragment = /* glsl */ `
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uVelocity;  // xy = how far the pixel moved, z = depth
uniform float uMaxBlur;       // longest streak, as a fraction of the picture
uniform float uSeed;
uniform vec2 uNearFar;
uniform float uFocusNear;     // closer than this (metres) the fixed-focus lens goes soft
uniform float uNearBlur;      // blur radius right at the lens, as a fraction of the picture width
uniform vec2 uAspect;         // (1, width / height)
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float nearness(vec2 uv) {
  float d = textureLod(uVelocity, uv, 0.0).z;
  float zn = d * 2.0 - 1.0;
  float z = 2.0 * uNearFar.x * uNearFar.y / ((uNearFar.y + uNearFar.x) - zn * (uNearFar.y - uNearFar.x));
  return clamp(1.0 - z / uFocusNear, 0.0, 1.0);
}

void main() {
  vec3 vd = textureLod(uVelocity, vUv, 0.0).xyz;
  vec2 vel = vd.xy;
  float len = length(vel);
  if (len > uMaxBlur) vel *= uMaxBlur / len;
  float j = hash12(gl_FragCoord.xy + uSeed);

  // things right in front of the lens (the chin, whiskers, leaves brushing past) are out of focus;
  // look around a little so their soft edges also spread over what is behind them
  float near = nearness(vUv);
  float ang0 = j * 6.2831;
  for (int i = 0; i < 4; i++) {
    float a = ang0 + float(i) * 1.5708;
    near = max(near, 0.8 * nearness(vUv + vec2(cos(a), sin(a)) * uAspect * uNearBlur * 0.6));
  }
  float radius = uNearBlur * near * near;

  if (len < 0.0006 && radius < 0.0008) {
    gl_FragColor = vec4(textureLod(uColor, vUv, 0.0).rgb, 1.0);
    return;
  }
  const int N = 14;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float f = (float(i) + 0.5) / float(N);
    float t = f + (j - 0.5) / float(N) - 0.5;
    // golden-angle spiral for the out-of-focus disc, a straight line for the motion streak
    float a = float(i) * 2.39996 + ang0;
    vec2 disc = vec2(cos(a), sin(a)) * sqrt(f) * radius * uAspect;
    acc += textureLod(uColor, vUv - vel * t + disc, 0.0).rgb;
  }
  gl_FragColor = vec4(acc / float(N), 1.0);
}
`;

export const downFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;     // > 0 on the first step: keep only what is brighter than this (after exposure)
uniform sampler2D uMeter;
uniform float uKey;
varying vec2 vUv;
void main() {
  vec3 a = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 e = texture2D(uTex, vUv).rgb;
  vec3 col = (a + b + c + d) * 0.125 + e * 0.5;
  if (uThreshold > 0.0) {
    col *= clamp(uKey / max(texture2D(uMeter, vec2(0.5)).r, 1e-4), 0.02, 40.0);
    float l = max(col.r, max(col.g, col.b));
    col *= clamp((l - uThreshold) / max(l, 1e-4), 0.0, 1.0);
    col = min(col, vec3(40.0));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const upFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex;      // smaller level
uniform sampler2D uBase;     // this level
uniform vec2 uTexel;
uniform float uMix;
varying vec2 vUv;
void main() {
  vec3 s = vec3(0.0);
  s += texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  s += texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(0.0, -1.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(0.0, 1.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(-1.0, 0.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(1.0, 0.0)).rgb;
  s += 4.0 * texture2D(uTex, vUv).rgb;
  gl_FragColor = vec4(mix(texture2D(uBase, vUv).rgb, s / 16.0, uMix), 1.0);
}
`;

export const meterFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex;       // small, already averaged picture of the scene
uniform sampler2D uPrev;      // last frame's reading
uniform float uBlendBrighter; // how fast to follow when the scene gets brighter (0 = never, 1 = at once)
uniform float uBlendDarker;
varying vec2 vUv;
void main() {
  float sum = 0.0, wsum = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 6; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(6.0, 8.0);
      vec3 c = textureLod(uTex, uv, 5.0).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // phones weigh the middle and the lower part (the subject) more than the sky
      float w = 1.0 - 0.55 * smoothstep(0.55, 1.0, uv.y);
      w *= 1.0 - 0.3 * abs(uv.x - 0.5) * 2.0;
      sum += log(max(l, 1e-4)) * w;
      wsum += w;
    }
  }
  float now = exp(sum / wsum);
  float prev = texture2D(uPrev, vec2(0.5)).r;
  float v = prev <= 0.0 ? now : mix(prev, now, now > prev ? uBlendBrighter : uBlendDarker);
  gl_FragColor = vec4(v, v, v, 1.0);
}
`;

export const finishFragment = /* glsl */ `
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uBloom;
uniform sampler2D uMeter;
uniform vec2 uTexel;
uniform float uKey;           // how bright the picture should end up on average
uniform float uExposureBias;
uniform float uBloomAmount;
uniform float uTime;
uniform float uGrain;
uniform float uSharpen;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uWhiteBalance;
uniform vec2 uFrame;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// filmic shoulder: bright things roll off to white instead of clipping hard
vec3 curve(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture2D(uColor, vUv).rgb;

  // unsharp mask: the slight bright/dark outline phone cameras put on edges
  vec3 around = texture2D(uColor, vUv + uTexel * vec2(1.2, 0.0)).rgb + texture2D(uColor, vUv - uTexel * vec2(1.2, 0.0)).rgb
              + texture2D(uColor, vUv + uTexel * vec2(0.0, 1.2)).rgb + texture2D(uColor, vUv - uTexel * vec2(0.0, 1.2)).rgb;
  hdr = max(hdr + (hdr - around * 0.25) * uSharpen, 0.0);

  float metered = max(texture2D(uMeter, vec2(0.5)).r, 1e-4);
  float exposure = clamp(uKey / metered, 0.02, 40.0) * uExposureBias;
  vec3 c = (hdr * exposure + texture2D(uBloom, vUv).rgb * uBloomAmount) * uWhiteBalance;

  // dark corners
  vec2 p = (vUv * 2.0 - 1.0) * uFrame;
  float r2 = dot(p, p);
  c *= 1.0 - uVignette * smoothstep(0.25, 1.15, r2);

  c = curve(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);

  // sensor noise: more in the dark parts, different every frame
  float n = hash12(gl_FragCoord.xy + fract(uTime) * 311.7) - 0.5;
  c += n * uGrain * (1.0 - 0.6 * l);

  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(c, 1.0);
}
`;

export const skyVertex = /* glsl */ `
precision highp float;
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;

export const skyFragment = /* glsl */ `
precision highp float;
uniform sampler2D uSky;
uniform float uSkyRange;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec2 uv = vec2(atan(d.z, d.x) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.141592653589793);
  vec3 t = texture2D(uSky, uv).rgb;
  vec3 col = t * t * uSkyRange;
  float c = dot(d, uSunDir);
  // the sun itself (kept far below its true brightness so the glow stays controllable) and its halo
  col += uSunColor * (smoothstep(0.99995, 0.99999, c) * 900.0 + pow(max(c, 0.0), 900.0) * 6.0 + pow(max(c, 0.0), 60.0) * 0.25);
  gl_FragColor = vec4(col, 1.0);
}
`;
