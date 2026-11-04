import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BackgroundCanvas as Canvas } from './BackgroundCanvas';
import { AnimatedBackgroundProps } from './types';

function Ribbon({ index, color }: { index: number; color: string }) {
  const group = useRef<THREE.Group>(null);
  const data = useMemo(() => {
    const segments = 96;
    const positions = new Float32Array((segments + 1) * 6);
    const indices = new Uint16Array(segments * 6);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * Math.PI * 3 + index * 1.5;
      const radius = 15 + Math.sin(t * Math.PI * 2 + index) * 3;
      for (let side = 0; side < 2; side++) {
        const r = radius + (side - .5) * (.25 + Math.pow(Math.sin(t * Math.PI), .6) * 1.5);
        const offset = i * 6 + side * 3;
        positions[offset] = Math.cos(angle) * r;
        positions[offset + 1] = (t - .5) * 45;
        positions[offset + 2] = Math.sin(angle) * r;
      }
      if (i < segments) indices.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
    }
    return { positions, indices };
  }, [index]);
  useFrame(({ clock }) => {
    if (!group.current) return;
    group.current.rotation.y = clock.elapsedTime * (.024 + index * .003);
    group.current.position.y = Math.sin(clock.elapsedTime * .17 + index) * .8;
  });
  return <group ref={group} position={[-5, 0, -2]} rotation={[.12, 0, -.35]}><mesh>
    <bufferGeometry onUpdate={geometry => geometry.computeVertexNormals()}>
      <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
      <bufferAttribute attach="index" args={[data.indices, 1]} />
    </bufferGeometry>
    <meshStandardMaterial color={color} emissive={color} emissiveIntensity={.025} metalness={.58} roughness={.48} side={THREE.DoubleSide} />
  </mesh></group>;
}
export function RibbonDanceBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}><Canvas camera={{ position: [0, 1, 43], fov: 55 }}>
    <color attach="background" args={['#17212b']} />
    <ambientLight intensity={.7} /><directionalLight position={[-10, 20, 15]} intensity={2.3} color="#e0e7e1" />
    <directionalLight position={[15, -8, -12]} intensity={1.2} color="#a5bbc8" />
    {['#6f9290', '#8398a7', '#adb4af', '#677b8e'].map((color, i) => <Ribbon key={color} index={i} color={color} />)}
    <fog attach="fog" args={['#17212b', 38, 90]} />
  </Canvas></div>;
}
export default RibbonDanceBackground;
