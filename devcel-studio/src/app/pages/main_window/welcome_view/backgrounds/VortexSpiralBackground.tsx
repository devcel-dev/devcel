import { DetailShaderMaterial } from './WelcomeDetailMaterials';
import { Suspense, useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

function VortexSpiral() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const filament = useRef<THREE.ShaderMaterial>(null)
  const data = useMemo(() => {
    const count = 1800, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count)
    const color = new THREE.Color(), teal = new THREE.Color('#7aa6b4'), pearl = new THREE.Color('#b4c2cf')
    for (let i = 0; i < count; i++) {
      const strand = i % 3, t = Math.floor(i / 3) / 600
      const angle = t * Math.PI * 8 + strand * Math.PI * 2 / 3
      const radius = 11 + t * 12
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = t * 42 - 21
      positions[i * 3 + 2] = Math.sin(angle) * radius
      color.copy(teal).lerp(pearl, t * 0.8).multiplyScalar(0.86 + strand * 0.07).toArray(colors, i * 3)
      sizes[i] = 0.08 + (0.5 + Math.sin(i * 7.1) * 0.5) * 0.11
    }
    const linePositions = new Float32Array((count - 3) * 6)
    const lineColors = new Float32Array((count - 3) * 6)
    for (let i = 0; i < count - 3; i++) {
      for (let axis = 0; axis < 3; axis++) {
        linePositions[i * 6 + axis] = positions[i * 3 + axis]
        linePositions[i * 6 + 3 + axis] = positions[(i + 3) * 3 + axis]
        lineColors[i * 6 + axis] = colors[i * 3 + axis]
        lineColors[i * 6 + 3 + axis] = colors[(i + 3) * 3 + axis]
      }
    }
    return { positions, colors, sizes, linePositions, lineColors, uniforms: { time: { value: 0 } } }
  }, [])
  useFrame(({ clock }) => {
    if (material.current) material.current.uniforms.time.value = clock.elapsedTime
    if (filament.current) filament.current.uniforms.time.value = clock.elapsedTime
  })
  return <group>
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data.linePositions, 3]} />
        <bufferAttribute attach="attributes-color" args={[data.lineColors, 3]} />
      </bufferGeometry>
      <DetailShaderMaterial ref={filament} uniforms={data.uniforms} vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending}
        vertexShader={`
          uniform float time; varying vec3 vColor; varying float vFade;
          void main(){
            vColor=color;
            float a=time*0.075+sin(time*0.18+position.y*0.07)*0.025;
            vec3 p=position;
            p.xz=mat2(cos(a),-sin(a),sin(a),cos(a))*p.xz;
            p.xz*=1.0+sin(position.y*0.15+time*0.22)*0.018;
            vec4 view=modelViewMatrix*vec4(p,1.0);
            vFade=clamp((78.0+view.z)/48.0,0.3,1.0);
            gl_Position=projectionMatrix*view;
          }
        `}
        fragmentShader={`
          varying vec3 vColor; varying float vFade;
          void main(){
            gl_FragColor=vec4(vColor,0.34*vFade);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `}
      />
    </lineSegments>
    <points>
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
      <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
      <bufferAttribute attach="attributes-size" args={[data.sizes, 1]} />
    </bufferGeometry>
    <DetailShaderMaterial ref={material} uniforms={data.uniforms} vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending}
      vertexShader={`
        attribute float size; uniform float time; varying vec3 vColor;
        void main(){
          vColor = color;
          float a = time * 0.075 + sin(time * 0.18 + position.y * 0.07) * 0.025;
          vec3 p = position;
          p.xz = mat2(cos(a),-sin(a),sin(a),cos(a)) * p.xz;
          p.xz *= 1.0 + sin(position.y * 0.15 + time * 0.22) * 0.018;
          vec4 view = modelViewMatrix * vec4(p,1.0);
          gl_PointSize = clamp(size * 650.0 / -view.z, 1.4, 4.5);
          gl_Position = projectionMatrix * view;
        }
      `}
      fragmentShader={`varying vec3 vColor; void main(){ float a=1.0-smoothstep(0.0,0.5,length(gl_PointCoord-0.5)); gl_FragColor=vec4(vColor,a*0.7);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
 }`}
    />
    </points>
  </group>
}

function VortexCore() {
  return <mesh>
    <cylinderGeometry args={[9.7, 9.7, 42, 32, 1, true]} />
    <DetailShaderMaterial transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending}
      vertexShader={`varying vec3 vNormal; varying vec3 vView; varying vec2 vUv; void main(){vNormal=normalize(normalMatrix*normal); vec4 p=modelViewMatrix*vec4(position,1.0); vView=-p.xyz; vUv=uv; gl_Position=projectionMatrix*p;}`}
      fragmentShader={`varying vec3 vNormal; varying vec3 vView; varying vec2 vUv; void main(){float rim=pow(1.0-abs(dot(normalize(vNormal),normalize(vView))),3.0); float fade=sin(vUv.y*3.14159); gl_FragColor=vec4(0.22,0.38,0.43,rim*fade*0.018);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
}`}
    />
  </mesh>
}

export function VortexSpiralBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 bg-[#0d1822] ${className || ''}`}>
    <Suspense fallback={null}>
      <Canvas camera={{ position: [0, 3, 43], fov: 60 }} style={{ position: 'absolute', inset: 0 }}>
        <color attach="background" args={['#0d1822']} />
        <fog attach="fog" args={['#0d1822', 42, 95]} />
        <group rotation={[0.1, 0, -0.2]}><VortexCore /><VortexSpiral /></group>
      </Canvas>
    </Suspense>
  </div>
}

export default VortexSpiralBackground
