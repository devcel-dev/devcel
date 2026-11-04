# Drei background subset

Vendored from @react-three/drei 10.7.9 (MIT), preserving only Stars and MeshDistortMaterial and their local dependency closure used by CosmicOrbBackground.

All upstream JS/declaration/shader files are byte-for-byte preserved except MeshDistortMaterial.js, whose Babel extends helper is replaced by equivalent native Object.assign. The new index.ts only re-exports the two components. Rendering behavior and shader text are unchanged. Original and local SHA-256 values are recorded in provenance.json; the complete upstream license is in LICENSE.

Upstream: https://github.com/pmndrs/drei
Published package: https://registry.npmjs.org/@react-three/drei/-/drei-10.7.9.tgz
