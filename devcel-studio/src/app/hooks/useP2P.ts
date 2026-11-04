import { useI18n, localizeError, message } from '@/app/i18n';
import { useState, useEffect, useCallback } from "react";
import { p2pApi, isP2PUnavailable, type P2PStatus, type P2PErrorEvent, type P2PStateChangeEvent } from "../api/p2p";
import { listen } from "@tauri-apps/api/event";
import { showP2PToast } from "../components/P2PToast";

/**
 * Hook for managing P2P connections
 */
export function useP2P() {
  useI18n();
  const [status, setStatus] = useState<P2PStatus>({ connected: false });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Poll P2P status periodically
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const currentStatus = await p2pApi.getP2PStatus();
        setStatus(currentStatus);
      } catch (err) {
        // Do not log an error if P2P is disabled
        if (!isP2PUnavailable(err)) {
          console.error("Failed to get P2P status:", err);
        }
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 5000); // Check every 5 seconds

    return () => clearInterval(interval);
  }, []);

  // Listen for P2P mode changes
  useEffect(() => {
    const unlisten = listen<{ mode: string }>("p2p-mode-changed", (event) => {
      setStatus((prev) => ({
        ...prev,
        mode: event.payload.mode as "server" | "client",
      }));
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for P2P connection events
  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    // Client connected (server only)
    unlisteners.push(
      listen("p2p-client-connected", (_event: any) => {
        showP2PToast({
          type: "client-connected",
          title: message('p2p.toast.clientConnected'),
        });
      })
    );

    // Client disconnected (server only)
    unlisteners.push(
      listen("p2p-client-disconnected", (_event: any) => {
        showP2PToast({
          type: "client-disconnected",
          title: message('p2p.toast.clientDisconnected'),
        });
      })
    );

    // Server disconnected (client only)
    unlisteners.push(
      listen("p2p-server-disconnected", (_event: any) => {
        showP2PToast({
          type: "disconnected",
          title: message('p2p.toast.serverDisconnected'),
        });
      })
    );

    // Connection errors
    unlisteners.push(
      listen<P2PErrorEvent>("p2p-error", (event) => {
        showP2PToast({
          type: "error",
          title: message('p2p.toast.errorTitle'),
          description: event.payload.message || message('p2p.toast.connectionError'),
        });
      })
    );

    // State changes (including failed state)
    unlisteners.push(
      listen<P2PStateChangeEvent>("p2p-state-changed", (event) => {
        if (event.payload.state === "failed") {
          showP2PToast({
            type: "error",
            title: message('p2p.toast.failed'),
            description: event.payload.error || message('p2p.toast.retryExhausted'),
          });
          // Update local status to disconnected
          setStatus({ connected: false });
        }
      })
    );

    return () => {
      Promise.all(unlisteners).then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  /**
   * Open a project in P2P mode
   */
  const openProjectP2P = useCallback(async (projectPath: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const mode = await p2pApi.openProjectP2P(projectPath);

      // Update status based on connection mode
      setStatus({
        connected: true,
        mode: mode.mode,
        address: mode.mode === "server" ? mode.address : mode.server,
      });

      // Show connection toast
      showP2PToast({
        type: "connected",
        title: mode.mode === "server" ? message('p2p.toast.serverStarted') : message('p2p.toast.connected'),
        description: mode.mode === "server"
          ? message('p2p.listening', { address: mode.address || '' })
          : message('p2p.connectedTo', { address: mode.server || '' }),
        mode: mode.mode,
      });

      return mode;
    } catch (err) {
      const errorMsg = err ?? message('p2p.unknownError');
      setError(errorMsg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Disconnect from P2P network
   */
  const disconnect = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      await p2pApi.disconnectP2P();
      setStatus({ connected: false });

      // Show disconnection toast
      showP2PToast({
        type: "disconnected",
        title: message('p2p.toast.disconnected'),
      });
    } catch (err) {
      const errorMsg = err ?? message('p2p.unknownError');
      setError(errorMsg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Handle server disconnection by promoting to server
   */
  const handleServerDisconnect = useCallback(async () => {
    if (status.mode === "client") {
      try {
        await p2pApi.promoteToServer();
        setStatus((prev) => ({
          ...prev,
          mode: "server",
        }));

        // Show promotion toast
        showP2PToast({
          type: "promotion",
          title: message('p2p.toast.promoted'),
        });
      } catch (err) {
        console.error("Failed to promote to server:", err);
        setError(err ?? message('p2p.promotionFailed'));
      }
    }
  }, [status.mode]);

  // Monitor for server disconnection
  useEffect(() => {
    if (status.mode !== "client") return;

    let consecutiveFailures = 0;
    const checkInterval = setInterval(async () => {
      try {
        const currentStatus = await p2pApi.getP2PStatus();

        // If we're still connected, reset failure count
        if (currentStatus.connected) {
          consecutiveFailures = 0;
        }
      } catch (err) {
        // Do not count if P2P is disabled
        if (!isP2PUnavailable(err)) {
          consecutiveFailures++;

          // After 3 consecutive failures, assume server is down
          if (consecutiveFailures >= 3) {
            clearInterval(checkInterval);
            await handleServerDisconnect();
          }
        }
      }
    }, 5000); // Check every 5 seconds

    return () => clearInterval(checkInterval);
  }, [status.mode, handleServerDisconnect]);

  return {
    status,
    isLoading,
    error: error == null ? null : localizeError(error),
    openProjectP2P,
    disconnect,
    handleServerDisconnect,
  };
}