import { DetailPointsMaterial, DetailLineMaterial } from './WelcomeDetailMaterials';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BackgroundCanvas as Canvas } from './BackgroundCanvas';
import { AnimatedBackgroundProps } from './types';

/** One geometry per tree, rather than one draw call per recursive branch. */
function Tree({ position, seed, scale = 1 }: { position: [number, number, number]; seed: number; scale?: number }) {
  const group = useRef<THREE.Group>(null);
  const [positions, colors] = useMemo(() => {
    const p: number[] = [], c: number[] = [];
    const branch = (x: number, y: number, z: number, length: number, angle: number, depth: number, phase: number) => {
      const nx=x+Math.cos(angle)*length, ny=y+Math.sin(angle)*length, nz=z+Math.sin(phase)*length*.28;
      p.push(x,y,z,nx,ny,nz);
      const color = new THREE.Color().setHSL(.43+depth*.008,.16,.27+(6-depth)*.04);
      c.push(color.r*.7,color.g*.7,color.b*.7,color.r,color.g,color.b);
      if (depth === 0) return;
      branch(nx,ny,nz,length*.72,angle+.37+Math.sin(phase)*.12,depth-1,phase+1.7);
      branch(nx,ny,nz,length*.7,angle-.4+Math.cos(phase)*.1,depth-1,phase+2.3);
    };
    branch(0,0,0,7,Math.PI/2,6,seed);
    return [new Float32Array(p),new Float32Array(c)];
  }, [seed]);
  useFrame(({ clock }) => { if(group.current) group.current.rotation.z=Math.sin(clock.elapsedTime*.085+seed)*.018; });
  return <group ref={group} position={position} scale={scale}><lineSegments>
    <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions,3]} /><bufferAttribute attach="attributes-color" args={[colors,3]} /></bufferGeometry>
    <DetailLineMaterial vertexColors transparent opacity={.82} />
  </lineSegments></group>;
}

function Spores() {
  const points = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const p=new Float32Array(120*3);
    for(let i=0;i<120;i++){p[i*3]=Math.sin(i*127.1)*48;p[i*3+1]=Math.cos(i*73.9)*24;p[i*3+2]=-15-Math.sin(i*42.7)*25;}
    return p;
  }, []);
  useFrame(({ clock })=>{if(points.current){points.current.position.y=Math.sin(clock.elapsedTime*.14)*1.4;points.current.rotation.y=Math.sin(clock.elapsedTime*.06)*.04;}});
  return <points ref={points}><bufferGeometry><bufferAttribute attach="attributes-position" args={[positions,3]} /></bufferGeometry><DetailPointsMaterial color="#b6c6ba" size={.07} transparent opacity={.4} depthWrite={false} /></points>;
}
export function FractalTreeBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}><Canvas camera={{position:[0,3,45],fov:55}}>
    <color attach="background" args={['#18272a']} />
    <Tree position={[-25,-22,-8]} seed={1} scale={1.45} /><Tree position={[26,-22,-14]} seed={4} scale={1.65} />
    <Tree position={[-13,-24,-32]} seed={9} scale={1.1} /><Tree position={[14,-25,-38]} seed={13} scale={1.2} /><Spores />
    <fog attach="fog" args={['#18272a',42,100]} />
  </Canvas></div>;
}
export default FractalTreeBackground;
