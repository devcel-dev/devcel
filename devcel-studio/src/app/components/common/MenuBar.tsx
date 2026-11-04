import { Fragment, useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import type { MenuAction, MenuBarProps } from "@/app/types/menuTypes";

const contentClassName = "min-w-[200px] bg-popover text-popover-foreground shadow-menu rounded-md py-1";
const itemClassName = "h-8 px-3 text-sm hover:bg-accent hover:text-accent-foreground cursor-default";

function MenuActions({ actions, skipLeadingSeparator = false }: { actions: MenuAction[]; skipLeadingSeparator?: boolean }) {
  return actions.map((action, index) => (
    <Fragment key={index}>
      {action.separator && !(index === 0 && skipLeadingSeparator) && <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={() => { void action.onClick(); }} disabled={action.disabled} className={itemClassName}>
        <span>{action.label}</span>
        {action.shortcut && <kbd className="ms-auto ps-5 text-xs text-muted-foreground">{action.shortcut}</kbd>}
      </DropdownMenuItem>
    </Fragment>
  ));
}

export function MenuBar({ menuConfig, textColor, hoverBgClass }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // Removing the last contribution must also discard its open state.
  useEffect(() => {
    if (openMenu !== null && !menuConfig.groups.some(group => group.id === openMenu)) setOpenMenu(null);
  }, [menuConfig, openMenu]);

  const handleMenuOpenChange = (open: boolean, menuId: string) => {
    // A late close from the previous dropdown must not close its replacement.
    setOpenMenu(current => open ? menuId : current === menuId ? null : current);
  };

  return (
    <div className="flex flex-wrap min-h-8 min-w-0">
      {menuConfig.groups.map((group) => (
        <DropdownMenu key={group.id} open={openMenu === group.id} onOpenChange={(open) => handleMenuOpenChange(open, group.id)}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`h-8 shrink-0 whitespace-nowrap px-3 text-sm font-medium bg-transparent ${hoverBgClass} rounded-none cursor-pointer flex items-center justify-center`}
              style={{ color: textColor }}
              onMouseEnter={() => { if (openMenu !== null) setOpenMenu(group.id); }}
            >
              {group.label}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className={contentClassName} sideOffset={5} style={{ backgroundColor: 'hsl(var(--popover))' }}>
            <MenuActions actions={group.actions} />
            {group.submenus?.map((submenu, index) => (
              <Fragment key={submenu.id}>
                {index === 0 && group.actions.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className={itemClassName}>{submenu.label}</DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent className={contentClassName} style={{ backgroundColor: 'hsl(var(--popover))' }}>
                      {submenu.groups.map((section, sectionIndex) => (
                        <Fragment key={section.id}>
                          {sectionIndex > 0 && <DropdownMenuSeparator />}
                          {submenu.groups.length > 1 && <DropdownMenuLabel>{section.label}</DropdownMenuLabel>}
                          <MenuActions actions={section.actions} skipLeadingSeparator={sectionIndex > 0} />
                        </Fragment>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </div>
  );
}
