export interface AnimatedBackgroundProps {
  className?: string;
}

export interface AnimatedBackgroundComponent {
  component: React.ComponentType<AnimatedBackgroundProps>;
  name: string;
  description?: string;
}