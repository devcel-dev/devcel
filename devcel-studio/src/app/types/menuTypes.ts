export interface MenuAction {
  label: string;
  shortcut?: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  separator?: boolean; // Display a separator before the menu item
}

export interface MenuGroup {
  id: string;
  label: string;
  actions: MenuAction[];
}

export interface MenuConfiguration {
  groups: MenuGroup[];
}

// UI-only nesting keeps plugin menu contributions on the existing flat contract.
export interface MenuSubmenu {
  id: string;
  label: string;
  groups: MenuGroup[];
}

export interface MenuBarGroup extends MenuGroup {
  submenus?: MenuSubmenu[];
}

export interface MenuBarConfiguration {
  groups: MenuBarGroup[];
}

export interface MenuBarProps {
  menuConfig: MenuBarConfiguration;
  textColor: string;
  hoverBgClass: string;
}