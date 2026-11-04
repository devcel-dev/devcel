import { MenuConfiguration } from '../types/pluginTypes';

/**
 * Create menu extensions
 */
export function createMenuExtensions(): Record<string, MenuConfiguration> {
  return {
    'your-plugin-menu': {
      groups: [
        {
          id: 'main',
          label: 'Your Plugin',
          actions: [
            {
              label: 'Action 1',
              onClick: () => {
                console.log('Menu Action 1 clicked');
                // Implement the actual action here
              }
            },
            {
              label: 'Action 2',
              onClick: () => {
                console.log('Menu Action 2 clicked');
                // Implement the actual action here
              }
            },
            {
              label: 'Settings',
              onClick: () => {
                console.log('Settings clicked');
                // Open the settings dialog
              },
              separator: true
            }
          ]
        }
      ]
    }
  };
}