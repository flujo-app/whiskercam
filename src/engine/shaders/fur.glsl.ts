// Fur. The cat's body is drawn many times, each copy pushed a little further out along the
// skin ("shells"). Each shell only keeps small dots where a hair passes through it, and the dots
// shrink towards the tips, so the stack of shells reads as a coat of fine hairs.

export const furVertex = /* glsl */ `
precision highp float;
#include <skinning_pars_vertex>

uniform sampler2D uFurMap;   // r = hair length, g = how dark the roots are, b = bare skin (nose, pads)
uniform float uShells;
uniform float uFurLength;
uniform float uPuff;
uniform vec3 uLag;           // which way the hair tips trail (world space, from movement and gravity)

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vShell;
varying float vLen;

void main() {
  vec3 objectNormal = normal;
  vec3 transformed = position;
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <skinning_vertex>

  float shell = float(gl_InstanceID) / max(uShells - 1.0, 1.0);
  vec3 fur = textureLod(uFurMap, uv, 0.0).rgb;
  float len = uFurLength * fur.r * (1.0 + uPuff * 0.8);

  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * objectNormal);
  // hairs lean with gravity and trail behind movement; the further out, the more
  vec3 dir = normalize(n + uLag * shell * 0.9);
  wp.xyz += dir * (len * shell);

  vUv = uv;
  vNormal = n;
  vWorldPos = wp.xyz;
  vShell = shell;
  vLen = fur.r;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const furFragment = /* glsl */ `
precision highp float;

uniform sampler2D uCoat;
uniform sampler2D uFurMap;
uniform float uDensity;
uniform vec3 uTint;
uniform float uCoatSat;
uniform vec3 uProbeIrrUp;
uniform vec3 uProbeIrrDown;
uniform float uProbeSun;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform sampler2D uShadowNear;
uniform mat4 uShadowNearMat;
uniform vec2 uShadowTexel;
uniform float uShadowOn;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vShell;
varying float vLen;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 fur = texture2D(uFurMap, vUv).rgb;
  float skin = step(0.5, fur.b);

  if (vShell > 0.001) {
    // bare skin and hairless spots only exist on the innermost shell
    if (skin > 0.5 || vLen < 0.02) discard;
    vec2 cell = vUv * uDensity;
    vec2 id = floor(cell);
    float rnd = hash12(id);
    vec2 p = fract(cell) - 0.5 - (vec2(hash12(id + 7.1), hash12(id + 3.3)) - 0.5) * 0.5;
    float reach = 0.45 + 0.55 * rnd;                // not every hair is the same length
    if (vShell > reach) discard;
    float radius = 0.46 * (1.0 - vShell / reach) + 0.07;
    if (dot(p, p) > radius * radius) discard;
  }

  vec3 coat = texture2D(uCoat, vUv).rgb;
  coat = mix(vec3(dot(coat, vec3(0.3, 0.5, 0.2))), coat, uCoatSat) * uTint;
  // roots sit in the shade of the hairs above them
  float depth = mix(1.0 - 0.75 * fur.g, 1.0, vShell * vShell * 0.6 + vShell * 0.4);
  vec3 albedo = coat * mix(depth, 1.0, skin);

  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = uSunDir;

  // live shadow of the cat's own head, legs, other cats
  float shadow = 1.0;
  if (uShadowOn > 0.5) {
    vec4 a = uShadowNearMat * vec4(vWorldPos + N * 0.012, 1.0);
    vec3 sa = a.xyz * 0.5 + 0.5;
    if (all(greaterThan(sa.xy, vec2(0.02))) && all(lessThan(sa.xy, vec2(0.98)))) {
      float s = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(float(i % 2) - 0.5, float(i / 2) - 0.5) * uShadowTexel.x * 2.0;
        s += step(sa.z - 0.004, texture2D(uShadowNear, sa.xy + o).r);
      }
      shadow = s * 0.25;
    }
  }
  float sun = uProbeSun * shadow;

  // fur scatters light: soft wrap instead of a hard day/night line
  float wrap = clamp(dot(N, L) * 0.65 + 0.35, 0.0, 1.0);
  vec3 irr = mix(uProbeIrrDown, uProbeIrrUp, N.y * 0.5 + 0.5);
  vec3 color = albedo * (irr + uSunColor / 3.14159 * wrap * sun);

  // hairs lit from behind glow along the outline; hairs seen side-on have a soft sheen
  float edge = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  float back = clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0);
  color += (coat * 0.6 + 0.05) * uSunColor * (edge * back * sun * 0.35 * vShell);
  vec3 H = normalize(L + V);
  float sheen = pow(clamp(sqrt(1.0 - pow(dot(N, H), 2.0)), 0.0, 1.0), 26.0);
  color += uSunColor * sun * sheen * 0.012 * (0.4 + vShell);
  // wet-looking skin: nose and paw pads
  color += skin * uSunColor * sun * pow(max(dot(N, H), 0.0), 60.0) * 0.08;

  float dist = length(cameraPosition - vWorldPos);
  color = mix(color, uFogColor, 1.0 - exp(-dist * uFogDensity));
  gl_FragColor = vec4(color, 1.0);
}
`;
