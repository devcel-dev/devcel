import { invoke } from "@tauri-apps/api/core";
import type { AppError } from '@/app/i18n';

/** Native events use the shared typed error envelope, not prelocalized strings. */
export interface P2PErrorEvent { message: AppError }
export interface P2PStateChangeEvent {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'promoting' | 'failed';
  error?: AppError;
}
export interface P2PDisconnectedEvent { reason: AppError }

/** Capability detection must not depend on the selected UI language. */
export function isP2PUnavailable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'appError' in error) error = error.appError;
  if (!error || typeof error !== 'object' || !('kind' in error) || error.kind !== 'code'
    || !('code' in error) || error.code !== 'error.commandNotFound' || !('params' in error)) return false;
  const params = error.params;
  return !!params && typeof params === 'object' && 'command' in params && params.command === 'get_p2p_status';
}

/**
 * P2P connection mode
 */
export interface P2PConnectionMode {
  mode: "server" | "client";
  address?: string;
  server?: string;
}

/**
 * P2P status information
 */
export interface P2PStatus {
  connected: boolean;
  mode?: "server" | "client";
  address?: string;
  connectedClients?: number;
}

/**
 * Server information
 */
export interface ServerInfo {
  appType: string;
  address: string;
  projectPath: string;
  lastSeen: string;
}

/**
 * P2P API functions
 */
export const p2pApi = {
  /**
   * Open a project in P2P mode
   * Will either connect to existing server or become server
   */
  async openProjectP2P(projectPath: string): Promise<P2PConnectionMode> {
    const result = await invoke<string>("open_project_p2p", { projectPath });
    return JSON.parse(result);
  },

  /**
   * Get current P2P connection status
   */
  async getP2PStatus(): Promise<P2PStatus> {
    const result = await invoke<string>("get_p2p_status");
    return JSON.parse(result);
  },

  /**
   * Disconnect from P2P network
   */
  async disconnectP2P(): Promise<void> {
    await invoke("disconnect_p2p");
  },

  /**
   * Find active servers for a project
   */
  async findActiveServers(projectPath: string): Promise<ServerInfo[]> {
    const result = await invoke<string>("find_active_servers", { projectPath });
    return JSON.parse(result);
  },

  /**
   * Promote from client to server
   * Used when current server disconnects
   */
  async promoteToServer(): Promise<void> {
    await invoke("promote_to_server");
  },
};