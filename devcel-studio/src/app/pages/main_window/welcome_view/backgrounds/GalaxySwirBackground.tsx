import { DetailPointsMaterial, DetailMeshMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { Suspense, useRef, useMemo } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function GalaxyArms() {
  const group = useRef<THREE.Group>(null)
  const data = useMemo(() => {
    const count = 4400, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count)
    const color = new THREE.Color(), inner = new THREE.Color('#cbd9da'), outer = new THREE.Color('#7b9fae')
    const random = (n: number) => { const x = Math.sin(n * 127.1 + 3.9) * 43758.5453; return x - Math.floor(x) }
    for (let i = 0; i < count; i++) {
      const arm = i % 4, t = Math.floor(i / 4) / 1100
      const radius = 8.5 + t * 24 + (random(i + 1) - 0.5) * (1.8 + t * 2.8)
      const angle = arm * Math.PI * 0.5 + t * Math.PI * 2.1 + (random(i + 9) - 0.5) * 0.18
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = (random(i + 24) - 0.5) * (1.6 - t)
      positions[i * 3 + 2] = Math.sin(angle) * radius
      color.copy(inner).lerp(outer, t).multiplyScalar(0.68 + random(i + 41) * 0.32).toArray(colors, i * 3)
      sizes[i] = 0.07 + Math.pow(random(i + 57), 3) * 0.16
    }
    return { positions, colors, sizes }
  }, [])
  useFrame(({ clock }) => { if (group.current) group.current.rotation.y = clock.elapsedTime * 0.012 })
  return <group ref={group}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]}>
      <planeGeometry args={[72, 72]} />
      <DetailShaderMaterial transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending}
        vertexShader={`varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
        fragmentShader={`
          varying vec2 vUv;
          void main(){
            vec2 p=(vUv-0.5)*72.0;
            float r=length(p), angle=atan(-p.y,p.x);
            float t=(r-8.5)/24.0;
            float arm=pow(0.5+0.5*cos(4.0*(angle-t*6.59734)),9.0+2.0*sin(r*0.27));
            float dust=0.68+0.18*sin(r*2.1+angle*7.0)+0.14*sin(r*5.3-angle*11.0);
            float fade=smoothstep(7.0,11.0,r)*(1.0-smoothstep(25.0,33.0,r));
            vec3 tint=mix(vec3(0.48,0.56,0.59),vec3(0.18,0.34,0.43),clamp(t,0.0,1.0));
            gl_FragColor=vec4(tint,arm*dust*fade*0.28);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `}
      />
    </mesh>
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
        <bufferAttribute attach="attributes-size" args={[data.sizes, 1]} />
      </bufferGeometry>
      <DetailShaderMaterial vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending}
        vertexShader={`attribute float size; varying vec3 vColor; void main(){ vColor = color; vec4 view = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(size * 720.0 / -view.z, 1.4, 5.0); gl_Position = projectionMatrix * view; }`}
        fragmentShader={`varying vec3 vColor; void main(){ float a = 1.0 - smoothstep(0.0, 0.5, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vColor, a * 0.8);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
 }`}
      />
    </points>
  </group>
}

function BlackHole() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(() => ({ time: { value: 0 } }), [])
  useFrame(({ clock }) => { if (material.current) material.current.uniforms.time.value = clock.elapsedTime })
  return <group rotation={[-Math.PI / 2, 0, 0]}>
    <mesh><circleGeometry args={[3.4, 48]} /><DetailMeshMaterial color="#060915" side={THREE.DoubleSide} /></mesh>
    <mesh>
      <ringGeometry args={[3.6, 9, 96]} />
      <DetailShaderMaterial ref={material} uniforms={uniforms} transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending}
        vertexShader={`varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`}
        fragmentShader={`
          uniform float time; varying vec2 vUv;
          void main(){
            vec2 p = vUv - 0.5; float r = length(p); float a = atan(p.y,p.x);
            float bands = 0.7 + 0.3 * sin(r * 90.0 + a * 3.0 - time * 0.2);
            float alpha = smoothstep(0.19,0.25,r) * (1.0-smoothstep(0.25,0.5,r)) * bands * 0.22;
            vec3 color = mix(vec3(0.68,0.49,0.4),vec3(0.35,0.45,0.7),smoothstep(0.2,0.48,r));
            gl_FragColor=vec4(color,alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>

          }
        `}
      />
    </mesh>
  </group>
}

function NebulaClouds() {
  const clouds = useMemo(() => Array.from({ length: 5 }, (_, i) => ({
    x: Math.cos(i * Math.PI * 0.4 + 0.5) * (17 + i),
    z: Math.sin(i * Math.PI * 0.4 + 0.5) * (17 + i),
    uniforms: { tint: { value: new THREE.Color(i % 2 ? '#526e80' : '#3a687a') } },
  })), [])
  return <group>
    {clouds.map((cloud, i) => <mesh key={i} position={[cloud.x, -0.5, cloud.z]} rotation={[-Math.PI / 2, 0, i * 0.7]}>
      <planeGeometry args={[17, 11]} />
      <DetailShaderMaterial uniforms={cloud.uniforms} transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending}
        vertexShader={`varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`}
        fragmentShader={`uniform vec3 tint; varying vec2 vUv; void main(){ vec2 p=(vUv-0.5)*2.0; float a=pow(max(0.0,1.0-dot(p,p)),3.0); gl_FragColor=vec4(tint,a*0.095);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
 }`}
      />
    </mesh>)}
  </group>
}

function StarField() {
  const positions = useMemo(() => {
    const a = new Float32Array(900 * 3)
    for (let i = 0; i < 900; i++) {
      const theta = i * 2.399963, y = 1 - 2 * (i + 0.5) / 900, r = 80
      a[i * 3] = Math.cos(theta) * Math.sqrt(1-y*y) * r
      a[i * 3 + 1] = y * r
      a[i * 3 + 2] = Math.sin(theta) * Math.sqrt(1-y*y) * r
    }
    return a
  }, [])
  return <points>
    <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry>
    <DetailPointsMaterial size={0.1} color="#8495b5" transparent opacity={0.45} depthWrite={false} />
  </points>
}

export function GalaxySwirBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}>
    <Canvas camera={{ position: [0, 20, 35], fov: 60, near: 0.1, far: 180 }} style={{ background: 'radial-gradient(ellipse at 55% 60%, #14232f 0%, #0a131f 70%)' }}>
      <Suspense fallback={null}>
        <group rotation={[0.08, 0, -0.18]}>
          <GalaxyArms /><BlackHole /><NebulaClouds />
        </group>
        <StarField />
        <fog attach="fog" args={['#0a131f', 50, 130]} />
      </Suspense>
    </Canvas>
  </div>
}

export default GalaxySwirBackground
