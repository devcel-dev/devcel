import { DetailPointsMaterial, DetailMeshMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function WormholeTunnel() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const group = useRef<THREE.Group>(null)
  const uniforms = useMemo(() => ({ time: { value: 0 } }), [])
  useFrame(({ clock }) => {
    if (material.current) material.current.uniforms.time.value = clock.elapsedTime
    if (group.current) {
      group.current.rotation.z = clock.elapsedTime * 0.012
      group.current.rotation.y = Math.sin(clock.elapsedTime * 0.045) * 0.02
    }
  })
  return (
    <group ref={group}>
      {/* A tapered volume, rather than a full-screen reciprocal-distance shader. */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -31]}>
        <cylinderGeometry args={[19, 4, 80, 64, 8, true]} />
        <DetailShaderMaterial
          ref={material} side={THREE.BackSide} uniforms={uniforms} transparent depthWrite={false}
          vertexShader={`
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={`
            uniform float time;
            varying vec2 vUv;
            void main() {
              float spiral = vUv.x * 37.6991 + vUv.y * 23.0 - time * 0.16;
              float ribbon = pow(0.5 + 0.5 * sin(spiral), 10.0);
              float filament = pow(0.5 + 0.5 * sin(spiral + 0.15), 100.0);
              float secondary = pow(0.5 + 0.5 * sin(spiral - 0.24), 140.0);
              float depth = smoothstep(0.0, 0.75, vUv.y);
              float edgeFade = 1.0 - smoothstep(0.9, 1.0, vUv.y);
              vec3 steel = vec3(0.20, 0.34, 0.38);
              vec3 pearl = vec3(0.49, 0.57, 0.53);
              vec3 color = mix(steel, pearl, filament * 0.45);
              float alpha = (ribbon * 0.055 + filament * 0.28 + secondary * 0.09) * depth * edgeFade;
              gl_FragColor = vec4(color, alpha);
              #include <tonemapping_fragment>
              #include <colorspace_fragment>
            }
          `}
        />
      </mesh>
      {Array.from({ length: 14 }, (_, i) => (
        <mesh key={i} position={[0, 0, 8 - i * 5.65]}>
          <torusGeometry args={[18.8 - i * 1.06, 0.018, 4, 72]} />
          <DetailMeshMaterial color={i % 3 === 0 ? '#a5bcb9' : '#668d9c'} transparent opacity={i === 0 ? 0.1 : 0.11} depthWrite={false} />
        </mesh>
      ))}
      <mesh position={[0, 0, -72]}>
        <circleGeometry args={[4.2, 48]} />
        <DetailMeshMaterial color="#0b171e" />
      </mesh>
    </group>
  )
}

function OuterParticles() {
  const particles = useRef<THREE.Points>(null)
  const positions = useMemo(() => {
    const data = new Float32Array(240 * 3)
    for (let i = 0; i < 240; i++) {
      const angle = i * 2.399963
      const radius = 19.5 + (i % 23) * 0.43
      data.set([Math.cos(angle) * radius, Math.sin(angle) * radius, 12 - (i % 29) * 1.2], i * 3)
    }
    return data
  }, [])
  useFrame(({ clock }) => {
    if (particles.current) particles.current.rotation.z = clock.elapsedTime * 0.008
  })
  return (
    <points ref={particles}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <DetailPointsMaterial color="#91aeb6" size={0.045} transparent opacity={0.4} depthWrite={false} />
    </points>
  )
}

export function WormholeBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 0, 27], fov: 65, near: 0.1, far: 130 }}
        style={{ background: 'radial-gradient(ellipse at center, #182a32 0%, #0b171e 100%)' }}
      >
        <WormholeTunnel />
        <OuterParticles />
        <fog attach="fog" args={['#0b171e', 20, 105]} />
      </Canvas>
    </div>
  )
}

export default WormholeBackground
