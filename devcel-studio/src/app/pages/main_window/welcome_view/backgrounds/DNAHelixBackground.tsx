import { DetailPointsMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

const PAIR_COUNT = 42

function DNAStrand({ side }: { side: number }) {
  const group = useRef<THREE.Group>(null)
  const atoms = useRef<THREE.InstancedMesh>(null)
  const bonds = useRef<THREE.InstancedMesh>(null)
  const { first, second, pairs } = useMemo(() => {
    const first: THREE.Vector3[] = []
    const second: THREE.Vector3[] = []
    const pairs: [THREE.Vector3, THREE.Vector3][] = []
    for (let i = 0; i <= 126; i++) {
      const t = i / 126
      const angle = t * Math.PI * 5.5
      first.push(new THREE.Vector3(Math.cos(angle) * 2.65, (t - 0.5) * 44, Math.sin(angle) * 2.65))
      second.push(new THREE.Vector3(-Math.cos(angle) * 2.65, (t - 0.5) * 44, -Math.sin(angle) * 2.65))
    }
    for (let i = 0; i < PAIR_COUNT; i++) pairs.push([first[i * 3], second[i * 3]])
    return { first: new THREE.CatmullRomCurve3(first), second: new THREE.CatmullRomCurve3(second), pairs }
  }, [])

  useLayoutEffect(() => {
    if (!atoms.current || !bonds.current) return
    const transform = new THREE.Object3D()
    const direction = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const color = new THREE.Color()
    pairs.forEach(([start, end], i) => {
      for (let j = 0; j < 2; j++) {
        transform.position.copy(j === 0 ? start : end)
        transform.quaternion.identity()
        transform.scale.setScalar(0.11)
        transform.updateMatrix()
        atoms.current!.setMatrixAt(i * 2 + j, transform.matrix)
      }
      transform.position.copy(start).add(end).multiplyScalar(0.5)
      direction.copy(end).sub(start)
      transform.scale.set(0.038, direction.length(), 0.038)
      transform.quaternion.setFromUnitVectors(up, direction.normalize())
      transform.updateMatrix()
      bonds.current!.setMatrixAt(i, transform.matrix)
      color.set(i % 3 === 0 ? '#a8b8b5' : '#739ba2')
      bonds.current!.setColorAt(i, color)
    })
    atoms.current.instanceMatrix.needsUpdate = true
    bonds.current.instanceMatrix.needsUpdate = true
    if (bonds.current.instanceColor) bonds.current.instanceColor.needsUpdate = true
  }, [pairs])

  useFrame(({ clock }) => {
    if (!group.current) return
    group.current.rotation.y = side * 0.5 + clock.elapsedTime * 0.045 * side
    group.current.position.y = Math.sin(clock.elapsedTime * 0.09 + side) * 0.3
  })

  return (
    <group ref={group} position={[side * 13.2, 0, side === 1 ? -3 : 1]} rotation={[0, side * 0.5, side * -0.13]}>
      <mesh>
        <tubeGeometry args={[first, 126, 0.064, 5, false]} />
        <meshStandardMaterial color="#a7c4cf" metalness={0.4} roughness={0.4} emissive="#4e7488" emissiveIntensity={0.22} />
      </mesh>
      <mesh>
        <tubeGeometry args={[second, 126, 0.064, 5, false]} />
        <meshStandardMaterial color="#a8b8ba" metalness={0.4} roughness={0.4} emissive="#4b6570" emissiveIntensity={0.22} />
      </mesh>
      <instancedMesh ref={atoms} args={[undefined, undefined, PAIR_COUNT * 2]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 6]} />
        <meshStandardMaterial color="#c5d8de" metalness={0.3} roughness={0.42} />
      </instancedMesh>
      <instancedMesh ref={bonds} args={[undefined, undefined, PAIR_COUNT]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 5]} />
        <meshStandardMaterial metalness={0.25} roughness={0.5} emissive="#456679" emissiveIntensity={0.2} />
      </instancedMesh>
    </group>
  )
}

function Molecules() {
  const particles = useRef<THREE.Points>(null)
  const positions = useMemo(() => {
    const data = new Float32Array(300 * 3)
    for (let i = 0; i < 300; i++) {
      data.set([(i % 2 ? -1 : 1) * (9 + (i % 31) * 0.53), ((i * 0.618034) % 1 - 0.5) * 45, 7 - (i % 23)], i * 3)
    }
    return data
  }, [])
  useFrame(({ clock }) => {
    if (!particles.current) return
    particles.current.position.y = Math.sin(clock.elapsedTime * 0.08) * 0.4
    particles.current.rotation.y = Math.sin(clock.elapsedTime * 0.035) * 0.035
  })
  return (
    <points ref={particles}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <DetailPointsMaterial color="#91b9c7" size={0.045} transparent opacity={0.4} depthWrite={false} />
    </points>
  )
}

export function DNAHelixBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 0, 28], fov: 60, near: 0.1, far: 100 }}
        style={{ background: 'radial-gradient(ellipse at 50% 45%, #14262d 0%, #0b171e 100%)' }}
      >
        <ambientLight intensity={0.8} />
        <directionalLight position={[-8, 12, 15]} intensity={1.7} color="#c5deea" />
        <directionalLight position={[12, -8, 6]} intensity={0.9} color="#afc6c5" />
        <DNAStrand side={-1} />
        <DNAStrand side={1} />
        <Molecules />
        <fog attach="fog" args={['#0b171e', 25, 70]} />
      </Canvas>
    </div>
  )
}

export default DNAHelixBackground
