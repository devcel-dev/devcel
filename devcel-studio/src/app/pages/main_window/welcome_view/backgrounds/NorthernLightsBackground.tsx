import { DetailPointsMaterial, DetailShaderMaterial } from './WelcomeDetailMaterials';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BackgroundCanvas as Canvas } from './BackgroundCanvas';
import { AnimatedBackgroundProps } from './types';

function Aurora({ phase, opacity, position }: { phase: number; opacity: number; position: [number, number, number] }) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ time: { value: 0 }, phase: { value: phase }, opacity: { value: opacity } }), [phase, opacity]);
  useFrame(({ clock }) => { if (material.current) material.current.uniforms.time.value = clock.elapsedTime; });
  return (
    <mesh position={position}>
      <planeGeometry args={[100, 60, 48, 16]} />
      <DetailShaderMaterial ref={material} uniforms={uniforms} transparent depthWrite={false} side={THREE.DoubleSide}
        blending={THREE.AdditiveBlending}
        vertexShader={`varying vec2 vUv; uniform float time; uniform float phase;
          void main() { vUv=uv; vec3 p=position; p.z += sin(p.x*.065+time*.09+phase)*3.;
            gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); }`}
        fragmentShader={`varying vec2 vUv; uniform float time; uniform float phase; uniform float opacity;
          void main() {
            float x=vUv.x; float t=time*.052;
            float ridge=.48+sin(x*7.+t+phase)*.11+sin(x*15.-t*.7+phase)*.035;
            float height=vUv.y-ridge;
            float curtain=exp(-abs(height)*14.)*smoothstep(-.08,.035,height);
            float rays=.74+.16*sin(x*170.+sin(x*14.+t)*5.)+.1*sin(x*289.-t);
            float edge=smoothstep(0.,.12,x)*(1.-smoothstep(.87,1.,x));
            vec3 col=mix(vec3(.18,.39,.34),vec3(.45,.66,.59),clamp(height*4.,0.,1.));
            col=mix(col,vec3(.33,.40,.52),smoothstep(.12,.38,height)*.55);
            gl_FragColor=vec4(col,curtain*rays*edge*opacity);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>

          }`} />
    </mesh>
  );
}

/** A few continuous irregular ridges give scale without a row of repeated primitives. */
function Ridge({ layer }: { layer: number }) {
  const data = useMemo(() => {
    const positions = new Float32Array(97 * 6);
    const indices = new Uint16Array(96 * 6);
    for (let i = 0; i <= 96; i++) {
      const x = -110 + i / 96 * 220;
      const y = -23 - layer * 3 + Math.sin(x * .047 + layer * 2) * 4.5
        + Math.sin(x * .103 + layer) * 2.2 + Math.sin(x * .267 + layer * 1.7) * .8;
      positions.set([x, y, 0, x, -90, 0], i * 6);
      if (i < 96) indices.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
    }
    return { positions, indices };
  }, [layer]);
  return <mesh position={[0, 0, -38 + layer * 10]}>
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
      <bufferAttribute attach="index" args={[data.indices, 1]} />
    </bufferGeometry>
    <DetailShaderMaterial uniforms={{ shade: { value: layer } }}
      vertexShader={`varying float vHeight;void main(){vHeight=position.y;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`}
      fragmentShader={`varying float vHeight;uniform float shade;
        void main(){float haze=smoothstep(-53.,-15.,vHeight);
          vec3 col=mix(vec3(.014,.025,.032),vec3(.033,.068,.073),haze)*(1.-shade*.17);
          gl_FragColor=vec4(col,1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`} />
  </mesh>;
}

function NorthernLightsScene() {
  const stars = useMemo(() => {
    const p = new Float32Array(240 * 3);
    for (let i = 0; i < 240; i++) {
      p[i * 3] = Math.sin(i * 127.1) * 76;
      p[i * 3 + 1] = 4 + ((i * 37) % 101) * .35;
      p[i * 3 + 2] = -55 - ((i * 13) % 47);
    }
    return p;
  }, []);
  return <>
    <color attach="background" args={['#131e27']} />
    <points><bufferGeometry><bufferAttribute attach="attributes-position" args={[stars, 3]} /></bufferGeometry>
      <DetailPointsMaterial color="#c3d9de" size={.075} transparent opacity={.44} depthWrite={false} />
    </points>
    <Aurora phase={0} opacity={.72} position={[0, 6, -16]} />
    <Aurora phase={1.8} opacity={.38} position={[0, 10, -30]} />
    <Aurora phase={3.2} opacity={.2} position={[0, 13, -40]} />
    {[0, 1, 2].map(layer => <Ridge key={layer} layer={layer} />)}
  </>;
}

export function NorthernLightsBackground({ className }: AnimatedBackgroundProps) {
  return <div className={`absolute inset-0 ${className || ''}`}><Canvas camera={{ position: [0, 0, 40], fov: 60 }}><NorthernLightsScene /></Canvas></div>;
}
export default NorthernLightsBackground;
