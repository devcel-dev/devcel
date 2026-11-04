import { DetailPointsMaterial, DetailLineMaterial, DetailMeshMaterial } from './WelcomeDetailMaterials';
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function PulseWave({ phase }: { phase: number }) {
  const mesh = useRef<THREE.Mesh>(null)
  const material = useRef<THREE.MeshBasicMaterial>(null)
  useFrame(({ clock }) => {
    if (!mesh.current || !material.current) return
    const progress = (clock.elapsedTime * 0.055 + phase) % 1
    const scale = 12 + progress * 40
    mesh.current.scale.set(scale, scale, 1)
    material.current.opacity = Math.sin(progress * Math.PI) * 0.25
  })
  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} position={[0, -9, 0]} scale={12 + phase * 40}>
      <ringGeometry args={[1, 1.004, 96]} />
      <DetailMeshMaterial ref={material} color="#a3c4bd" transparent opacity={Math.sin(phase * Math.PI) * 0.25} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

function Scanner() {
  const core = useRef<THREE.Group>(null)
  const particles = useRef<THREE.Points>(null)
  const { radial, positions } = useMemo(() => {
    const radial: number[] = []
    for (let i = 0; i < 32; i++) {
      const angle = i / 32 * Math.PI * 2
      radial.push(Math.cos(angle) * 13, -9, Math.sin(angle) * 13, Math.cos(angle) * 55, -9, Math.sin(angle) * 55)
    }
    const positions = new Float32Array(360 * 3)
    for (let i = 0; i < 360; i++) {
      const angle = i * 2.399963
      const radius = 18 + (i % 31) * 0.85
      positions.set([Math.cos(angle) * radius, -7 + ((i * 0.618034) % 1) * 28, Math.sin(angle) * radius - 12], i * 3)
    }
    return { radial: new Float32Array(radial), positions }
  }, [])
  useFrame(({ clock }) => {
    const time = clock.elapsedTime
    if (core.current) {
      core.current.rotation.x = 0.18 + Math.sin(time * 0.055) * 0.1
      core.current.rotation.y = time * 0.025
    }
    if (particles.current) {
      particles.current.rotation.y = time * 0.006
      particles.current.position.y = Math.sin(time * 0.12) * 0.45
    }
  })
  return (
    <>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[radial, 3]} />
        </bufferGeometry>
        <DetailLineMaterial color="#5a899b" transparent opacity={0.18} depthWrite={false} />
      </lineSegments>
      <group ref={core} rotation={[0.18, 0, 0]} position={[0, 0, -4]}>
        <mesh>
          <icosahedronGeometry args={[20, 0]} />
          <DetailMeshMaterial color="#9bbcb7" wireframe transparent opacity={0.3} depthWrite={false} />
        </mesh>
        <mesh rotation={[0, 0.35, Math.PI / 5]}>
          <icosahedronGeometry args={[17.8, 0]} />
          <DetailMeshMaterial color="#6d94b3" wireframe transparent opacity={0.1} depthWrite={false} />
        </mesh>
      </group>
      <points ref={particles}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <DetailPointsMaterial color="#83b7c2" size={0.065} transparent opacity={0.45} depthWrite={false} />
      </points>
      <PulseWave phase={0.12} />
      <PulseWave phase={0.45} />
      <PulseWave phase={0.78} />
      <fog attach="fog" args={['#091c22', 28, 95]} />
    </>
  )
}

export function XRayPulseBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 8, 38], fov: 65, near: 0.1, far: 130 }}
        style={{ background: 'radial-gradient(ellipse at 50% 58%, #172d30 0%, #0c1b22 100%)' }}
      >
        <Scanner />
      </Canvas>
    </div>
  )
}

export default XRayPulseBackground
