import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { LumiLayeredMotion } from '../lib/lumiLayeredMotion';

const faceVertex = `varying vec2 vUv;
  void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const faceFragment = `
  varying vec2 vUv;
  uniform sampler2D idleMap; uniform sampler2D blinkMap; uniform sampler2D speechMap;
  uniform float blink; uniform float speech;
  float region(vec2 pixel,vec2 center,vec2 radius){return 1.-smoothstep(.55,1.,length((pixel-center)/radius));}
  void main(){
    vec2 pixel=vec2(vUv.x*1536.,(1.-vUv.y)*1024.);
    vec4 base=texture2D(idleMap,vUv);
    base.a=smoothstep(.4,.99,base.a);
    if(base.a<.02)discard;
    float eyelids=max(region(pixel,vec2(577.,122.),vec2(30.,17.)),region(pixel,vec2(631.,119.),vec2(30.,17.)));
    vec3 color=mix(base.rgb,texture2D(blinkMap,vUv).rgb,blink*eyelids);
    float mouth=region(pixel,vec2(611.,166.),vec2(37.,20.));
    color=mix(color,texture2D(speechMap,vUv).rgb,speech*mouth);
    color*=mix(vec3(.68,.58,.51),vec3(.37,.45,.60),smoothstep(480.,1280.,pixel.x));
    gl_FragColor=vec4(color,base.a);
    #include <colorspace_fragment>
  }
`;

/** A fixed seated portrait. Only eyelids and the audio-driven mouth change. */
export function LumiLayeredCharacter({ outputLevelRef, reducedMotion }: {
  outputLevelRef: MutableRefObject<number>; reducedMotion: boolean; state?: string;
}) {
  const sources = useLoader(THREE.TextureLoader, [
    '/avatars/lumi-reclining/idle-v1.png',
    '/avatars/lumi-reclining/blink-v1.png',
    '/avatars/lumi-reclining/speech-v1.png',
  ]);
  const textures = useMemo(() => sources.map(source => {
    const texture = source.clone();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4; texture.needsUpdate = true;
    return texture;
  }), [sources]);
  const geometry = useMemo(() => {
    const result = new THREE.PlaneGeometry(1536, 1024);
    result.translate(1536 / 2 - 620, 1014 - 1024 / 2, 0);
    return result;
  }, []);
  useEffect(() => () => { textures.forEach(texture => texture.dispose()); }, [textures]);
  useEffect(() => () => { geometry.dispose(); }, [geometry]);
  const uniforms = useMemo(() => ({
    idleMap: { value: textures[0] }, blinkMap: { value: textures[1] }, speechMap: { value: textures[2] },
    blink: { value: 0 }, speech: { value: 0 },
  }), [textures]);
  const faceMaterial = useRef<THREE.ShaderMaterial>(null);
  const motion = useRef(new LumiLayeredMotion());
  useFrame((_frame, delta) => {
    const face = motion.current.step(delta, outputLevelRef.current, reducedMotion);
    const mounted = faceMaterial.current?.uniforms;
    if (mounted) { mounted.blink.value = face.blink; mounted.speech.value = face.mouth; }
  });
  return <group name="lumi-layered-character" position={[0, -1.61, .9]} scale={.0016}>
    <mesh name="lumi-reclining-body" geometry={geometry} frustumCulled={false} renderOrder={10}>
      <shaderMaterial ref={faceMaterial} uniforms={uniforms} vertexShader={faceVertex} fragmentShader={faceFragment}
        transparent depthWrite toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  </group>;
}
