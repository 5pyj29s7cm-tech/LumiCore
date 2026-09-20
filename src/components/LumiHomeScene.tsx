import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { ContactShadows, useGLTF } from '@react-three/drei';
import { DepthOfField, EffectComposer, N8AO } from '@react-three/postprocessing';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LumiNightSkyline } from './LumiNightSkyline';

type XYZ = [number, number, number];
type Surface = 'wood' | 'fabric' | 'floor' | 'plaster';
type SurfaceMaps={map?:THREE.Texture;normalMap?:THREE.Texture;roughnessMap?:THREE.Texture};
const Materials = createContext<Partial<Record<Surface,SurfaceMaps>>>({});
function HomeMaterials({children}:{children:ReactNode}){
  const sources=useLoader(THREE.TextureLoader,['wood_table_001','rough_linen','wooden_floor_02'].flatMap(id=>['diffuse','nor_gl','rough'].map(kind=>'/avatars/lumi-home/'+id+'-'+kind+'.jpg')));
  const maps=useMemo(()=>Object.fromEntries((['wood','fabric','floor'] as const).map((kind,index)=>{
    const textures=sources.slice(index*3,index*3+3).map((source,i)=>{const t=source.clone();t.colorSpace=i===0?THREE.SRGBColorSpace:THREE.NoColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;t.repeat.set(kind==='floor'?4:kind==='fabric'?3:1,kind==='floor'?4:kind==='fabric'?3:1);t.needsUpdate=true;return t;});
    return[kind,{map:textures[0],normalMap:textures[1],roughnessMap:textures[2]}];
  })),[sources]);
  useEffect(()=>()=>Object.values(maps).forEach(m=>Object.values(m).forEach(t=>t.dispose())),[maps]);
  return <Materials.Provider value={maps}>{children}</Materials.Provider>;
}
function Block({ at, size, color, roughness = .8, metalness = 0, name, surface='wood' }: { at: XYZ; size: XYZ; color: string; roughness?: number; metalness?: number; name?: string;surface?:Surface }) {
  const maps=useContext(Materials)[surface];
  const tint=useMemo(()=>surface==='wood'&&!metalness?new THREE.Color(color).lerp(new THREE.Color('#ffffff'),.72):new THREE.Color(color),[color,surface,metalness]);
  return <mesh name={name} position={at} castShadow receiveShadow><boxGeometry args={size} /><meshStandardMaterial {...(metalness?{}:maps)} normalScale={[.15,.15]} color={tint} roughness={roughness} metalness={metalness} /></mesh>;
}
function Furnishing({asset,at,width,rotation=0}:{asset:string;at:XYZ;width:number;rotation?:number}){
  const {scene}=useGLTF('/avatars/lumi-home/'+asset+'/'+asset+'.gltf');
  const {object,offset,scale}=useMemo(()=>{const object=scene.clone(true),box=new THREE.Box3().setFromObject(object),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());object.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;}});return{object,offset:new THREE.Vector3(-center.x,-box.min.y,-center.z),scale:width/Math.max(.01,size.x)};},[scene,width]);
  return <group name={asset} position={at} rotation={[0,rotation,0]} scale={scale}><primitive object={object} position={offset} dispose={null} /></group>;
}
function HomeReflections({night=false}:{night?:boolean}) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const generator=new THREE.PMREMGenerator(gl),room=new RoomEnvironment();
    const map=generator.fromScene(room,.04),previous=scene.environment,intensity=scene.environmentIntensity;
    scene.environment=map.texture;scene.environmentIntensity=night?.045:.17;room.dispose();generator.dispose();
    return ()=>{if(scene.environment===map.texture){scene.environment=previous;scene.environmentIntensity=intensity;}map.dispose();};
  },[gl,scene,night]);
  return null;
}
/** Architecture, furniture and the outdoor terrain have real geometry and depth. */
function NightReadingLamp(){
  const source=useLoader(THREE.TextureLoader,'/avatars/lumi-reclining/reading-lamp-v2.png');
  const map=useMemo(()=>{const t=source.clone();t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;t.needsUpdate=true;return t;},[source]);
  useEffect(()=>()=>map.dispose(),[map]);
  return <mesh name="linen-night-lamp" position={[0,1.06,0]}><planeGeometry args={[1.414,2.12]} /><meshBasicMaterial map={map} transparent alphaTest={.05} depthWrite toneMapped={false} /></mesh>;
}
function HomeInterior({seated=false}:{seated?:boolean}) {
  const floor=useContext(Materials).floor;
  return <group name="lumi-home-interior">
    <Block name="floor-slab" at={[0,-1.82,-2.8]} size={[18,.28,20]} color="#786047" />
    <mesh position={[0,-1.668,-2.8]} rotation={[-Math.PI/2,0,0]} receiveShadow><planeGeometry args={[18,20]} /><meshStandardMaterial {...floor} color="#c6baaa" normalScale={[.4,.4]} roughness={.7} /></mesh>
    {[-8.5,8.5].map(x=><Block key={x} at={[x,1.6,0]} size={[.3,6.6,14.4]} color="#c2b6a2" surface="plaster" />)}
    <Block at={[0,4.8,0]} size={[17.3,.3,14.4]} color="#c6bfae" surface="plaster" />
    <Block at={[0,4.4,-7.2]} size={[17,.85,.5]} color="#c4b39a" surface="plaster" />
    <Block at={[0,-1.22,-7.2]} size={[17,.9,.5]} color="#b4a38b" surface="plaster" />
    {[-8.2,-3.8,3.8,8.2].map(x=><Block key={x} name="window-mullion" at={[x,1.58,-7]} size={[.14,5,.26]} color="#373e3b" roughness={.32} metalness={.5} />)}
    {[-.76,4.05].map(y=><Block key={y} at={[0,y,-7]} size={[16.6,.11,.28]} color="#373e3b" roughness={.32} metalness={.5} />)}
    <Block name="window-sill" at={[0,-.8,-6.8]} size={[16.7,.1,.72]} color="#9f8b6c" roughness={.42} />
    <mesh position={[0,4.09,-6.7]}><boxGeometry args={[16.7,.025,.04]} /><meshStandardMaterial color="#ffdb98" emissive="#ffc571" emissiveIntensity={2} /></mesh>
    <group name="library" position={[-5.4,0,-4.7]} rotation={[0,.12,0]}>
      <Block at={[0,.15,-.35]} size={[1.8,3.55,.16]} color="#4b4033" />
      {[-.9,.9].map(x=><Block key={x} at={[x,.15,0]} size={[.1,3.6,.8]} color="#766049" />)}
      {[-1.57,-.73,.12,1.02,1.87].map((y,i)=><group key={y}>
        <Block at={[0,y,0]} size={[1.85,.08,.8]} color="#947958" />
        {i<4&&Array.from({length:i===2?4:7},(_,j)=><group key={j} position={[-.64+j*.19,y+.31,-.05]} rotation={[0,0,j===5?-.06:0]}>
          <Block at={[0,0,0]} size={[.13,.48+(j%3)*.07,.34]} surface="plaster" color={['#4f635a','#ad9873','#684434','#989d91','#303e40'][j%5]} />
          {[-.17,.16].map(h=><Block key={h} at={[0,h,.172]} size={[.11,.009,.004]} surface="plaster" color="#c1ad82" />)}
          <Block at={[.068,0,-.025]} size={[.006,.43+(j%3)*.07,.25]} color="#c8bea4" surface="plaster" />
        </group>)}
      </group>)}
    </group>
    {!seated&&<Furnishing asset="sofa_03" at={[-3.6,-1.62,-3.4]} width={3.45} rotation={.09} />}
    {seated&&<group name="reading-corner">
      <Block name="corner-wall" at={[-4.2,1.4,-5.9]} size={[9.4,6.1,.24]} color="#918477" surface="plaster" />
      <Block at={[.52,1.35,-5.73]} size={[.10,5.95,.12]} color="#79634d" roughness={.46} />
      <Block at={[-3.5,-1.33,-5.71]} size={[5.5,.28,.12]} color="#66513f" />
      <group name="corner-lamp" position={[-1.6,-1.65,-2.2]}>
        <NightReadingLamp />
        <pointLight position={[0,1.72,0]} color="#ffcd9b" intensity={.22} distance={5} decay={2} />
        <pointLight position={[0,1.15,-.12]} color="#efb982" intensity={2.8} distance={6} decay={2} />
        <pointLight position={[0,1.55,-1.7]} color="#e8b583" intensity={2.5} distance={5} decay={2} />
      </group>
    </group>}
    <Block name="woven-rug" at={[-1,-1.64,-.25]} size={[5.6,.028,3.8]} color="#b2a48a" surface="fabric" roughness={1} />
    {Array.from({length:27},(_,i)=><Block key={i} at={[-1,-1.623,-2.08+i*.14]} size={[5.5,.006,.009]} color="#998c77" surface="plaster" roughness={1} />)}
    <group name="coffee-table" position={[-3,-1.02,-.4]}>
      <mesh castShadow receiveShadow scale={[1.35,1,.78]}><cylinderGeometry args={[.66,.66,.1,48]} /><meshStandardMaterial color="#664b35" roughness={.38} /></mesh>
      {[-.52,.52].map(x=><Block key={x} at={[x,-.31,0]} size={[.1,.61,.45]} color="#4e3b2b" />)}
      <Block at={[-.22,.085,0]} size={[.43,.07,.31]} color="#b7b29c" surface="plaster" />
      <mesh position={[.31,.15,.02]} castShadow><cylinderGeometry args={[.085,.066,.2,24]} /><meshStandardMaterial color="#d5c7ae" roughness={.32} /></mesh>
    </group>
    <group name="reading-lamp" position={[3.8,-1.66,-3.2]}>
      <mesh castShadow><cylinderGeometry args={[.28,.32,.07,40]} /><meshStandardMaterial color="#554d3c" metalness={.65} roughness={.3} /></mesh>
      <mesh position={[0,1.18,0]} castShadow><cylinderGeometry args={[.025,.025,2.35,16]} /><meshStandardMaterial color="#897551" metalness={.65} roughness={.32} /></mesh>
      <mesh position={[0,2.25,0]} castShadow><cylinderGeometry args={[.28,.46,.5,48,1,true]} /><meshStandardMaterial color="#ead4a6" side={THREE.DoubleSide} roughness={1} emissive="#c69049" emissiveIntensity={.27} /></mesh>
      <pointLight position={[0,2.05,0]} color="#ffd398" intensity={seated?0:18} distance={8} decay={2} />
    </group>
    <group name="writing-desk" position={[4.3,-.72,-5.6]} rotation={[0,-.12,0]}>
      <Block at={[0,0,0]} size={[2.1,.11,.95]} color="#8f7152" roughness={.42} />
      {[-.85,.85].map(x=><Block key={x} at={[x,-.45,0]} size={[.1,.9,.75]} color="#5f4e3e" />)}
      <Block at={[-.35,.085,.04]} size={[.53,.045,.34]} color="#e0d2b9" surface="plaster" />
      <Block at={[-.35,.112,.04]} size={[.02,.015,.32]} color="#6b6454" surface="plaster" />
    </group>
    <Furnishing asset="potted_plant_01" at={[5.2,-1.65,-.8]} width={1.45} rotation={-.4} />
  </group>;
}
function Curtains({reducedMotion,seated=false}:{reducedMotion:boolean;seated?:boolean}){
  const refs=useRef<Array<THREE.Mesh|null>>([]),time=useRef(0);
  useFrame((_state,delta)=>{
    if(!reducedMotion)time.current+=Math.min(delta,.06);
    refs.current.forEach(mesh=>{if(!mesh)return;const p=mesh.geometry.attributes.position;
      for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i);p.setZ(i,.065*Math.cos(x*23)+(reducedMotion?0:.035*Math.sin(time.current*.65+x*2+y)*Math.max(0,(2-y)/4)));}
      p.needsUpdate=true;mesh.geometry.computeVertexNormals();
    });
  });
  return <group name="window-curtains">{(seated?[.84,7.15]:[-7.15,7.15]).map((x,i)=><mesh key={x} ref={v=>{refs.current[i]=v;}} position={[x,1.58,seated?-5.65:-6.55]} castShadow receiveShadow><planeGeometry args={[seated&&i===0?.64:1.7,5,36,20]} /><meshStandardMaterial color={seated?'#b9afa0':'#d9cfb9'} roughness={1} side={THREE.DoubleSide} /></mesh>)}</group>;
}
function terrainHeight(x:number,z:number,phase:number){
  return 1.1+Math.sin(x*.14+phase)*1.4+Math.cos(z*.17+phase)*1.3+Math.sin(x*.4+z*.2)*.5+Math.sin(x*.82-z*.58)*.16+Math.sin(x*1.67+z*1.32)*.07;
}
function Hills({z,scale,color,phase}:{z:number;scale:number;color:string;phase:number}){
  const geometry=useMemo(()=>{const g=new THREE.PlaneGeometry(110,44,140,65);g.rotateX(-Math.PI/2);const p=g.attributes.position,colors=new Float32Array(p.count*3),base=new THREE.Color(color);
    for(let i=0;i<p.count;i++){const x=p.getX(i),d=p.getZ(i),h=terrainHeight(x,d,phase),shore=1-THREE.MathUtils.smoothstep(d,9,22);p.setY(i,h*scale*shore-(1-shore)*.8);const c=base.clone().multiplyScalar(.82+Math.sin(x*.7+d*.43)*.05+Math.max(0,h)*.05);c.toArray(colors,i*3);}
    g.setAttribute('color',new THREE.BufferAttribute(colors,3));g.computeVertexNormals();return g;
  },[phase,scale,color]);
  useEffect(()=>()=>geometry.dispose(),[geometry]);
  return <mesh name="terrain" geometry={geometry} position={[0,-3,z]} receiveShadow><meshStandardMaterial vertexColors roughness={1} /></mesh>;
}
const waterVertex='varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
const waterFragment='varying vec2 vUv;uniform float time;void main(){float ripple=sin(vUv.y*1800.+sin(vUv.x*110.+time*.3)*2.-time*.9);float glow=exp(-pow((vUv.x-.68)*12.,2.));vec3 c=mix(vec3(.004,.012,.024),vec3(.035,.07,.12),vUv.y*.3+glow*.4);c+=max(0.,ripple)*.004;gl_FragColor=vec4(c,1.);\n#include <colorspace_fragment>\n}';
function NightWindowView(){
  const source=useLoader(THREE.TextureLoader,'/avatars/lumi-reclining/night-city-v2.png');
  const texture=useMemo(()=>{const t=source.clone();t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;t.needsUpdate=true;return t;},[source]);
  useEffect(()=>()=>texture.dispose(),[texture]);
  const uniforms=useMemo(()=>({map:{value:texture}}),[texture]);
  return <group name="photographic-night-window">
    <mesh position={[18,8,-65]}><planeGeometry args={[90,60]} /><meshBasicMaterial map={texture} color="#c3c9d3" toneMapped={false} fog={false} /></mesh>
    <mesh name="night-half-moon" position={[14.3,9,-64]}><planeGeometry args={[.8,.82]} /><shaderMaterial uniforms={uniforms} transparent depthWrite={false} toneMapped={false}
      vertexShader={'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}'}
      fragmentShader={'varying vec2 vUv;uniform sampler2D map;void main(){vec2 uv=mix(vec2(1290./1536.,1.-143./1024.),vec2(1350./1536.,1.-82./1024.),vUv);vec3 c=texture2D(map,uv).rgb;float a=smoothstep(.035,.13,max(c.r,max(c.g,c.b)));gl_FragColor=vec4(c,a);\n#include <colorspace_fragment>\n}'} /></mesh>
    <mesh position={[0,1.58,-6.7]}><planeGeometry args={[16.5,4.8]} /><meshBasicMaterial color="#9caec6" transparent opacity={.012} depthWrite={false} /></mesh>
  </group>;
}
function HomeWorld({reducedMotion,seated=false}:{reducedMotion:boolean;seated?:boolean}){
  const water=useRef<THREE.ShaderMaterial>(null),clock=useRef(0),uniforms=useMemo(()=>({time:{value:0}}),[]);
  useFrame((_state,delta)=>{if(!reducedMotion)clock.current+=Math.min(delta,.08);if(water.current)water.current.uniforms.time.value=reducedMotion?0:clock.current;});
  if(seated)return <NightWindowView />;
  return <group name="world-beyond-home">
    <LumiNightSkyline />
    <Hills z={-78} scale={.6} color="#26384b" phase={3} /><Hills z={-52} scale={.4} color="#263b45" phase={.6} /><Hills z={-37} scale={.2} color="#263e38" phase={1.5} />
    <mesh name="lake" position={[0,-2.5,-20]} rotation={[-Math.PI/2,0,0]}><planeGeometry args={[110,90]} /><shaderMaterial ref={water} uniforms={uniforms} vertexShader={waterVertex} fragmentShader={waterFragment} /></mesh>
    <Block name="terrace" at={[0,-2.15,-7.5]} size={[15,.25,4]} color="#85877a" />
    {Array.from({length:6},(_,i)=><group key={i} position={[-9-i*2,-2,-11-i*3]} scale={1+i*.09}><mesh position={[0,2.1,0]}><cylinderGeometry args={[.08,.19,4.3,8]} /><meshStandardMaterial color="#655e4a" /></mesh><mesh position={[0,4,0]} scale={[1.3,1.9,1.3]}><sphereGeometry args={[1,14,10]} /><meshStandardMaterial color="#445e4b" roughness={1} /></mesh></group>)}
  </group>;
}
export function LumiHomeScene({tint='#d5d6c5',reducedMotion=false,seated=false}:{tint?:string;reducedMotion?:boolean;seated?:boolean}){
  return <>
    <HomeReflections night={seated} /><color attach="background" args={['#070e22']} /><fog attach="fog" args={['#101d35',35,170]} />
    <HomeMaterials><HomeWorld reducedMotion={reducedMotion} seated={seated} /><HomeInterior seated={seated} /></HomeMaterials><Curtains reducedMotion={reducedMotion} seated={seated} />
    <ContactShadows position={[0,-1.619,0]} scale={16} opacity={.4} blur={2.5} far={6} frames={1} resolution={512} color="#4a3928" />
    <ambientLight intensity={seated?.025:.12} color={tint} /><hemisphereLight args={['#6d8bbe','#5b4230',seated?.065:.32]} />
    <directionalLight position={[8,12,-14]} color="#88afff" intensity={seated?.10:.65} castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={10} shadow-camera-bottom={-8} shadow-camera-far={55} shadow-normalBias={.025} shadow-bias={-.0001} />
    <directionalLight position={[1,4,7]} color="#ffe1b7" intensity={seated?.09:.65} />
    <pointLight position={[-4,2.4,-3.8]} color="#ffc986" intensity={seated?0:24} distance={12} decay={2} />
    <pointLight position={[0,3.5,-1.5]} color="#ffe0b1" intensity={seated?0:15} distance={10} decay={2} />
    <EffectComposer multisampling={2}>
      <N8AO aoRadius={.65} intensity={1.3} distanceFalloff={1} quality="performance" halfRes />
      {seated?<DepthOfField target={[0,-.40,.9]} focusRange={.8} bokehScale={2} height={640} />:<></>}
    </EffectComposer>
  </>;
}
export function LumiHomeCamera({reducedMotion,closeUp=false,fullBody=false,portraitCloseUp=false}:{reducedMotion:boolean;closeUp?:boolean;fullBody?:boolean;portraitCloseUp?:boolean}){
  const camera=useThree(s=>s.camera),size=useThree(s=>s.size),target=useRef(new THREE.Vector3());
  useFrame(({pointer},delta)=>{
    const aspect=size.width/Math.max(1,size.height);
    const layered=fullBody||portraitCloseUp;
    const height=closeUp?1.05:portraitCloseUp?-.42:fullBody?-.78:.35;
    const distance=closeUp?5.5:portraitCloseUp?3.2:fullBody?5.0:7.7;
    target.current.set((closeUp?.22:layered?.04:.65)+(reducedMotion?0:pointer.x*(layered?.022:.32)),height+(reducedMotion?0:pointer.y*(layered?.015:.10)),distance+Math.max(0,.85-aspect)*(portraitCloseUp?1.8:4));
    const ease=1-Math.exp(-Math.min(delta,.1)*3);
    if(camera instanceof THREE.PerspectiveCamera){
      const fov=portraitCloseUp?28:fullBody?30:34;
      if(Math.abs(camera.fov-fov)>.001){camera.fov=THREE.MathUtils.lerp(camera.fov,fov,ease);camera.updateProjectionMatrix();}
    }
    camera.position.lerp(target.current,ease);camera.lookAt(0,closeUp?.95:portraitCloseUp?-.42:fullBody?-.78:.18,layered?.9:closeUp?.65:0);
  });return null;
}
