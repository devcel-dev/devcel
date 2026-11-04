import { DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BackgroundCanvas as Canvas } from './BackgroundCanvas';
import { AnimatedBackgroundProps } from './types';

function Terrain() {
  const material = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ time: { value: 0 } }), []);
  useFrame(({ clock }) => { if (material.current) material.current.uniforms.time.value = clock.elapsedTime; });
  return <mesh rotation={[-Math.PI / 2, 0, -.08]} position={[0, -10, -18]}>
    <planeGeometry args={[130, 120, 64, 64]} />
    <DetailShaderMaterial ref={material} uniforms={uniforms} wireframe transparent depthWrite={false}
      vertexShader={`uniform float time; varying float vHeight; varying vec2 vPos;
        void main(){vec3 p=position; float t=time*.08;
          float ridge=sin(p.x*.065+t)*cos(p.y*.07)*5.+sin(p.x*.14-p.y*.08)*2.2;
          float edge=smoothstep(5.,25.,abs(p.x)); p.z=ridge*edge;
          vHeight=p.z;vPos=p.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`}
      fragmentShader={`varying float vHeight; varying vec2 vPos;
        void main(){float elevation=clamp((vHeight+7.)/14.,0.,1.);
          vec3 col=mix(vec3(.10,.18,.21),vec3(.29,.43,.39),elevation);
          col=mix(col,vec3(.49,.51,.45),smoothstep(.7,1.,elevation)*.55);
          float edge=1.-smoothstep(38.,65.,length(vPos*.8));
          float depth=mix(.38,.72,smoothstep(-55.,35.,vPos.y));
          gl_FragColor=vec4(col,edge*depth);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
}`} />
  </mesh>;
}
export function TerrainMeshBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}><Canvas camera={{ position: [0, 18, 50], fov: 55 }}>
    <color attach="background" args={['#16242e']} /><Terrain />
  </Canvas></div>;
}
export default TerrainMeshBackground;
