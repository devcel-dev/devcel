import { DetailPointsMaterial, DetailLineMaterial, DetailMeshMaterial } from './WelcomeDetailMaterials';
import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BackgroundCanvas as Canvas } from './BackgroundCanvas'
import { AnimatedBackgroundProps } from './types'

const LAYERS = 5
const NODES_PER_LAYER = 10
const PULSES = 18

function NeuralNetwork() {
  const group = useRef<THREE.Group>(null)
  const nodesMesh = useRef<THREE.InstancedMesh>(null)
  const pulsesMesh = useRef<THREE.InstancedMesh>(null)
  const transform = useMemo(() => new THREE.Object3D(), [])
  const { nodes, connections, lines, positions, dust } = useMemo(() => {
    const nodes: THREE.Vector3[] = []
    const connections: [number, number][] = []
    const lines: number[] = []
    for (let layer = 0; layer < LAYERS; layer++) {
      for (let i = 0; i < NODES_PER_LAYER; i++) {
        const angle = i / NODES_PER_LAYER * Math.PI * 2 + layer * 0.12
        const radius = 10.8 + layer * 0.65
        nodes.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.83, 5 - layer * 6))
      }
    }
    // Connect real adjacent layers. Local neighbours leave the central aperture clear.
    for (let layer = 0; layer < LAYERS - 1; layer++) {
      for (let i = 0; i < NODES_PER_LAYER; i++) {
        for (let next = 0; next < 2; next++) {
          const source = layer * NODES_PER_LAYER + i
          const target = (layer + 1) * NODES_PER_LAYER + (i + next) % NODES_PER_LAYER
          connections.push([source, target])
          lines.push(...nodes[source].toArray(), ...nodes[target].toArray())
        }
        const source = layer * NODES_PER_LAYER + i
        const target = layer * NODES_PER_LAYER + (i + 1) % NODES_PER_LAYER
        lines.push(...nodes[source].toArray(), ...nodes[target].toArray())
      }
    }
    const positions = new Float32Array(nodes.flatMap(node => node.toArray()))
    const dust = new Float32Array(180 * 3)
    for (let i = 0; i < 180; i++) {
      const angle = i * 2.399963
      const radius = 13 + (i % 13) * 0.6
      dust.set([Math.cos(angle) * radius, Math.sin(angle) * radius, 2 - (i % 37)], i * 3)
    }
    return { nodes, connections, lines: new Float32Array(lines), positions, dust }
  }, [])

  useLayoutEffect(() => {
    if (!nodesMesh.current) return
    const color = new THREE.Color()
    nodes.forEach((position, i) => {
      transform.position.copy(position)
      transform.scale.setScalar(i % 3 === 0 ? 0.12 : 0.09)
      transform.updateMatrix()
      nodesMesh.current!.setMatrixAt(i, transform.matrix)
      color.set(i % 3 === 0 ? '#b0cbc7' : '#8aabb6')
      nodesMesh.current!.setColorAt(i, color)
    })
    nodesMesh.current.instanceMatrix.needsUpdate = true
    if (nodesMesh.current.instanceColor) nodesMesh.current.instanceColor.needsUpdate = true
  }, [nodes, transform])

  useFrame(({ clock }) => {
    const time = clock.elapsedTime
    if (group.current) {
      group.current.rotation.y = Math.sin(time * 0.055) * 0.07
      group.current.rotation.z = Math.sin(time * 0.04) * 0.035
    }
    if (!pulsesMesh.current) return
    for (let i = 0; i < PULSES; i++) {
      const [source, target] = connections[(i * 7) % connections.length]
      const progress = (time * 0.13 + i * 0.137) % 1
      transform.position.lerpVectors(nodes[source], nodes[target], progress)
      transform.scale.setScalar(0.085 * Math.sin(progress * Math.PI))
      transform.updateMatrix()
      pulsesMesh.current.setMatrixAt(i, transform.matrix)
    }
    pulsesMesh.current.instanceMatrix.needsUpdate = true
  })

  return (
    <>
      <ambientLight intensity={1.2} />
      <directionalLight position={[-10, 15, 20]} intensity={1.2} color="#c9e3ef" />
      <group ref={group}>
        <instancedMesh ref={nodesMesh} args={[undefined, undefined, nodes.length]} frustumCulled={false}>
          <sphereGeometry args={[1, 10, 8]} />
          <meshStandardMaterial metalness={0.35} roughness={0.45} emissive="#416677" emissiveIntensity={0.45} />
        </instancedMesh>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[lines, 3]} />
          </bufferGeometry>
          <DetailLineMaterial color="#7499b8" transparent opacity={0.18} depthWrite={false} />
        </lineSegments>
        <points>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          </bufferGeometry>
          <DetailPointsMaterial color="#c3d7d0" size={0.34} transparent opacity={0.12} depthWrite={false} />
        </points>
        <instancedMesh ref={pulsesMesh} args={[undefined, undefined, PULSES]} frustumCulled={false}>
          <sphereGeometry args={[1, 8, 6]} />
          <DetailMeshMaterial color="#a6ded4" transparent opacity={0.8} depthWrite={false} />
        </instancedMesh>
        <points>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[dust, 3]} />
          </bufferGeometry>
          <DetailPointsMaterial color="#6d98b7" size={0.038} transparent opacity={0.36} depthWrite={false} />
        </points>
      </group>
      <fog attach="fog" args={['#0b171e', 18, 65]} />
    </>
  )
}

export function NeuralNetworkBackground({ className }: AnimatedBackgroundProps) {
  return (
    <div className={`absolute inset-0 ${className || ''}`}>
      <Canvas
        camera={{ position: [0, 0, 24], fov: 60, near: 0.1, far: 100 }}
        style={{ background: 'radial-gradient(ellipse at 50% 45%, #172a31 0%, #0b171e 100%)' }}
      >
        <NeuralNetwork />
      </Canvas>
    </div>
  )
}

export default NeuralNetworkBackground
