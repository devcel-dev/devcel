import { DetailPointsMaterial, DetailLineMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { Suspense, useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

const TRAIL_LENGTH = 320
const STEP = 1 / 240
const TRAIL_INTERVAL = 1 / 50
const BODY_COLORS = ['#bdc6d1', '#8fb8ba', '#b7bdb5']

interface Body {
  position: THREE.Vector3
  velocity: THREE.Vector3
  acceleration: THREE.Vector3
  history: Float32Array
  positions: Float32Array
  colors: Float32Array
}

// Equal-mass figure-eight initial conditions produce a bounded gravitational dance.
// Fixed-step leapfrog integration is stable across frame rates and tab pauses.
function updateAcceleration(bodies: Body[]) {
  for (const body of bodies) body.acceleration.set(0, 0, 0)
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const dx = bodies[j].position.x - bodies[i].position.x
      const dy = bodies[j].position.y - bodies[i].position.y
      const d2 = dx * dx + dy * dy + 0.0001
      const inv = 1 / (d2 * Math.sqrt(d2))
      bodies[i].acceleration.x += dx * inv
      bodies[i].acceleration.y += dy * inv
      bodies[j].acceleration.x -= dx * inv
      bodies[j].acceleration.y -= dy * inv
    }
  }
}
function integrate(bodies: Body[]) {
  for (const body of bodies) {
    body.velocity.addScaledVector(body.acceleration, STEP * 0.5)
    body.position.addScaledVector(body.velocity, STEP)
  }
  updateAcceleration(bodies)
  for (const body of bodies) body.velocity.addScaledVector(body.acceleration, STEP * 0.5)
}
function sampleTrail(bodies: Body[], cursor: number) {
  for (const body of bodies) {
    body.history[cursor * 3] = body.position.x * 20
    body.history[cursor * 3 + 1] = body.position.y * 20
    body.history[cursor * 3 + 2] = 0
  }
}

function BodyGlow({ color }: { color: string }) {
  const uniforms = useMemo(() => ({ tint: { value: new THREE.Color(color) } }), [color])
  return <mesh>
    <planeGeometry args={[2.2, 2.2]} />
    <DetailShaderMaterial uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending}
      vertexShader={`
        varying vec2 vUv;
        void main(){
          vUv=uv;
          vec4 center=modelViewMatrix*vec4(0.0,0.0,0.0,1.0);
          center.xy+=position.xy;
          gl_Position=projectionMatrix*center;
        }
      `}
      fragmentShader={`
        uniform vec3 tint; varying vec2 vUv;
        void main(){
          float r=length(vUv-0.5);
          float halo=pow(max(0.0,1.0-r*2.0),3.0);
          gl_FragColor=vec4(tint,halo*0.28);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `}
    />
  </mesh>
}

function ThreeBodySystem() {
  const group = useRef<THREE.Group>(null)
  const trailRefs = useRef<(THREE.LineSegments | null)[]>([])
  const simulation = useMemo(() => {
    const initial = [[-0.97000436,0.24308753,0.466203685,0.43236573],[0.97000436,-0.24308753,0.466203685,0.43236573],[0,0,-0.93240737,-0.86473146]]
    const bodies = initial.map((p, i): Body => {
      const colors = new Float32Array((TRAIL_LENGTH - 1) * 6), color = new THREE.Color(BODY_COLORS[i])
      for (let j = 0; j < (TRAIL_LENGTH - 1) * 2; j++) {
        const fade = 0.035 + Math.pow(Math.ceil(j / 2) / (TRAIL_LENGTH - 1), 2.1) * 0.6
        colors[j * 3] = color.r * fade; colors[j * 3 + 1] = color.g * fade; colors[j * 3 + 2] = color.b * fade
      }
      return { position: new THREE.Vector3(p[0],p[1],0), velocity: new THREE.Vector3(p[2],p[3],0), acceleration: new THREE.Vector3(), history: new Float32Array(TRAIL_LENGTH * 3), positions: new Float32Array((TRAIL_LENGTH - 1) * 6), colors }
    })
    for (let i = 0; i < TRAIL_LENGTH; i++) sampleTrail(bodies, i)
    updateAcceleration(bodies)
    let cursor = 0, sampleTime = 0
    // A complete, faded path is already visible in the reduced-motion first frame.
    for (let i = 0; i < Math.ceil(TRAIL_LENGTH * TRAIL_INTERVAL / STEP); i++) {
      integrate(bodies)
      sampleTime += STEP
      if (sampleTime >= TRAIL_INTERVAL) {
        sampleTime -= TRAIL_INTERVAL
        sampleTrail(bodies, cursor)
        cursor = (cursor + 1) % TRAIL_LENGTH
      }
    }
    return { bodies, cursor, sampleTime, accumulator: 0 }
  }, [])

  useFrame((_, delta) => {
    simulation.accumulator += Math.min(delta, 0.1) * 0.16
    while (simulation.accumulator >= STEP) {
      integrate(simulation.bodies)
      simulation.accumulator -= STEP
      simulation.sampleTime += STEP
      if (simulation.sampleTime >= TRAIL_INTERVAL) {
        simulation.sampleTime -= TRAIL_INTERVAL
        sampleTrail(simulation.bodies, simulation.cursor)
        simulation.cursor = (simulation.cursor + 1) % TRAIL_LENGTH
      }
    }
    simulation.bodies.forEach((body, i) => {
      group.current?.children[i]?.position.copy(body.position).multiplyScalar(20)
      for (let j = 0; j < (TRAIL_LENGTH - 1) * 2; j++) {
        const source = ((simulation.cursor + Math.ceil(j / 2)) % TRAIL_LENGTH) * 3, target = j * 3
        body.positions[target] = body.history[source]
        body.positions[target + 1] = body.history[source + 1]
        body.positions[target + 2] = body.history[source + 2]
      }
      const line = trailRefs.current[i]
      if (line) line.geometry.attributes.position.needsUpdate = true
    })
  })

  return <group rotation={[0.28, -0.18, -0.25]}>
    <group ref={group}>
      {simulation.bodies.map((body,i) => <group key={i} position={[body.position.x * 20, body.position.y * 20, 0]}>
        <mesh><sphereGeometry args={[0.38,20,12]} /><meshStandardMaterial color={BODY_COLORS[i]} emissive={BODY_COLORS[i]} emissiveIntensity={0.16} roughness={0.3} metalness={0.15} /></mesh>
        <BodyGlow color={BODY_COLORS[i]} />
      </group>)}
    </group>
    {simulation.bodies.map((body,i) => <lineSegments key={i} ref={value => { trailRefs.current[i] = value }} frustumCulled={false}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[body.positions,3]} /><bufferAttribute attach="attributes-color" args={[body.colors,3]} /></bufferGeometry>
      <DetailLineMaterial vertexColors transparent opacity={0.72} depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineSegments>)}
  </group>
}

function BackgroundStars() {
  const positions = useMemo(() => {
    const a = new Float32Array(800 * 3)
    for (let i = 0; i < 800; i++) {
      const theta = i * 2.399963, y = 1 - 2 * (i + 0.5) / 800, r = 75
      a[i * 3] = Math.cos(theta) * Math.sqrt(1-y*y) * r
      a[i * 3 + 1] = y * r
      a[i * 3 + 2] = Math.sin(theta) * Math.sqrt(1-y*y) * r - 20
    }
    return a
  }, [])
  return <points><bufferGeometry><bufferAttribute attach="attributes-position" args={[positions,3]} /></bufferGeometry><DetailPointsMaterial size={0.09} color="#879ab6" transparent opacity={0.45} depthWrite={false} /></points>
}

export function ThreeBodyProblemBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 bg-[#080f20] ${className || ''}`}>
    <Suspense fallback={null}>
      <Canvas camera={{ position:[0,0,40],fov:60 }} style={{ position:'absolute',inset:0 }}>
        <color attach="background" args={['#080f20']} /><fog attach="fog" args={['#080f20',50,130]} />
        <ambientLight intensity={0.65} /><directionalLight position={[5,8,12]} intensity={1.6} />
        <ThreeBodySystem /><BackgroundStars />
      </Canvas>
    </Suspense>
  </div>
}

export default ThreeBodyProblemBackground
