import { DetailLineMaterial, DetailMeshMaterial } from './WelcomeDetailMaterials';
import { useMemo, useRef, Suspense } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

// A connected volume, not a collection of independently flickering draw calls.
function QuantumFieldScene() {
  const group = useRef<THREE.Group>(null)
  const nodes = useRef<THREE.InstancedMesh>(null)
  const halos = useRef<THREE.InstancedMesh>(null)
  const lines = useRef<THREE.LineSegments>(null)
  const data = useMemo(() => {
    const count = 104
    const positions = new Float32Array(count * 3)
    const base = new Float32Array(count * 3)
    const pairs: number[] = []
    const degree = new Uint8Array(count)
    const random = (n: number) => { const value = Math.sin(n * 127.1 + 13.7) * 43758.5453; return value - Math.floor(value) }
    for (let i = 0; i < count; i++) {
      const theta = i * 2.399963
      const z = 1 - 2 * (i + 0.5) / count
      const radius = 19 + random(i + 1) * 12
      const ring = Math.sqrt(1 - z * z) * radius
      base[i * 3] = Math.cos(theta) * ring
      base[i * 3 + 1] = Math.sin(theta) * ring * 0.8
      base[i * 3 + 2] = z * radius * 0.65 - 5
      if (Math.abs(base[i * 3]) < 8 && Math.abs(base[i * 3 + 1]) < 7) base[i * 3] += base[i * 3] < 0 ? -8 : 8
    }
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const a = i * 3, b = j * 3
        const dx = base[a] - base[b], dy = base[a + 1] - base[b + 1], dz = base[a + 2] - base[b + 2]
        const crossesCenter = Math.abs((base[a] + base[b]) / 2) < 7 && Math.abs((base[a + 1] + base[b + 1]) / 2) < 6
        if (dx * dx + dy * dy + dz * dz < 105 && degree[i] < 3 && degree[j] < 3 && !crossesCenter) {
          pairs.push(i, j); degree[i]++; degree[j]++
        }
      }
    }
    return { count, base, positions, pairs, segments: new Float32Array(pairs.length * 3), dummy: new THREE.Object3D(), color: new THREE.Color(), colorsInitialized: false }
  }, [])

  useFrame(({ clock }) => {
    if (!nodes.current || !halos.current || !lines.current || !group.current) return
    const time = clock.elapsedTime
    group.current.rotation.y = Math.sin(time * 0.035) * 0.12
    group.current.rotation.z = Math.sin(time * 0.025) * 0.025
    for (let i = 0; i < data.count; i++) {
      const offset = i * 0.71, p = i * 3
      data.positions[p] = data.base[p] + Math.sin(time * 0.24 + offset) * 0.35
      data.positions[p + 1] = data.base[p + 1] + Math.cos(time * 0.19 + offset) * 0.3
      data.positions[p + 2] = data.base[p + 2] + Math.sin(time * 0.16 + offset) * 0.3
      data.dummy.position.fromArray(data.positions, p)
      const pulse = 0.9 + Math.sin(time * 0.5 + offset) * 0.1
      data.dummy.scale.setScalar((0.13 + (i % 4) * 0.028) * pulse)
      data.dummy.updateMatrix()
      nodes.current.setMatrixAt(i, data.dummy.matrix)
      data.dummy.scale.multiplyScalar(2.6)
      data.dummy.updateMatrix()
      halos.current.setMatrixAt(i, data.dummy.matrix)
      if (!data.colorsInitialized) {
        data.color.set(i % 5 === 0 ? '#bdcdd0' : i % 3 === 0 ? '#8fb8be' : '#829dac')
        nodes.current.setColorAt(i, data.color)
      }
    }
    // One geometry follows the same node positions, so connections never detach.
    data.pairs.forEach((node, i) => {
      data.segments[i * 3] = data.positions[node * 3]
      data.segments[i * 3 + 1] = data.positions[node * 3 + 1]
      data.segments[i * 3 + 2] = data.positions[node * 3 + 2]
    })
    lines.current.geometry.attributes.position.needsUpdate = true
    nodes.current.instanceMatrix.needsUpdate = true
    if (!data.colorsInitialized && nodes.current.instanceColor) nodes.current.instanceColor.needsUpdate = true
    data.colorsInitialized = true
    halos.current.instanceMatrix.needsUpdate = true
  })

  return (
    <group ref={group}>
      <ambientLight intensity={0.8} />
      <directionalLight position={[8, 12, 20]} intensity={1.5} color="#d3e1e7" />
      <instancedMesh ref={nodes} args={[undefined, undefined, data.count]} frustumCulled={false}>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial color="#ffffff" emissive="#1e3039" emissiveIntensity={0.2} roughness={0.32} metalness={0.15} />
      </instancedMesh>
      <instancedMesh ref={halos} args={[undefined, undefined, data.count]} frustumCulled={false}>
        <icosahedronGeometry args={[1, 1]} />
        <DetailMeshMaterial color="#7ba0ac" transparent opacity={0.045} depthWrite={false} blending={THREE.AdditiveBlending} />
      </instancedMesh>
      <lineSegments ref={lines} frustumCulled={false}>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[data.segments, 3]} /></bufferGeometry>
        <DetailLineMaterial color="#66818c" transparent opacity={0.2} depthWrite={false} />
      </lineSegments>
      {[-18, 18].map(y => (
        <mesh key={y} position={[0, y, -12]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[85, 60, 16, 12]} />
          <DetailMeshMaterial color="#344d5a" transparent opacity={0.075} wireframe depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}

export function QuantumFieldBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 bg-[#070d1a] ${className || ''}`}>
      <Suspense fallback={null}>
        <Canvas camera={{ position: [0, 0, 40], fov: 65 }} style={{ position: 'absolute', inset: 0 }}>
          <color attach="background" args={['#070d1a']} />
          <fog attach="fog" args={['#070d1a', 35, 85]} />
          <QuantumFieldScene />
        </Canvas>
      </Suspense>
    </div>
  )
}

export default QuantumFieldBackground
