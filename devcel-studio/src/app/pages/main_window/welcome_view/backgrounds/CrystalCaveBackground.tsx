import { DetailPointsMaterial, DetailMeshMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

const CRYSTAL_COLORS = ['#607b80', '#7b8e90', '#929b95', '#536e7a']

function createQuartzShape() {
  const positions: number[] = []
  const normals: number[] = []
  const normal = new THREE.Vector3()
  const edge = new THREE.Vector3()
  const face = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    normal.copy(b).sub(a).cross(edge.copy(c).sub(a)).normalize()
    positions.push(...a.toArray(), ...b.toArray(), ...c.toArray())
    for (let i = 0; i < 3; i++) normals.push(normal.x, normal.y, normal.z)
  }
  const bottom = Array.from({ length: 6 }, (_, i) => new THREE.Vector3(Math.cos(i * Math.PI / 3), 0, Math.sin(i * Math.PI / 3) * 0.85))
  const shoulder = bottom.map(point => new THREE.Vector3(point.x * 0.86, 2.8, point.z * 0.86))
  const tip = new THREE.Vector3(0.12, 4.1, -0.07)
  const base = new THREE.Vector3(0, 0, 0)
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6
    face(bottom[i], shoulder[i], shoulder[next])
    face(bottom[i], shoulder[next], bottom[next])
    face(shoulder[i], tip, shoulder[next])
    face(bottom[i], bottom[next], base)
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals) }
}

const QUARTZ = createQuartzShape()

function QuartzGeometry() {
  return (
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[QUARTZ.positions, 3]} />
      <bufferAttribute attach="attributes-normal" args={[QUARTZ.normals, 3]} />
    </bufferGeometry>
  )
}

function CrystalCluster() {
  const cluster = useRef<THREE.Group>(null)
  const dust = useRef<THREE.Points>(null)
  const { crystals, particles } = useMemo(() => {
    const crystals = Array.from({ length: 20 }, (_, i) => {
      const side = i % 2 === 0 ? -1 : 1
      const tier = Math.floor(i / 2)
      const ceiling = tier >= 7
      return {
        position: [side * (12.2 + (tier % 4) * 2.6), ceiling ? 19.5 : -18.5 - (tier % 3) * 0.7, 3 - Math.floor(tier / 3) * 6] as [number, number, number],
        rotation: [ceiling ? Math.PI - 0.13 : 0.13, tier * 0.67, side * (0.1 + (tier % 3) * 0.055)] as [number, number, number],
        size: 1.25 + (tier % 3) * 0.28,
        color: CRYSTAL_COLORS[tier % CRYSTAL_COLORS.length],
      }
    })
    const particles = new Float32Array(240 * 3)
    for (let i = 0; i < 240; i++) {
      const angle = i * 2.399963
      const radius = 12 + (i % 23) * 0.46
      particles.set([Math.cos(angle) * radius, Math.sin(angle) * radius * 0.8, 6 - (i % 47) * 0.6], i * 3)
    }
    return { crystals, particles }
  }, [])
  useFrame(({ clock }) => {
    const time = clock.elapsedTime
    if (cluster.current) cluster.current.rotation.y = Math.sin(time * 0.035) * 0.012
    if (dust.current) dust.current.position.y = Math.sin(time * 0.09) * 0.24
  })
  return (
    <>
      <group ref={cluster}>
        {crystals.map((crystal, i) => (
          <group key={i} position={crystal.position} rotation={crystal.rotation} scale={crystal.size}>
            {/* Six-sided quartz grows from the cave edges, rather than floating like chips. */}
            <mesh scale={[0.82, 1.8, 0.72]}>
              <QuartzGeometry />
              <meshStandardMaterial color={crystal.color} emissive="#24383b" emissiveIntensity={0.04} metalness={0.38} roughness={0.22} />
            </mesh>
            <mesh scale={[0.824, 1.803, 0.724]}>
              <QuartzGeometry />
              <DetailMeshMaterial color="#d1ddd5" wireframe transparent opacity={0.055} depthWrite={false} />
            </mesh>
            <mesh position={[0.7, 0.2, 0.15]} rotation={[0, 0.3, -0.2]} scale={[0.4, 1.08, 0.38]}>
              <QuartzGeometry />
              <meshStandardMaterial color={crystal.color} metalness={0.3} roughness={0.3} />
            </mesh>
          </group>
        ))}
      </group>
      <points ref={dust}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[particles, 3]} />
        </bufferGeometry>
        <DetailPointsMaterial color="#b0c5c7" size={0.038} transparent opacity={0.28} depthWrite={false} />
      </points>
    </>
  )
}

function Scene() {
  const keyLight = useRef<THREE.DirectionalLight>(null)
  useFrame(({ clock }) => {
    if (keyLight.current) keyLight.current.position.x = -10 + Math.sin(clock.elapsedTime * 0.07) * 3
  })
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight ref={keyLight} position={[-10, 18, 20]} intensity={2.8} color="#e1e7db" />
      <directionalLight position={[12, -6, 5]} intensity={1.2} color="#8faebc" />
      <CrystalCluster />
      <mesh rotation={[0.15, 0.1, 0]}>
        <icosahedronGeometry args={[55, 1]} />
        <meshStandardMaterial color="#12222a" roughness={0.95} side={THREE.BackSide} flatShading />
      </mesh>
      <fog attach="fog" args={['#0c1a21', 25, 70]} />
    </>
  )
}

export function CrystalCaveBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 0, 26], fov: 60, near: 0.1, far: 110 }}
        style={{ background: 'radial-gradient(ellipse at 50% 38%, #1b2d31 0%, #0c1a21 100%)' }}
      >
        <Scene />
      </Canvas>
    </div>
  )
}

export default CrystalCaveBackground
