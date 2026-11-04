import { DetailMeshMaterial } from './WelcomeDetailMaterials';
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function InfinityMirrorScene() {
  const group = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    if (!group.current) return
    const time = clock.elapsedTime
    group.current.rotation.z = 0.08 + Math.sin(time * 0.045) * 0.05
    group.current.children.forEach((ring, i) => {
      // Small, coordinated tilts keep the nested aperture intact.
      ring.rotation.x = Math.sin(time * 0.09 + i * 0.12) * 0.055
      ring.rotation.y = Math.cos(time * 0.075 + i * 0.12) * 0.065
    })
  })
  return (
    <>
      <ambientLight intensity={0.65} />
      <directionalLight position={[-8, 14, 16]} intensity={2.4} color="#dce8e4" />
      <directionalLight position={[15, -10, 0]} intensity={1.1} color="#a0b7c0" />
      <group ref={group} rotation={[0, 0, 0.08]}>
        {Array.from({ length: 14 }, (_, i) => (
          <group key={i} position={[0, 0, -i * 5.6]} scale={1 + i * 0.012}>
            <mesh>
              <torusGeometry args={[12.8, 0.075, 6, 72]} />
              <meshStandardMaterial
                color={i % 4 === 0 ? '#b6bfba' : '#7b959d'}
                emissive="#26414b"
                emissiveIntensity={0.12}
                metalness={0.78}
                roughness={0.27}
              />
            </mesh>
            <mesh position={[0, 0, 0.06]}>
              <torusGeometry args={[12.68, 0.014, 4, 72]} />
              <DetailMeshMaterial
                color={i % 4 === 0 ? '#d5dcd2' : '#96bbc1'}
                transparent opacity={0.48} depthWrite={false}
              />
            </mesh>
          </group>
        ))}
      </group>
      <fog attach="fog" args={['#0b171e', 17, 100]} />
    </>
  )
}

export function InfinityMirrorBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 0, 20], fov: 65, near: 0.1, far: 125 }}
        style={{ background: 'radial-gradient(ellipse at center, #172930 0%, #0b171e 100%)' }}
      >
        <InfinityMirrorScene />
      </Canvas>
    </div>
  )
}

export default InfinityMirrorBackground
