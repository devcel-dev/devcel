import { DetailMeshMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { Suspense, useRef, useMemo } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function WaveParticles() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const points = useRef<THREE.Points>(null)
  const data = useMemo(() => {
    const count = 1800
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const sizes = new Float32Array(count)
    const phases = new Float32Array(count)
    const color = new THREE.Color()
    for (let i = 0; i < count; i++) {
      const t = i / count, angle = t * Math.PI * 16
      const radius = 10 + t * 9 + Math.sin(i * 12.9898) * 0.45
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = Math.sin(angle) * radius * 0.72
      positions[i * 3 + 2] = Math.sin(angle * 2 + t * 8) * 1.5
      phases[i] = angle * 1.5
      sizes[i] = 0.075 + (0.5 + Math.sin(i * 7.13) * 0.5) * 0.09
      color.setHSL(0.51 + t * 0.12, 0.34, 0.59)
      color.toArray(colors, i * 3)
    }
    return { positions, colors, sizes, phases, uniforms: { time: { value: 0 } } }
  }, [])
  useFrame(({ clock }) => {
    if (material.current) material.current.uniforms.time.value = clock.elapsedTime
    if (points.current) points.current.rotation.z = Math.sin(clock.elapsedTime * 0.045) * 0.09 - 0.2
  })
  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
        <bufferAttribute attach="attributes-size" args={[data.sizes, 1]} />
        <bufferAttribute attach="attributes-phase" args={[data.phases, 1]} />
      </bufferGeometry>
      <DetailShaderMaterial ref={material} uniforms={data.uniforms} vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending}
        vertexShader={`
          attribute float size;
          attribute float phase;
          uniform float time;
          varying vec3 vColor;
          void main() {
            vColor = color;
            vec3 p = position;
            p.y += sin(time * 0.28 + phase) * 0.55;
            p.z += cos(time * 0.22 + phase) * 0.4;
            vec4 view = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = clamp(size * (420.0 / -view.z), 1.0, 5.0);
            gl_Position = projectionMatrix * view;
          }
        `}
        fragmentShader={`
          varying vec3 vColor;
          void main() {
            float r = length(gl_PointCoord - 0.5);
            float alpha = (1.0 - smoothstep(0.05, 0.5, r)) * 0.7;
            gl_FragColor = vec4(vColor, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>

          }
        `}
      />
    </points>
  )
}

function EnergyRibbons() {
  const group = useRef<THREE.Group>(null)
  const curves = useMemo(() => Array.from({ length: 4 }, (_, i) => {
    const points = Array.from({ length: 65 }, (_, j) => {
      const a = j / 64 * Math.PI * 2
      const radius = 10.8 + i * 1.8 + Math.sin(a * 3 + i) * 0.6
      return new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * 0.72, Math.sin(a * 2 + i) * 1.7)
    })
    return new THREE.CatmullRomCurve3(points, true)
  }), [])
  useFrame(({ clock }) => {
    if (!group.current) return
    group.current.rotation.z = -0.2 + Math.sin(clock.elapsedTime * 0.045) * 0.09
    group.current.rotation.x = Math.sin(clock.elapsedTime * 0.06) * 0.07
  })
  return (
    <group ref={group}>
      {curves.map((curve, i) => (
        <mesh key={i}>
          <tubeGeometry args={[curve, 128, 0.022, 4, true]} />
          <DetailMeshMaterial color={['#7bb2ba', '#93aebe', '#b0bbc9', '#8196ad'][i]} transparent opacity={0.5} depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}

function FloatingShapes() {
  const group = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    group.current?.children.forEach((child, i) => {
      child.rotation.x = clock.elapsedTime * 0.045 + i
      child.rotation.y = clock.elapsedTime * 0.06
    })
  })
  return (
    <group ref={group}>
      {Array.from({ length: 8 }, (_, i) => {
        const a = i / 8 * Math.PI * 2, r = 16 + (i % 3)
        return <mesh key={i} position={[Math.cos(a) * r, Math.sin(a) * r * 0.75, -3 + i % 4]}>
          <octahedronGeometry args={[0.28 + (i % 3) * 0.09]} />
          <DetailMeshMaterial color={i % 2 ? '#9aaeba' : '#79a3ad'} wireframe transparent opacity={0.3} depthWrite={false} />
        </mesh>
      })}
    </group>
  )
}

export function ParticleWaveBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas camera={{ position: [0, 0, 22], fov: 60, near: 0.1, far: 100 }} style={{ background: 'radial-gradient(ellipse at 25% 65%, #152a35 0%, #0c1824 50%, #131d2b 100%)' }}>
        <Suspense fallback={null}>
          <WaveParticles />
          <EnergyRibbons />
          <FloatingShapes />
          <fog attach="fog" args={['#0b1525', 24, 65]} />
        </Suspense>
      </Canvas>
    </div>
  )
}

export default ParticleWaveBackground
