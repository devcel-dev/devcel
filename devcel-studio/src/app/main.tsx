import { ThirdPartyLicensesHost } from '@/app/components/ThirdPartyLicensesHost';
import { AppDialogHost } from '@/app/components/AppDialogHost';
import { Toaster } from '@/components/ui/toaster';
import { ColorPickerDialogHost } from '@/app/components/color/ColorPickerDialogHost';
import { initializeApplicationMode, isSettingsEditor, isApplicationRouteAllowed } from '@/app/applicationMode';
import { initializeAppSettings } from '@/app/settings';
import { AppTheme } from '@/app/settings/AppTheme';
import { initializeI18n, useI18n, getLocaleDirection, localizedError, message, localizeError } from '@/app/i18n';
import React from "react";
import { DirectionProvider } from "@radix-ui/react-direction";
import ReactDOM from "react-dom/client";
import { router } from "@/app/routes/routes";
import { RouterProvider } from "react-router-dom";
import "@/index.css";
import { HTML5Backend } from "react-dnd-html5-backend";
import { DndProvider } from "react-dnd";
import { PluginProvider } from "@/app/contexts/PluginContext";

// Radix keyboard navigation and portal contents need the same direction as the document.
function ApplicationDirection({ children }: { children: React.ReactNode }) {
  useI18n();
  return <DirectionProvider dir={getLocaleDirection()}>{children}</DirectionProvider>;
}

// Disable the native context menu
document.addEventListener('contextmenu', (e) => {
  // Exclude elements with custom context menus
  const target = e.target as HTMLElement;
  
  // Check for Radix UI context menu trigger elements
  const isRadixContextMenu = target.closest('[data-radix-context-menu-trigger]') || 
                            target.closest('[data-radix-menu-content]') ||
                            target.closest('[data-radix-collection-item]');
  
  // DataGrid context menu
  const isDataGridMenu = target.closest('.data-grid') || 
                        target.closest('[data-context-menu]');
  
  // File node context menu
  const isFileNode = target.closest('[data-file-id]');
  
  if (!isRadixContextMenu && !isDataGridMenu && !isFileNode) {
    e.preventDefault();
  }
}, true);

// Native mode is a mandatory isolation boundary for every route. Never mount a
// standard plugin context when this read fails or is still pending.
async function bootstrap() {
  await initializeApplicationMode();
  if (!isApplicationRouteAllowed(window.location.pathname)) throw localizedError(message('error.settingsRouteUnavailable'));
  if (import.meta.env.DEV && !isSettingsEditor()) {
    setTimeout(() => { void import('@/app/utils/devTools').catch(console.error); }, 1000);
  }
  const initialization = Promise.all([initializeI18n(), initializeAppSettings()]);
  let startupTimer: ReturnType<typeof setTimeout>;
  const startupDeadline = new Promise<void>(resolve => { startupTimer = setTimeout(resolve, 2000); });
  await Promise.race([initialization, startupDeadline]);
  clearTimeout(startupTimer!);
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <ApplicationDirection>
      <PluginProvider>
        <AppTheme />
        <DndProvider backend={HTML5Backend} debugMode={import.meta.env.DEV}>
          <RouterProvider router={router} />
          <ColorPickerDialogHost />
          <AppDialogHost />
          <ThirdPartyLicensesHost />
          <Toaster />
        </DndProvider>
      </PluginProvider>
      </ApplicationDirection>
    </React.StrictMode>,
  );
}
void bootstrap().catch(error => {
  console.error('Application startup failed:', error);
  const root = document.getElementById('root');
  if (root) { root.setAttribute('role', 'alert'); root.textContent = localizeError(error); }
});
