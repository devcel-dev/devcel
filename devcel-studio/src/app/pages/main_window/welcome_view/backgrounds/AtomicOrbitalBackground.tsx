import { DetailPointsMaterial, DetailLineMaterial, DetailMeshMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { Suspense, useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function ElectronOrbit({ radius, speed, tilt, phase }: { radius: number; speed: number; tilt: number; phase: number }) {
  const electron = useRef<THREE.Group>(null)
  const trail = useRef<THREE.Points>(null)
  const data = useMemo(() => {
    const orbit = new Float32Array(128 * 3)
    for (let i = 0; i < 128; i++) {
      const a = i / 128 * Math.PI * 2
      orbit[i * 3] = Math.cos(a) * radius
      orbit[i * 3 + 2] = Math.sin(a) * radius
    }
    const tail = new Float32Array(14 * 3)
    const colors = new Float32Array(14 * 3)
    const color = new THREE.Color('#9edce2')
    for (let i = 0; i < 14; i++) color.clone().multiplyScalar(0.65 * (1 - i / 14)).toArray(colors, i * 3)
    return { orbit, tail, colors }
  }, [radius])
  useFrame(({ clock }) => {
    const angle = clock.elapsedTime * speed * 0.12 + phase
    electron.current?.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
    if (!trail.current) return
    for (let i = 0; i < 14; i++) {
      const a = angle - (i + 1) * 0.018
      data.tail[i * 3] = Math.cos(a) * radius
      data.tail[i * 3 + 2] = Math.sin(a) * radius
    }
    trail.current.geometry.attributes.position.needsUpdate = true
  })
  return (
    <group rotation={[tilt, phase * 0.2, 0]}>
      <lineLoop>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[data.orbit, 3]} /></bufferGeometry>
        <DetailLineMaterial color="#85afcf" transparent opacity={0.4} depthWrite={false} />
      </lineLoop>
      <group ref={electron} position={[Math.cos(phase) * radius, 0, Math.sin(phase) * radius]}>
        <mesh><sphereGeometry args={[0.22, 12, 8]} /><meshStandardMaterial color="#c1d8da" emissive="#527e8b" emissiveIntensity={0.24} roughness={0.28} metalness={0.12} /></mesh>
        <mesh><sphereGeometry args={[0.46, 12, 8]} /><DetailMeshMaterial color="#85b0bd" transparent opacity={0.055} depthWrite={false} blending={THREE.AdditiveBlending} /></mesh>
      </group>
      <points ref={trail} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[data.tail, 3]} />
          <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
        </bufferGeometry>
        <DetailPointsMaterial size={0.13} vertexColors transparent opacity={0.7} depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>
    </group>
  )
}

function Nucleus() {
  const group = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    if (!group.current) return
    group.current.rotation.x = clock.elapsedTime * 0.06
    group.current.rotation.y = clock.elapsedTime * 0.09
  })
  return (
    <group ref={group}>
      {Array.from({ length: 12 }, (_, i) => {
        const phi = Math.acos(1 - 2 * (i + 0.5) / 12), theta = i * 2.399963
        return <mesh key={i} position={[Math.cos(theta) * Math.sin(phi) * 1.1, Math.sin(theta) * Math.sin(phi) * 1.1, Math.cos(phi) * 1.1]}>
          <sphereGeometry args={[0.47, 16, 12]} />
          <meshStandardMaterial color={i % 2 ? '#9aafbd' : '#b7b7bf'} emissive={i % 2 ? '#526c7a' : '#6c7380'} emissiveIntensity={0.3} roughness={0.45} metalness={0.25} />
        </mesh>
      })}
    </group>
  )
}

function OrbitalCloud() {
  const cloud = useRef<THREE.Points>(null)
  const material = useRef<THREE.ShaderMaterial>(null)
  const data = useMemo(() => {
    const count = 1400, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3)
    const color = new THREE.Color()
    for (let i = 0; i < count; i++) {
      const a = i * 2.399963, y = 1 - 2 * (i + 0.5) / count
      const r = 12 + (0.5 + Math.sin(i * 127.1) * 0.5) * 12
      positions[i * 3] = Math.cos(a) * Math.sqrt(1 - y * y) * r
      positions[i * 3 + 1] = y * r
      positions[i * 3 + 2] = Math.sin(a) * Math.sqrt(1 - y * y) * r
      color.setHSL(0.53 + (i % 5) * 0.014, 0.28, 0.48).toArray(colors, i * 3)
    }
    return { positions, colors, uniforms: { time: { value: 0 } } }
  }, [])
  useFrame(({ clock }) => {
    if (cloud.current) cloud.current.rotation.y = clock.elapsedTime * 0.018
    if (material.current) material.current.uniforms.time.value = clock.elapsedTime
  })
  return <points ref={cloud}>
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
      <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
    </bufferGeometry>
    <DetailShaderMaterial ref={material} uniforms={data.uniforms} vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending}
      vertexShader={`
        uniform float time;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec3 p = position * (1.0 + 0.012 * sin(time * 0.23 + position.y));
          vec4 view = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(62.0 / -view.z, 1.0, 2.8);
          gl_Position = projectionMatrix * view;
        }
      `}
      fragmentShader={`
        varying vec3 vColor;
        void main() {
          float a = 1.0 - smoothstep(0.0, 0.5, length(gl_PointCoord - 0.5));
          gl_FragColor = vec4(vColor, a * 0.5);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>

        }
      `}
    />
  </points>
}

export function AtomicOrbitalBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 bg-[#0d1723] ${className || ''}`}>
    <Suspense fallback={null}>
      <Canvas camera={{ position: [0, 10, 40], fov: 60 }} style={{ position: 'absolute', inset: 0 }}>
        <color attach="background" args={['#0d1723']} />
        <fog attach="fog" args={['#0d1723', 36, 85]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[8, 12, 20]} intensity={1.6} color="#c5d9f4" />
        <group rotation={[0.15, 0, -0.15]}>
          <Nucleus />
          <ElectronOrbit radius={12} speed={1} tilt={0} phase={0} />
          <ElectronOrbit radius={15} speed={0.8} tilt={Math.PI / 4} phase={Math.PI / 3} />
          <ElectronOrbit radius={18} speed={0.6} tilt={-Math.PI / 4} phase={Math.PI * 2 / 3} />
          <ElectronOrbit radius={14} speed={1.2} tilt={Math.PI / 6} phase={Math.PI} />
          <ElectronOrbit radius={16} speed={0.9} tilt={-Math.PI / 6} phase={Math.PI * 4 / 3} />
          <ElectronOrbit radius={20} speed={0.7} tilt={Math.PI / 3} phase={Math.PI * 5 / 3} />
        </group>
        <OrbitalCloud />
      </Canvas>
    </Suspense>
  </div>
}

export default AtomicOrbitalBackground
