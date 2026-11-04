import { t, useI18n, localizeError, type LocalizedMessage, type AppError } from '@/app/i18n';
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wifi, WifiOff, Server, Monitor, AlertCircle, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface P2PToastMessage {
  id: string;
  type: "connected" | "disconnected" | "error" | "promotion" | "client-connected" | "client-disconnected";
  title: string | LocalizedMessage;
  description?: string | LocalizedMessage | AppError;
  mode?: "server" | "client";
}

interface P2PToastProps {
  message: P2PToastMessage;
  onDismiss: () => void;
}

function P2PToast({ message, onDismiss }: P2PToastProps) {
  useI18n();
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000); // Auto dismiss after 5 seconds
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const getIcon = () => {
    switch (message.type) {
      case "connected":
        return message.mode === "server" ? (
          <Server className="h-5 w-5 text-green-500" />
        ) : (
          <Monitor className="h-5 w-5 text-blue-500" />
        );
      case "disconnected":
        return <WifiOff className="h-5 w-5 text-red-500" />;
      case "error":
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      case "promotion":
        return <Server className="h-5 w-5 text-yellow-500" />;
      case "client-connected":
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case "client-disconnected":
        return <WifiOff className="h-5 w-5 text-orange-500" />;
      default:
        return <Wifi className="h-5 w-5" />;
    }
  };

  const getBgColor = () => {
    switch (message.type) {
      case "connected":
      case "client-connected":
        return "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800";
      case "disconnected":
      case "error":
        return "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800";
      case "promotion":
        return "bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800";
      case "client-disconnected":
        return "bg-orange-50 dark:bg-orange-950 border-orange-200 dark:border-orange-800";
      default:
        return "bg-background border-border";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 50, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.9 }}
      className={cn(
        "flex items-start gap-3 p-4 rounded-lg border shadow-lg min-w-[300px] max-w-[400px]",
        getBgColor()
      )}
    >
      <div className="flex-shrink-0">{getIcon()}</div>
      <div className="flex-1 min-w-0 break-words">
        <h4 className="font-semibold text-sm">{localizeError(message.title)}</h4>
        {message.description && (
          <p className="text-sm text-muted-foreground mt-1">{localizeError(message.description)}</p>
        )}
      </div>
      <button
        aria-label={t('p2p.dismiss')}
        onClick={onDismiss}
        className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </motion.div>
  );
}

/**
 * Container for P2P toast notifications
 */
export function P2PToastContainer() {
  const [messages, setMessages] = useState<P2PToastMessage[]>([]);

  // Listen for P2P events and show toasts
  useEffect(() => {
    // This will be connected to the P2P event system
    const handleP2PEvent = (event: CustomEvent<P2PToastMessage>) => {
      setMessages((prev) => [...prev, event.detail]);
    };

    window.addEventListener("p2p-toast", handleP2PEvent as EventListener);

    return () => {
      window.removeEventListener("p2p-toast", handleP2PEvent as EventListener);
    };
  }, []);

  const dismissMessage = (id: string) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== id));
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {messages.map((message) => (
          <P2PToast
            key={message.id}
            message={message}
            onDismiss={() => dismissMessage(message.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Helper function to show a P2P toast notification
 */
export function showP2PToast(message: Omit<P2PToastMessage, "id">) {
  const event = new CustomEvent("p2p-toast", {
    detail: {
      ...message,
      id: `${Date.now()}-${Math.random()}`,
    },
  });
  window.dispatchEvent(event);
}