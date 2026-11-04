import { DetailPointsMaterial, DetailMeshMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

const LAYER_COLORS = ['#aebfbd', '#879fa5', '#b6c1bd', '#8ca5aa', '#97a9b0', '#a9b8b8']

function MandalaLayer({ index }: { index: number }) {
  const group = useRef<THREE.Group>(null)
  const petals = useRef<THREE.InstancedMesh>(null)
  const count = 12 + index * 2
  const radius = 10.5 + index * 2.7

  useLayoutEffect(() => {
    if (!petals.current) return
    const transform = new THREE.Object3D()
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2
      transform.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0)
      transform.rotation.set(0.15, 0, angle - Math.PI / 2)
      transform.scale.set(0.44 + index * 0.03, 1.6 + index * 0.09, 0.45)
      transform.updateMatrix()
      petals.current.setMatrixAt(i, transform.matrix)
    }
    petals.current.instanceMatrix.needsUpdate = true
  }, [count, index, radius])

  useFrame(({ clock }) => {
    if (!group.current) return
    const time = clock.elapsedTime
    group.current.rotation.z = index * 0.14 + time * (index % 2 ? -1 : 1) * (0.019 - index * 0.0015)
    group.current.position.z = -index * 0.85 + Math.sin(time * 0.14 + index * 0.65) * 0.22
  })

  return (
    <group ref={group} position={[0, 0, -index * 0.85]} rotation={[0, 0, index * 0.14]}>
      <instancedMesh ref={petals} args={[undefined, undefined, count]} frustumCulled={false}>
        <torusGeometry args={[1, 0.035, 4, 24]} />
        <meshStandardMaterial
          color={LAYER_COLORS[index]}
          emissive={LAYER_COLORS[index]}
          emissiveIntensity={0.08}
          metalness={0.65}
          roughness={0.34}
          transparent
          opacity={0.64 - index * 0.04}
          depthWrite={false}
        />
      </instancedMesh>
      <mesh rotation={[0, 0, Math.PI / count]}>
        <torusGeometry args={[radius, 0.025, 4, count * 2]} />
        <DetailMeshMaterial color={LAYER_COLORS[index]} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      {index % 2 === 0 && (
        <mesh>
          <torusGeometry args={[radius + 0.65, 0.018, 4, 96]} />
          <DetailMeshMaterial color={LAYER_COLORS[index]} transparent opacity={0.09} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

function Mandala() {
  const group = useRef<THREE.Group>(null)
  const particles = useRef<THREE.Points>(null)
  const positions = useMemo(() => {
    const data = new Float32Array(260 * 3)
    for (let i = 0; i < 260; i++) {
      const angle = i * 2.399963
      const radius = 12 + (i % 43) * 0.42
      data.set([Math.cos(angle) * radius, Math.sin(angle) * radius, -9 + (i % 13) * 0.65], i * 3)
    }
    return data
  }, [])
  useFrame(({ clock }) => {
    if (group.current) {
      group.current.rotation.x = 0.13 + Math.sin(clock.elapsedTime * 0.07) * 0.045
      group.current.rotation.y = Math.sin(clock.elapsedTime * 0.055) * 0.06
    }
    if (particles.current) particles.current.rotation.z = -clock.elapsedTime * 0.008
  })
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[-10, 14, 18]} intensity={1.6} color="#c4d9ef" />
      <directionalLight position={[12, -8, 5]} intensity={0.7} color="#c2c9c4" />
      <group ref={group} rotation={[0.13, 0, 0]}>
        {Array.from({ length: 6 }, (_, i) => <MandalaLayer key={i} index={i} />)}
      </group>
      <points ref={particles}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <DetailPointsMaterial color="#9aafb3" size={0.04} transparent opacity={0.26} depthWrite={false} />
      </points>
      <fog attach="fog" args={['#0e181f', 34, 73]} />
    </>
  )
}

export function AbstractMandalaBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 0, 31], fov: 60, near: 0.1, far: 100 }}
        style={{ background: 'radial-gradient(ellipse at center, #1b2b30 0%, #0e181f 100%)' }}
      >
        <Mandala />
      </Canvas>
    </div>
  )
}

export default AbstractMandalaBackground
