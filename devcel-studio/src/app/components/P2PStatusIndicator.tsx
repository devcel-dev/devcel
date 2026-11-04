import { t, useI18n } from '@/app/i18n';
import { useP2P } from "../hooks/useP2P";
import { isP2PUnavailable } from "../api/p2p";
import { Badge } from "@/components/ui/badge";
import { Wifi, Server, Monitor } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * P2P connection status indicator
 * Shows current connection mode and status
 */
export function P2PStatusIndicator() {
  useI18n();
  const { status } = useP2P();
  const [isP2PEnabled, setIsP2PEnabled] = useState(true);

  // Check whether P2P is enabled
  useEffect(() => {
    const checkP2PEnabled = async () => {
      try {
        // The get_p2p_status command exists only when P2P is enabled
        await invoke("get_p2p_status");
        setIsP2PEnabled(true);
      } catch (err) {
        if (isP2PUnavailable(err)) {
          setIsP2PEnabled(false);
        }
      }
    };
    checkP2PEnabled();
  }, []);

  // Display nothing if P2P is disabled
  if (!isP2PEnabled) {
    return null;
  }

  // A listening server is quiet until an actual client joins. The existing
  // status refresh also hides it when the last client leaves.
  if (status.mode === "server" && !((status.connectedClients ?? 0) > 0)) {
    return null;
  }

  // Disconnected state display
  if (!status.connected) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="flex items-center gap-1 px-2 py-1">
              <Wifi className="h-3 w-3 opacity-50" />
              <span className="text-xs">{t('p2p.offline')}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-sm">{t('p2p.notConnected')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const icon = status.mode === "server" ? <Server className="h-4 w-4" /> : <Monitor className="h-4 w-4" />;
  const label = status.mode === "server" ? t('p2p.server') : t('p2p.client');

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-p2p-status={status.mode} className="flex items-center gap-1 px-2 py-1 text-foreground">
            <Wifi className="h-3 w-3" />
            {icon}
            <span className="text-xs">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-sm">
            <p className="font-semibold">{t('p2p.mode', { mode: label })}</p>
            {status.address && (
              <p className="text-muted-foreground">
                {t(status.mode === 'server' ? 'p2p.listening' : 'p2p.connectedTo', { address: status.address })}
              </p>
            )}
            {status.mode === "server" && status.connectedClients !== undefined && (
              <p className="text-muted-foreground">
                {t('p2p.clientCount', { count: status.connectedClients })}
              </p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * P2P connection dialog for selecting connection mode
 */
export function P2PConnectionDialog({
  onConnect,
  onCancel,
}: {
  onConnect: (mode: "auto" | "server" | "client") => void;
  onCancel: () => void;
}) {
  useI18n();
  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-4">{t('p2p.title')}</h3>

      <div className="space-y-3">
        <button
          onClick={() => onConnect("auto")}
          className="w-full p-3 border rounded-lg hover:bg-accent transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            <Wifi className="h-5 w-5" />
            <div>
              <p className="font-medium">{t('p2p.auto')}</p>
              <p className="text-sm text-muted-foreground">
                {t('p2p.autoHelp')}
              </p>
            </div>
          </div>
        </button>

        <button
          onClick={() => onConnect("server")}
          className="w-full p-3 border rounded-lg hover:bg-accent transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            <Server className="h-5 w-5" />
            <div>
              <p className="font-medium">{t('p2p.serverMode')}</p>
              <p className="text-sm text-muted-foreground">
                {t('p2p.serverHelp')}
              </p>
            </div>
          </div>
        </button>

        <button
          onClick={() => onConnect("client")}
          className="w-full p-3 border rounded-lg hover:bg-accent transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            <Monitor className="h-5 w-5" />
            <div>
              <p className="font-medium">{t('p2p.clientMode')}</p>
              <p className="text-sm text-muted-foreground">
                {t('p2p.clientHelp')}
              </p>
            </div>
          </div>
        </button>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm border rounded hover:bg-accent"
        >
          {t('p2p.cancel')}
        </button>
      </div>
    </div>
  );
}