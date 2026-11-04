import { DetailPointsMaterial, DetailLineMaterial, DetailMeshMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function Tunnel() {
  const structure = useRef<THREE.Group>(null)
  const dust = useRef<THREE.Points>(null)
  const { rails, particles, colors } = useMemo(() => {
    const rails: number[] = []
    const particles = new Float32Array(420 * 3)
    const colors = new Float32Array(420 * 3)
    const color = new THREE.Color()
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3
      const x = Math.cos(angle) * 10.5
      const y = Math.sin(angle) * 10.5
      rails.push(x, y, 8, x, y, -70)
    }
    for (let i = 0; i < 420; i++) {
      const angle = i * 2.399963
      const radius = 10.8 + (i % 17) * 0.28
      particles.set([
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        8 - ((i * 0.618034) % 1) * 78,
      ], i * 3)
      color.setHSL(0.51 + (i % 11) * 0.009, 0.48, 0.54)
      colors.set([color.r, color.g, color.b], i * 3)
    }
    return { rails: new Float32Array(rails), particles, colors }
  }, [])

  useFrame(({ clock }) => {
    const time = clock.elapsedTime
    if (structure.current) {
      structure.current.rotation.z = 0.12 + Math.sin(time * 0.045) * 0.1
      structure.current.rotation.y = Math.sin(time * 0.035) * 0.018
    }
    if (dust.current) dust.current.rotation.z = time * 0.014

  })

  return (
    <>
      <group ref={structure} rotation={[0, 0, 0.12]}>
        {/* Faceted walls and aligned seams establish a real, continuous volume. */}
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -31]}>
          <cylinderGeometry args={[10.65, 10.65, 78, 6, 1, true, Math.PI / 6]} />
          <DetailMeshMaterial color="#091b2b" side={THREE.BackSide} />
        </mesh>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[rails, 3]} />
          </bufferGeometry>
          <DetailLineMaterial color="#4b87a8" transparent opacity={0.18} depthWrite={false} />
        </lineSegments>
        {Array.from({ length: 15 }, (_, i) => (
          <mesh key={i} position={[0, 0, 8 - i * 5.2]}>
            <torusGeometry args={[10.5, i % 3 === 0 ? 0.035 : 0.018, 4, 6]} />
            <DetailMeshMaterial
              color={i % 3 === 0 ? '#9bb9bb' : '#617c8b'}
              transparent
              opacity={i % 3 === 0 ? 0.53 : 0.3}
              depthWrite={false}
            />
          </mesh>
        ))}

      </group>
      <points ref={dust}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[particles, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <DetailPointsMaterial size={0.045} vertexColors transparent opacity={0.46} depthWrite={false} />
      </points>
      <fog attach="fog" args={['#0b151e', 12, 83]} />
    </>
  )
}

export function GeometricTunnelBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 0, 16], fov: 65, near: 0.1, far: 110 }}
        style={{ background: 'radial-gradient(ellipse at center, #192a32 0%, #0b151e 100%)' }}
      >
        <Tunnel />
      </Canvas>
    </div>
  )
}

export default GeometricTunnelBackground
