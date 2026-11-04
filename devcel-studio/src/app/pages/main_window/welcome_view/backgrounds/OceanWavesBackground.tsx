import { DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BackgroundCanvas as Canvas } from './BackgroundCanvas';
import { AnimatedBackgroundProps } from './types';

function Ocean() {
  const material = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ time: { value: 0 } }), []);
  useFrame(({ clock }) => { if (material.current) material.current.uniforms.time.value = clock.elapsedTime; });
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -7, -25]}>
    <planeGeometry args={[180, 180, 96, 64]} />
    <DetailShaderMaterial ref={material} uniforms={uniforms} side={THREE.DoubleSide}
      vertexShader={`uniform float time; varying vec3 vPos; varying float vWave;
        void main() { vec3 p=position; float t=time*.15;
          float wave=sin(p.x*.17+t)*.7+sin(p.y*.2+t*.8)*.55+sin((p.x+p.y)*.11-t*.6)*.45;
          p.z=wave; vWave=wave; vPos=p; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); }`}
      fragmentShader={`uniform float time; varying vec3 vPos; varying float vWave;
        void main() {
          float depth=smoothstep(-55.,65.,vPos.y);
          vec3 col=mix(vec3(.012,.03,.043),vec3(.035,.07,.083),depth);
          float crest=smoothstep(.58,1.6,vWave);
          float lines=pow(.5+.5*sin(vPos.y*1.7+vWave*2.5),24.);
          float moon=exp(-pow((vPos.x+32.)/(7.+(1.-depth)*11.),2.))*lines*depth;
          col+=vec3(.06,.1,.1)*crest*.22+vec3(.24,.28,.25)*moon*.25;
          gl_FragColor=vec4(col,1.);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>

        }`} />
  </mesh>;
}

function Moon() {
  return <group position={[-25, 14, -62]}>
    <mesh><planeGeometry args={[34, 34]} /><DetailShaderMaterial transparent depthWrite={false}
      vertexShader={`varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`}
      fragmentShader={`varying vec2 vUv;void main(){float d=length(vUv-.5);gl_FragColor=vec4(.28,.38,.37,exp(-d*12.)*.18);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
}`} /></mesh>
    <mesh position={[0, 0, .1]}><circleGeometry args={[1.9, 48]} />
      <DetailShaderMaterial vertexShader={`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`}
        fragmentShader={`varying vec2 vUv;void main(){vec2 p=(vUv-.5)*2.;float r=dot(p,p);
          vec3 n=vec3(p,sqrt(max(0.,1.-r)));float light=.32+.68*max(0.,dot(n,normalize(vec3(-.4,.5,1.))));
          gl_FragColor=vec4(vec3(.32,.39,.35)*light,1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`} />
    </mesh>
  </group>;
}

export function OceanWavesBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}><Canvas camera={{ position: [0, 9, 42], fov: 55 }}>
    <color attach="background" args={['#121e27']} /><Moon /><Ocean />
  </Canvas></div>;
}
export default OceanWavesBackground;
