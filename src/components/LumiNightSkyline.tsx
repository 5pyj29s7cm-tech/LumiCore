import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

function CityWindows({buildings}:{buildings:Array<{x:number;z:number;w:number;d:number;h:number}>}) {
  const windows=useRef<THREE.InstancedMesh>(null);
  const lights=useMemo(()=>buildings.flatMap((b,i)=>Array.from({length:Math.floor(b.h/.43)},(_,floor)=>Array.from({length:Math.floor(b.w/.34)},(_,col)=>{
    const random=Math.sin(i*57+floor*19+Math.floor(col/2)*7);
    if(random<.05)return null;
    return {x:b.x-b.w/2+.25+col*.34,y:-4.6+floor*.43,z:b.z+b.d/2+.018,w:.14,color:new THREE.Color((floor+Math.floor(col/3)+i)%5===0?'#b6a18a':(i%3===0?'#91a1b6':'#657f9a')).multiplyScalar(.45+random*.6)};
  }).filter((v):v is NonNullable<typeof v>=>Boolean(v))).flat()),[buildings]);
  useEffect(()=>{if(!windows.current)return;const transform=new THREE.Object3D();lights.forEach((light,i)=>{transform.position.set(light.x,light.y,light.z);transform.scale.set(light.w,.24,1);transform.updateMatrix();windows.current!.setMatrixAt(i,transform.matrix);windows.current!.setColorAt(i,new THREE.Color(light.color));});windows.current.instanceMatrix.needsUpdate=true;if(windows.current.instanceColor)windows.current.instanceColor.needsUpdate=true;windows.current.computeBoundingSphere();},[lights]);
  return <instancedMesh name="city-lit-windows" ref={windows} args={[undefined,undefined,lights.length]}><planeGeometry args={[1,.64]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>;
}
function CyberCity(){
  const buildings=useMemo(()=>Array.from({length:27},(_,i)=>{
    const row=Math.floor(i/9),x=(i%9-4)*10.2+(row%2)*4,z=-45-row*26;
    let h=8+((i*13)%17)+row*3;
    // Leave open sky around the moon instead of putting a tower across it.
    if(x>5&&x/(-z)>.11&&x/(-z)<.31)h*=.52;
    return{x,z,h,w:4.4+(i%3)*1.1,d:3.4+(i%4)*.6};
  }),[]);
  return <group name="cyber-city">
    {buildings.map((b,i)=><group key={i} name="city-building" position={[b.x,-5+b.h/2,b.z]}>
      <mesh castShadow receiveShadow><boxGeometry args={[b.w,b.h,b.d]} /><meshStandardMaterial color={i%2?'#172334':'#1c2939'} roughness={.38} metalness={.55} /></mesh>
      {Array.from({length:Math.floor(b.w/.68)},(_,j)=><mesh key={j} position={[-b.w/2+.25+j*.68,0,b.d/2+.01]}><boxGeometry args={[.018,b.h,.015]} /><meshStandardMaterial color="#465364" metalness={.7} roughness={.35} /></mesh>)}
      <mesh position={[0,b.h/2+.3,0]}><boxGeometry args={[b.w*.65,.6,b.d*.7]} /><meshStandardMaterial color="#263346" metalness={.65} roughness={.4} /></mesh>
      {i%3===0&&<mesh position={[b.w*.35,0,b.d/2+.03]}><boxGeometry args={[.07,b.h*.82,.04]} /><meshBasicMaterial color={i%2?'#729ad2':'#8370bf'} toneMapped={false} /></mesh>}
      {i%4===1&&<mesh position={[0,b.h*.32,b.d/2+.04]}><boxGeometry args={[b.w*.94,.12,.08]} /><meshBasicMaterial color="#5d9fae" toneMapped={false} /></mesh>}
      {i%5===0&&<mesh position={[0,b.h/2+1.8,0]}><cylinderGeometry args={[.045,.08,3,8]} /><meshStandardMaterial color="#4c5f74" metalness={.65} roughness={.3} /></mesh>}
    </group>)}
    <CityWindows buildings={buildings} />
  </group>;
}
const moonVertex='varying vec3 vNormal;varying vec3 vPoint;void main(){vNormal=normal;vPoint=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
const moonFragment='varying vec3 vNormal;varying vec3 vPoint;void main(){float light=max(0.,dot(normalize(vNormal),normalize(vec3(1.,.08,.01))));float detail=.91+.04*sin(vPoint.x*13.+sin(vPoint.y*11.))+.025*sin(vPoint.y*29.+vPoint.z*17.);vec3 color=vec3(.006,.012,.027)+vec3(.73,.81,.98)*pow(light,.42)*detail;gl_FragColor=vec4(color,1.);\n#include <colorspace_fragment>\n}';
/** Mesh towers and lights sit in front of the stars and the half-lit moon. */
export function LumiNightSkyline(){
  const positions=useMemo(()=>new Float32Array(Array.from({length:750},(_,i)=>{
    const a=Math.sin(i*127.1+8)*43758.5453,b=Math.sin(i*311.7+3)*9648.531;
    return [(a-Math.floor(a)-.5)*220,6+(b-Math.floor(b))*67,-145-(i%7)*3];
  }).flat()),[]);
  return <group name="night-skyline">
    <points name="night-stars"><bufferGeometry><bufferAttribute attach="attributes-position" args={[positions,3]} /></bufferGeometry><pointsMaterial color="#c6d7fc" size={.8} sizeAttenuation={false} transparent opacity={.48} depthWrite={false} fog={false} toneMapped={false} /></points>
    <mesh name="half-moon" position={[25,28,-130]} rotation={[0,-.17,-.12]}><sphereGeometry args={[1.2,48,32]} /><shaderMaterial vertexShader={moonVertex} fragmentShader={moonFragment} fog={false} toneMapped={false} /></mesh>
    <CyberCity />
  </group>;
}
