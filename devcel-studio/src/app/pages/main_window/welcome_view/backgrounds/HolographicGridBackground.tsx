import { DetailMeshMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BackgroundCanvas as Canvas } from './BackgroundCanvas';
import { AnimatedBackgroundProps } from './types';

function Grid({ height, phase }: { height: number; phase: number }) {
  const material=useRef<THREE.ShaderMaterial>(null);
  const uniforms=useMemo(()=>({time:{value:0},phase:{value:phase}}),[phase]);
  useFrame(({clock})=>{if(material.current)material.current.uniforms.time.value=clock.elapsedTime;});
  return <mesh rotation={[-Math.PI/2,0,0]} position={[0,height,-10]}><planeGeometry args={[100,100,32,32]} />
    <DetailShaderMaterial ref={material} uniforms={uniforms} transparent depthWrite={false} side={THREE.DoubleSide}
      vertexShader={`uniform float time;uniform float phase;varying vec2 vUv;varying vec3 vPos;
        void main(){vUv=uv;vec3 p=position;p.z=sin(p.x*.09+time*.14+phase)*cos(p.y*.075)*.9;vPos=p;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`}
      fragmentShader={`uniform float time;varying vec2 vUv;varying vec3 vPos;
        void main(){vec2 cell=vUv*32.;vec2 d=abs(fract(cell-.5)-.5)/max(fwidth(cell),vec2(.001));
          float grid=1.-min(min(d.x,d.y),1.);float distance=length(vPos.xy);
          float mask=smoothstep(7.,17.,distance)*(1.-smoothstep(32.,60.,distance));
          float scan=exp(-pow((vPos.y-mod(time*1.1,100.)+50.)/2.8,2.));
          vec3 col=mix(vec3(.19,.32,.36),vec3(.43,.52,.55),scan);
          gl_FragColor=vec4(col,grid*mask*(.24+scan*.24));
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
}`} />
  </mesh>;
}
function Structures(){
  const group=useRef<THREE.Group>(null);
  useFrame(({clock})=>{if(group.current)group.current.rotation.y=Math.sin(clock.elapsedTime*.05)*.09;});
  return <group ref={group}>{[-1,1].flatMap(side=>[0,1,2].map(i=><mesh key={`${side}-${i}`} position={[side*(20+i*4),-3+i*5,-i*12]} rotation={[.1,i*.4,.08]}>
    {i%2?<octahedronGeometry args={[2.6,0]} />:<boxGeometry args={[2.6,4,2.6]} />}
    <DetailMeshMaterial color={i%2?'#98a7ae':'#8daead'} wireframe transparent opacity={.18} />
  </mesh>))}</group>;
}
export function HolographicGridBackground({className}:AnimatedBackgroundProps){
  return <div className={`absolute inset-0 ${className||''}`}><Canvas camera={{position:[0,12,36],fov:55}}>
    <color attach="background" args={['#14232f']} /><Grid height={-7} phase={0}/><Grid height={9} phase={2}/><Structures/>
  </Canvas></div>;
}
export default HolographicGridBackground;
