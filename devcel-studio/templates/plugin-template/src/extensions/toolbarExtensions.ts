import { ToolbarButton } from '../types/pluginTypes';

/**
 * Create toolbar extensions
 */
export function createToolbarExtensions(): ToolbarButton[] {
  return [
    {
      id: 'your-plugin-main-button',
      label: 'Your Plugin',
      tooltip: 'Open Your Plugin features',
      onClick: () => {
        console.log('Toolbar button clicked');
        // Implement the actual action here
      },
      position: 'right',
      order: 100,
      isVisible: () => {
        // Condition for showing the button
        return true;
      },
      isEnabled: () => {
        // Condition for enabling the button
        return true;
      }
    },
    {
      id: 'your-plugin-quick-action',
      label: 'Quick Action',
      tooltip: 'Perform quick action',
      onClick: () => {
        console.log('Quick action clicked');
        // Implement the quick action
      },
      position: 'center',
      order: 200,
      isVisible: () => {
        // Display only under specific conditions
        return true; // Replace with the actual condition
      }
    }
  ];
}