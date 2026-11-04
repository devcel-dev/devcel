import { DetailPointsMaterial, DetailLineMaterial, DetailMeshMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { Suspense, useRef, useMemo } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function GlowingOrb() {
  const group = useRef<THREE.Group>(null)
  const inner = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (group.current) {
      group.current.rotation.y = clock.elapsedTime * 0.055
      group.current.rotation.x = 0.2 + Math.sin(clock.elapsedTime * 0.08) * 0.08
    }
    if (inner.current) inner.current.rotation.z = -clock.elapsedTime * 0.07
  })
  return <group position={[5, -3, 1]}>
    <group ref={group}>
      <mesh><icosahedronGeometry args={[2, 1]} /><DetailMeshMaterial color="#b7c8cf" wireframe transparent opacity={0.38} depthWrite={false} /></mesh>
      <mesh ref={inner}><octahedronGeometry args={[1.4, 0]} /><DetailMeshMaterial color="#92afb7" wireframe transparent opacity={0.4} depthWrite={false} /></mesh>
      <mesh><sphereGeometry args={[1.85, 24, 16]} /><meshStandardMaterial color="#293e4d" emissive="#1e303d" emissiveIntensity={0.18} roughness={0.38} metalness={0.2} transparent opacity={0.16} depthWrite={false} /></mesh>
      {[0, 1, 2].map(i => <mesh key={i} rotation={[i * Math.PI / 3, i * Math.PI / 4, 0]}>
        <torusGeometry args={[2.42, 0.007, 4, 96]} />
        <DetailMeshMaterial color="#98adb8" transparent opacity={0.34} depthWrite={false} />
      </mesh>)}
    </group>
  </group>
}

function GeometricConstellation() {
  const group = useRef<THREE.Group>(null)
  const positions: [number, number, number][] = [[-3,2,-1],[3,1,-2],[-2,-2,1],[2,-3,0],[0,3,-1]]
  useFrame(({ clock }) => {
    group.current?.children.forEach((mesh, i) => {
      mesh.rotation.x = clock.elapsedTime * (0.035 + i * 0.008)
      mesh.rotation.y = clock.elapsedTime * (0.05 + i * 0.008)
    })
  })
  return <group ref={group} position={[5,-3,1]}>
    {positions.map((position,i) => <mesh key={i} position={position}>
      {i % 2 ? <octahedronGeometry args={[0.3]} /> : <tetrahedronGeometry args={[0.35]} />}
      <DetailMeshMaterial color={i % 2 ? '#9cafba' : '#7f9eac'} wireframe transparent opacity={0.36} depthWrite={false} />
    </mesh>)}
  </group>
}

function ParticleField() {
  const points = useRef<THREE.Points>(null)
  const data = useMemo(() => {
    const count = 950, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3)
    const color = new THREE.Color()
    const random = (n: number) => { const x = Math.sin(n * 127.1 + 1.3) * 43758.5453; return x - Math.floor(x) }
    for (let i = 0; i < count; i++) {
      const t = random(i + 1), spread = (random(i + 14) - 0.5) * 4
      positions[i * 3] = -16 + t * 32 + spread * 0.6
      positions[i * 3 + 1] = 11 - t * 22 + spread
      positions[i * 3 + 2] = -8 + random(i + 35) * 8
      color.set(i % 3 === 0 ? '#acbdc6' : '#82a3b5').multiplyScalar(0.55 + random(i + 63) * 0.45).toArray(colors, i * 3)
    }
    return { positions, colors }
  }, [])
  useFrame(({ clock }) => {
    if (!points.current) return
    points.current.rotation.z = Math.sin(clock.elapsedTime * 0.025) * 0.025
    points.current.position.y = Math.sin(clock.elapsedTime * 0.05) * 0.12
  })
  return <points ref={points}>
    <bufferGeometry><bufferAttribute attach="attributes-position" args={[data.positions,3]} /><bufferAttribute attach="attributes-color" args={[data.colors,3]} /></bufferGeometry>
    <DetailPointsMaterial size={0.026} vertexColors transparent opacity={0.48} depthWrite={false} blending={THREE.AdditiveBlending} />
  </points>
}

function EnergyGrid() {
  const positions = useMemo(() => {
    const endpoints = [[-5,-5,-2],[12,-5,-2],[5,-8,-2],[8,4,-3],[-5,4,-8],[15,0,-5]]
    return new Float32Array(endpoints.flatMap(point => [5,-3,1,...point]))
  }, [])
  return <lineSegments><bufferGeometry><bufferAttribute attach="attributes-position" args={[positions,3]} /></bufferGeometry><DetailLineMaterial color="#7e9aa8" transparent opacity={0.07} depthWrite={false} /></lineSegments>
}

function NebulaCloud() {
  const uniforms = useMemo(() => ({ tint: { value: new THREE.Color('#58788d') } }), [])
  return <mesh position={[5,-3,-4]} rotation={[0,0,-0.45]}>
    <planeGeometry args={[18,14]} />
    <DetailShaderMaterial uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending}
      vertexShader={`varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`}
      fragmentShader={`uniform vec3 tint; varying vec2 vUv; void main(){vec2 p=(vUv-0.5)*2.0; float a=pow(max(0.0,1.0-dot(p,p)),3.0); gl_FragColor=vec4(tint,a*0.17);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
}`}
    />
  </mesh>
}

export function CosmicOrbBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}>
    <Canvas camera={{ position:[0,0,10],fov:75,near:0.1,far:100 }} style={{ background:'radial-gradient(ellipse at 75% 80%, #1b2b38 0%, #111c29 45%, #0b1420 100%)' }}>
      <Suspense fallback={null}>
        <ambientLight intensity={0.7} /><directionalLight position={[6,4,8]} intensity={1.5} color="#a6b4db" />
        <NebulaCloud /><ParticleField /><EnergyGrid /><GlowingOrb /><GeometricConstellation />
        <fog attach="fog" args={['#0e1925',16,40]} />
      </Suspense>
    </Canvas>
  </div>
}

export default CosmicOrbBackground
