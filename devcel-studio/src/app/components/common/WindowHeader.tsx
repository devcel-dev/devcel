import { t, useI18n } from '@/app/i18n';
import { Window } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { Minus, Square, X } from "lucide-react";
import { IMainWindowProps } from "@/app/pages/main_window/MainWindow";
import { useEffect } from "react";
import { isDarkColor, getContrastTextColor } from "@/lib/utils";
import { MenuBar } from "@/app/components/common/MenuBar";
import { MenuBarConfiguration } from "@/app/types/menuTypes";

const handleMinimize = async () => {
  const window = await Window.getCurrent();
  await window.minimize();
};

const handleMaximize = async () => {
  const window = await Window.getCurrent();
  if (await window.isMaximized()) {
    await window.unmaximize();
  } else {
    await window.maximize();
  }
};

const handleClose = async () => {
  const window = await Window.getCurrent();
  await window.close();
};



interface WindowHeaderProps extends IMainWindowProps {
  menuConfig?: MenuBarConfiguration;
}

export function WindowHeader({ menuConfig, ...props }: WindowHeaderProps) {
  useI18n();
  // Calculate button colors based on header color
  const isHeaderDark = props.hasProject && isDarkColor(props.projectHeaderColor);
  const iconColor = props.hasProject ? getContrastTextColor(props.projectHeaderColor) : "hsl(var(--primary-foreground))";
  const buttonBgClass = !props.hasProject ? "bg-transparent" : isHeaderDark ? "bg-white/10" : "bg-black/10";
  const buttonHoverBgClass = !props.hasProject ? "hover:bg-accent" : isHeaderDark ? "hover:bg-white/30" : "hover:bg-black/20";
  const hoverBgClass = !props.hasProject ? "hover:bg-accent" : isHeaderDark ? "hover:bg-white/20" : "hover:bg-black/10";
  
  // Update window title when project name changes
  useEffect(() => {
    const updateTitle = async () => {
      const window = await Window.getCurrent();
      const title = props.hasProject && props.projectName 
        ? `${props.projectName} - Devcel Studio`
        : "Devcel Studio";
      await window.setTitle(title);
    };
    
    updateTitle();
  }, [props.hasProject, props.projectName]);
  
  return (
    <div
      className={`z-10 top-0 left-0 right-0 min-h-8 flex justify-between items-center border-b shrink-0`}
      style={{
        backgroundColor: props.hasProject ? props.projectHeaderColor : "hsl(var(--primary))",
        isolation: "isolate",
      }}
    >
      <img
        src="/brand/devcel-favicon-small.svg"
        alt="Devcel"
        className="mx-2 h-5 w-5 shrink-0 select-none"
        draggable={false}
      />
      {/* Menu bar */}
      {menuConfig && (
        <MenuBar 
          menuConfig={menuConfig}
          textColor={iconColor}
          hoverBgClass={hoverBgClass}
        />
      )}
      {/* Display the project name in the center */}
      <div 
        data-tauri-drag-region 
        className="flex-grow min-w-0 min-h-8 flex items-center justify-center px-4 select-none truncate"
        style={{ color: iconColor }}
      >
        {props.hasProject && props.projectName && (
          <span className="text-sm font-medium truncate max-w-64">
            {props.projectName}
          </span>
        )}
      </div>
      {/* Control buttons */}
      <div className="flex bg-transparent h-8 shrink-0 self-start">
        <Button
          variant="ghost"
          aria-label={t('window.minimize')}
          onClick={handleMinimize}
          className={`h-full w-10 p-0 rounded-none ${buttonBgClass} ${buttonHoverBgClass}`}
          style={{ color: iconColor }}
        >
          <Minus size={12} />
        </Button>
        <Button
          variant="ghost"
          aria-label={t('window.maximize')}
          onClick={handleMaximize}
          className={`h-full w-10 p-0 rounded-none ${buttonBgClass} ${buttonHoverBgClass}`}
          style={{ color: iconColor }}
        >
          <Square size={12} />
        </Button>
        <Button
          variant="ghost"
          aria-label={t('window.close')}
          onClick={handleClose}
          className={`h-full w-10 p-0 rounded-none ${buttonBgClass} hover:bg-red-600/90 [&>svg]:hover:text-white`}
          style={{ color: iconColor }}
        >
          <X size={12} />
        </Button>
      </div>
    </div>
  );
}
