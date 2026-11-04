import { DetailPointsMaterial } from './WelcomeDetailMaterials';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BackgroundCanvas as Canvas } from './BackgroundCanvas';
import { AnimatedBackgroundProps } from './types';

function Flow() {
  const group = useRef<THREE.Group>(null);
  const points = useRef<THREE.Points>(null);
  const [positions, colors] = useMemo(() => {
    const positions = new Float32Array(640 * 3);
    const colors = new Float32Array(640 * 3);
    const pearl = new THREE.Color('#d3ddd4'), jade = new THREE.Color('#426c71');
    for (let i = 0; i < 640; i++) {
      const side = i % 2, t = Math.floor(i / 2) / 320;
      const angle = t * Math.PI * 2.3 + side * Math.PI;
      const radius = 13 + t * 10;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius;
      positions[i * 3 + 2] = Math.sin(angle * 1.5) * 2 - 5;
      const color = side ? pearl : jade;
      colors.set([color.r, color.g, color.b], i * 3);
    }
    return [positions, colors];
  }, []);
  useFrame(({ clock }) => {
    if (group.current) {
      group.current.rotation.z = clock.elapsedTime * .026;
      group.current.rotation.x = .25 + Math.sin(clock.elapsedTime * .1) * .08;
    }
    if (points.current) points.current.rotation.z = -clock.elapsedTime * .012;
  });
  return <>
    <group ref={group} rotation={[.25, -.12, 0]}>
      {[0, 1].map(side => <group key={side} rotation={[0, 0, side * Math.PI]}>
        <mesh><torusGeometry args={[16, .25, 8, 96, Math.PI - .16]} />
          <meshStandardMaterial color={side ? '#bbcec4' : '#335c63'} roughness={.38} metalness={.55} />
        </mesh>
        <mesh position={[16, 0, 0]}><sphereGeometry args={[.62, 20, 12]} />
          <meshStandardMaterial color={side ? '#426c71' : '#d0ddd4'} roughness={.36} metalness={.35} />
        </mesh>
      </group>)}
    </group>
    <points ref={points}><bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[positions, 3]} /><bufferAttribute attach="attributes-color" args={[colors, 3]} />
    </bufferGeometry><DetailPointsMaterial vertexColors size={.075} transparent opacity={.4} depthWrite={false} /></points>
  </>;
}
export function YinYangFlowBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}><Canvas camera={{ position: [0, 0, 42], fov: 58 }}>
    <color attach="background" args={['#19272c']} /><ambientLight intensity={.85} />
    <directionalLight position={[-10, 15, 20]} intensity={2.8} color="#e0e8df" /><Flow />
  </Canvas></div>;
}
export default YinYangFlowBackground;
