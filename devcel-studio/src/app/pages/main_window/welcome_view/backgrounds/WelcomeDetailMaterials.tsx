import { createContext, useContext, type ComponentProps } from 'react';

export const WelcomeLightScene = createContext(true);

// Small geometry must survive the scene's compositing and pixel budget. Opaque
// primary forms and the dark scene retain their original material parameters.
export function DetailPointsMaterial(props: ComponentProps<'pointsMaterial'>) {
  const light = useContext(WelcomeLightScene);
  return <pointsMaterial {...props}
    size={light ? Math.max(Number(props.size ?? 1), 0.085) : props.size}
    opacity={light ? Math.max(props.opacity ?? 1, 0.72) : props.opacity} />;
}
export function DetailLineMaterial(props: ComponentProps<'lineBasicMaterial'>) {
  const light = useContext(WelcomeLightScene);
  return <lineBasicMaterial {...props} opacity={light ? Math.max(props.opacity ?? 1, 0.58) : props.opacity} />;
}
export function DetailMeshMaterial(props: ComponentProps<'meshBasicMaterial'>) {
  const light = useContext(WelcomeLightScene);
  return <meshBasicMaterial {...props} opacity={light && props.wireframe ? Math.max(props.opacity ?? 1, 0.58) : props.opacity} />;
}
export function DetailShaderMaterial(props: ComponentProps<'shaderMaterial'>) {
  const light = useContext(WelcomeLightScene);
  const pointCloud = light && props.vertexShader?.includes('gl_PointSize');
  const vertexShader = pointCloud ? props.vertexShader?.replace(/gl_PointSize = ([^;]+);/g,
    'gl_PointSize = max(2.0, $1);') : props.vertexShader;
  const fragmentShader = pointCloud ? props.fragmentShader?.replace('#include <tonemapping_fragment>',
    'gl_FragColor.a = min(1.0, gl_FragColor.a * 1.8);\n#include <tonemapping_fragment>') : props.fragmentShader;
  return <shaderMaterial {...props} vertexShader={vertexShader} fragmentShader={fragmentShader} />;
}
