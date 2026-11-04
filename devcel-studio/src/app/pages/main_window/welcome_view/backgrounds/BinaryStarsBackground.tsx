import { DetailPointsMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { Suspense, useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function BinaryStar({ color, size, phase }: { color: string; size: number; phase: number }) {
  const group = useRef<THREE.Group>(null)
  const uniforms = useMemo(() => ({ color: { value: new THREE.Color(color) } }), [color])
  useFrame(({ clock }) => {
    if (!group.current) return
    const angle = clock.elapsedTime * 0.055 + phase
    group.current.position.set(Math.cos(angle) * 19, Math.sin(angle) * 12, Math.sin(angle) * 3)
  })
  return <group ref={group} position={[Math.cos(phase) * 19, Math.sin(phase) * 12, Math.sin(phase) * 3]}>
    <mesh>
      <sphereGeometry args={[size, 24, 16]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.14} roughness={0.34} metalness={0.12} />
    </mesh>
    <mesh rotation={[-0.2, 0, 0]}>
      <planeGeometry args={[size * 6, size * 6]} />
      <DetailShaderMaterial uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending}
        vertexShader={`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`}
        fragmentShader={`uniform vec3 color; varying vec2 vUv; void main(){ float r = length(vUv - 0.5); float a = pow(max(0.0, 1.0 - r * 2.0), 4.0) * 0.32; gl_FragColor = vec4(color, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
 }`}
      />
    </mesh>
  </group>
}

function AccretionDisk() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const data = useMemo(() => {
    const count = 2600, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3)
    const color = new THREE.Color(), warm = new THREE.Color('#c4ced1'), cool = new THREE.Color('#7698a7')
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count, angle = i * 2.399963 + Math.sin(i * 17.71) * 0.06
      const radius = 21 + t * 9 + Math.sin(i * 12.9898) * 0.35
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = Math.sin(i * 17.1) * (0.2 + t * 0.5)
      positions[i * 3 + 2] = Math.sin(angle) * radius
      color.copy(warm).lerp(cool, t).multiplyScalar(0.9 - t * 0.2).toArray(colors, i * 3)
    }
    return { positions, colors, uniforms: { time: { value: 0 } } }
  }, [])
  useFrame(({ clock }) => { if (material.current) material.current.uniforms.time.value = clock.elapsedTime })
  return <points rotation={[0.43, 0, 0.12]}>
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
      <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
    </bufferGeometry>
    <DetailShaderMaterial ref={material} uniforms={data.uniforms} vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending}
      vertexShader={`
        uniform float time; varying vec3 vColor;
        void main(){
          vColor = color;
          float a = time * 0.7 / length(position.xz);
          vec3 p = position;
          p.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * p.xz;
          vec4 view = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(95.0 / -view.z, 1.5, 4.0);
          gl_Position = projectionMatrix * view;
        }
      `}
      fragmentShader={`varying vec3 vColor; void main(){ float a = 1.0 - smoothstep(0.0, 0.5, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vColor, a * 0.68);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
 }`}
    />
  </points>
}

function GravitationalLensing() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(() => ({ time: { value: 0 } }), [])
  useFrame(({ clock }) => { if (material.current) material.current.uniforms.time.value = clock.elapsedTime })
  return <mesh position={[0, 0, -12]}>
    <planeGeometry args={[65, 45]} />
    <DetailShaderMaterial ref={material} uniforms={uniforms} transparent depthWrite={false}
      vertexShader={`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`}
      fragmentShader={`
        uniform float time; varying vec2 vUv;
        void main(){
          vec2 uv = vUv - 0.5; float r = length(uv);
          vec2 source = vec2(cos(time * 0.055) * 0.19, sin(time * 0.055) * 0.045);
          vec2 warp = uv + 0.0018 * (uv-source) / (dot(uv-source, uv-source)+0.025)
                         + 0.0018 * (uv+source) / (dot(uv+source, uv+source)+0.025);
          float grid = smoothstep(0.985, 1.0, cos(warp.x * 100.0)) + smoothstep(0.985, 1.0, cos(warp.y * 75.0));
          float a = grid * 0.022 * smoothstep(0.2, 0.34, r) * (1.0-smoothstep(0.42, 0.55, r));
          gl_FragColor = vec4(0.28, 0.39, 0.54, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>

        }
      `}
    />
  </mesh>
}

function StarField() {
  const positions = useMemo(() => {
    const array = new Float32Array(650 * 3)
    for (let i = 0; i < 650; i++) {
      const angle = i * 2.399963, y = 1 - 2 * (i + 0.5) / 650, radius = 60
      array[i * 3] = Math.cos(angle) * Math.sqrt(1-y*y) * radius
      array[i * 3 + 1] = y * radius
      array[i * 3 + 2] = Math.sin(angle) * Math.sqrt(1-y*y) * radius - 20
    }
    return array
  }, [])
  return <points><bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry><DetailPointsMaterial size={0.1} color="#9aacc8" transparent opacity={0.45} depthWrite={false} /></points>
}

export function BinaryStarsBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 bg-[#10121e] ${className || ''}`}>
    <Suspense fallback={null}>
      <Canvas camera={{ position: [0, 10, 45], fov: 60 }} style={{ position: 'absolute', inset: 0 }}>
        <color attach="background" args={['#10121e']} />
        <fog attach="fog" args={['#10121e', 40, 100]} />
        <ambientLight intensity={0.4} />
        <directionalLight position={[4, 8, 15]} intensity={2.2} color="#e3e9ed" />
        <group rotation={[0.08, 0, -0.18]}>
          <BinaryStar color="#d9d5ca" size={1.45} phase={0.25} />
          <BinaryStar color="#91b7c7" size={1.2} phase={Math.PI + 0.25} />
          <AccretionDisk />
        </group>
        <GravitationalLensing />
        <StarField />
      </Canvas>
    </Suspense>
  </div>
}

export default BinaryStarsBackground
