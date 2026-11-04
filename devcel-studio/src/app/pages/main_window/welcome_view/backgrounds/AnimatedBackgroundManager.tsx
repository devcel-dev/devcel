import { t, useI18n } from '@/app/i18n';
import { useState, useEffect, useMemo } from 'react'
import { AnimatedBackgroundProps, AnimatedBackgroundComponent } from './types'

// Import all backgrounds
import { CosmicOrbBackground } from './CosmicOrbBackground'
import { ParticleWaveBackground } from './ParticleWaveBackground'
import { GeometricTunnelBackground } from './GeometricTunnelBackground'
import { NeuralNetworkBackground } from './NeuralNetworkBackground'
import { AbstractMandalaBackground } from './AbstractMandalaBackground'
import { CrystalCaveBackground } from './CrystalCaveBackground'
import { DNAHelixBackground } from './DNAHelixBackground'
import { FractalTreeBackground } from './FractalTreeBackground'
import { GalaxySwirBackground } from './GalaxySwirBackground'
import { HolographicGridBackground } from './HolographicGridBackground'
import { InfinityMirrorBackground } from './InfinityMirrorBackground'
import { NorthernLightsBackground } from './NorthernLightsBackground'
import { OceanWavesBackground } from './OceanWavesBackground'
import { QuantumFieldBackground } from './QuantumFieldBackground'
import { RibbonDanceBackground } from './RibbonDanceBackground'
import { TerrainMeshBackground } from './TerrainMeshBackground'
import { VortexSpiralBackground } from './VortexSpiralBackground'
import { WormholeBackground } from './WormholeBackground'
import { XRayPulseBackground } from './XRayPulseBackground'
import { YinYangFlowBackground } from './YinYangFlowBackground'
import { AtomicOrbitalBackground } from './AtomicOrbitalBackground'
import { BinaryStarsBackground } from './BinaryStarsBackground'
import { ThreeBodyProblemBackground } from './ThreeBodyProblemBackground'

// List of available backgrounds
const backgrounds: AnimatedBackgroundComponent[] = [
  {
    component: CosmicOrbBackground,
    get name() { return t('welcome.background.cosmicOrb.name'); },
    get description() { return t('welcome.background.cosmicOrb.description'); }
  },
  {
    component: ParticleWaveBackground,
    get name() { return t('welcome.background.particleWave.name'); },
    get description() { return t('welcome.background.particleWave.description'); }
  },
  {
    component: GeometricTunnelBackground,
    get name() { return t('welcome.background.geometricTunnel.name'); },
    get description() { return t('welcome.background.geometricTunnel.description'); }
  },
  {
    component: NeuralNetworkBackground,
    get name() { return t('welcome.background.neuralNetwork.name'); },
    get description() { return t('welcome.background.neuralNetwork.description'); }
  },
  {
    component: AbstractMandalaBackground,
    get name() { return t('welcome.background.abstractMandala.name'); },
    get description() { return t('welcome.background.abstractMandala.description'); }
  },
  {
    component: CrystalCaveBackground,
    get name() { return t('welcome.background.crystalCave.name'); },
    get description() { return t('welcome.background.crystalCave.description'); }
  },
  {
    component: DNAHelixBackground,
    get name() { return t('welcome.background.dnaHelix.name'); },
    get description() { return t('welcome.background.dnaHelix.description'); }
  },
  {
    component: FractalTreeBackground,
    get name() { return t('welcome.background.fractalTree.name'); },
    get description() { return t('welcome.background.fractalTree.description'); }
  },
  {
    component: GalaxySwirBackground,
    get name() { return t('welcome.background.galaxySwirl.name'); },
    get description() { return t('welcome.background.galaxySwirl.description'); }
  },
  {
    component: HolographicGridBackground,
    get name() { return t('welcome.background.holographicGrid.name'); },
    get description() { return t('welcome.background.holographicGrid.description'); }
  },
  {
    component: InfinityMirrorBackground,
    get name() { return t('welcome.background.infinityMirror.name'); },
    get description() { return t('welcome.background.infinityMirror.description'); }
  },
  {
    component: NorthernLightsBackground,
    get name() { return t('welcome.background.northernLights.name'); },
    get description() { return t('welcome.background.northernLights.description'); }
  },
  {
    component: OceanWavesBackground,
    get name() { return t('welcome.background.oceanWaves.name'); },
    get description() { return t('welcome.background.oceanWaves.description'); }
  },
  {
    component: QuantumFieldBackground,
    get name() { return t('welcome.background.quantumField.name'); },
    get description() { return t('welcome.background.quantumField.description'); }
  },
  {
    component: RibbonDanceBackground,
    get name() { return t('welcome.background.ribbonDance.name'); },
    get description() { return t('welcome.background.ribbonDance.description'); }
  },
  {
    component: TerrainMeshBackground,
    get name() { return t('welcome.background.terrainMesh.name'); },
    get description() { return t('welcome.background.terrainMesh.description'); }
  },
  {
    component: VortexSpiralBackground,
    get name() { return t('welcome.background.vortexSpiral.name'); },
    get description() { return t('welcome.background.vortexSpiral.description'); }
  },
  {
    component: WormholeBackground,
    get name() { return t('welcome.background.wormhole.name'); },
    get description() { return t('welcome.background.wormhole.description'); }
  },
  {
    component: XRayPulseBackground,
    get name() { return t('welcome.background.xRayPulse.name'); },
    get description() { return t('welcome.background.xRayPulse.description'); }
  },
  {
    component: YinYangFlowBackground,
    get name() { return t('welcome.background.yinYangFlow.name'); },
    get description() { return t('welcome.background.yinYangFlow.description'); }
  },
  {
    component: AtomicOrbitalBackground,
    get name() { return t('welcome.background.atomicOrbital.name'); },
    get description() { return t('welcome.background.atomicOrbital.description'); }
  },
  {
    component: BinaryStarsBackground,
    get name() { return t('welcome.background.binaryStars.name'); },
    get description() { return t('welcome.background.binaryStars.description'); }
  },
  {
    component: ThreeBodyProblemBackground,
    get name() { return t('welcome.background.threeBodyProblem.name'); },
    get description() { return t('welcome.background.threeBodyProblem.description'); }
  }
]

interface AnimatedBackgroundManagerProps extends AnimatedBackgroundProps {
  debugMode?: boolean
}

export function AnimatedBackgroundManager({ className, debugMode = false }: AnimatedBackgroundManagerProps) {
  useI18n();
  const [currentBackgroundIndex, setCurrentBackgroundIndex] = useState<number>(() => {
    // Choose once per welcome-screen mount in production and development.
    // Parent/locale rerenders must not replace the scene or restart its animation.
    return Math.floor(Math.random() * backgrounds.length)
  })
  
  const CurrentBackground = useMemo(() => {
    return backgrounds[currentBackgroundIndex].component
  }, [currentBackgroundIndex])
  
  // Debug controls
  useEffect(() => {
    if (debugMode) {
      // Add keyboard shortcuts for testing
      const handleKeyPress = (e: KeyboardEvent) => {
        // Preview shortcuts must not consume typing, sliders or modified navigation.
        const target = e.target instanceof HTMLElement ? e.target : null
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          setCurrentBackgroundIndex((prev) => (prev + 1) % backgrounds.length)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          setCurrentBackgroundIndex((prev) => (prev - 1 + backgrounds.length) % backgrounds.length)
        } else if (e.key === 'r' || e.key === 'R') {
          setCurrentBackgroundIndex(Math.floor(Math.random() * backgrounds.length))
        }
      }
      
      window.addEventListener('keydown', handleKeyPress)
      return () => window.removeEventListener('keydown', handleKeyPress)
    }
  }, [debugMode])
  
  
  return (
    <>
      <CurrentBackground className={className} />
      
      {/* Debug overlay */}
      {debugMode && (
        <div className="fixed bottom-4 left-4 z-50 bg-black/80 text-white p-4 rounded-lg text-sm">
          <div className="font-bold mb-2">{t('welcome.background.debug.title')}</div>
          <div>{t('welcome.background.debug.current', { name: backgrounds[currentBackgroundIndex].name })}</div>
          <div className="text-xs text-gray-300 mt-1">
            {backgrounds[currentBackgroundIndex].description}
          </div>
          <div className="mt-2 text-xs text-gray-400">
            {t('welcome.background.debug.shortcuts')}
          </div>
        </div>
      )}
    </>
  )
}

// Export individual backgrounds for direct use if needed
export { CosmicOrbBackground, ParticleWaveBackground, GeometricTunnelBackground, NeuralNetworkBackground }

export default AnimatedBackgroundManager