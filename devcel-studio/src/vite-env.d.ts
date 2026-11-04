/// <reference types="vite/client" />
/// <reference types="@react-three/fiber" />

declare global {
  interface Window {
    devTools?: {
      runBenchmark?: () => Promise<void>;
    };
  }
}

export {}
