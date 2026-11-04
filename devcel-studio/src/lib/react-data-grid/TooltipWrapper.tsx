import { Children, cloneElement, isValidElement, useCallback, useState, useRef, useEffect,
  type ComponentPropsWithRef, type ReactElement, type ReactNode, type RefCallback } from 'react';
import { createPortal } from 'react-dom';

interface TooltipWrapperProps {
  children: ReactNode;
  /** Opt in only with one existing div; keep this structural choice stable while mounted. */
  asChild?: boolean;
  tooltip?: string;
  memoText?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

interface TooltipPosition {
  top: number;
  left: number;
}

/**
 * Wrapper component displaying tooltips and memo text
 * 
 * @description
 * Display a tooltip on hover and memo text on a long press or click.
 * Render the tooltip in a portal directly under body and position it appropriately.
 */
export function TooltipWrapper({
  children,
  asChild = false,
  tooltip,
  memoText,
  placement = 'top',
  className
}: TooltipWrapperProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [showMemo, setShowMemo] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ top: 0, left: 0 });
  const elementRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const longPressTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  // React 19 exposes refs through props; cloning retains the child's key and other props.
  const child = asChild ? Children.only(children) : undefined;
  if (asChild && (!isValidElement(child) || child.type !== 'div')) {
    throw new Error('TooltipWrapper asChild requires a single div element');
  }
  const cell = child as ReactElement<ComponentPropsWithRef<'div'>> | undefined;
  const childRef = cell?.props.ref;
  const cellRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    elementRef.current = node;
    const cleanup = typeof childRef === 'function' ? childRef(node) : undefined;
    if (childRef && typeof childRef !== 'function') childRef.current = node;
    return () => {
      elementRef.current = null;
      if (typeof cleanup === 'function') cleanup();
      else if (typeof childRef === 'function') childRef(null);
      else if (childRef) childRef.current = null;
    };
  }, [childRef]);

  // Get the actual cell's bounding rectangle.
  // The wrapper uses display: contents and has no layout box,
  // so getBoundingClientRect returns an empty rectangle. Position using the actual child cell's rectangle.
  const getCellRect = (): DOMRect | undefined => {
    const host = elementRef.current;
    const target = asChild ? host : (host?.firstElementChild as HTMLElement | null) ?? host;
    return target?.getBoundingClientRect();
  };

  // Calculate tooltip position
  const calculatePosition = () => {
    const rect = getCellRect();
    if (!rect) return;

    const tooltipMargin = 8;
    let top = 0;
    let left = 0;
    
    switch (placement) {
      case 'top':
        top = rect.top - tooltipMargin;
        left = rect.left + rect.width / 2;
        break;
      case 'bottom':
        top = rect.bottom + tooltipMargin;
        left = rect.left + rect.width / 2;
        break;
      case 'left':
        top = rect.top + rect.height / 2;
        left = rect.left - tooltipMargin;
        break;
      case 'right':
        top = rect.top + rect.height / 2;
        left = rect.right + tooltipMargin;
        break;
    }
    
    setPosition({ top, left });
  };
  
  // Mouse enter handler
  const handleMouseEnter = () => {
    if (!tooltip && !memoText) return;
    
    // Show tooltip after a short delay
    timeoutRef.current = setTimeout(() => {
      calculatePosition();
      setShowTooltip(true);
    }, 500);
    
    // Show memo text on long hover
    if (memoText) {
      longPressTimeoutRef.current = setTimeout(() => {
        setShowTooltip(false);
        setShowMemo(true);
      }, 2000);
    }
  };
  
  // Mouse leave handler
  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
    }
    setShowTooltip(false);
    setShowMemo(false);
  };
  
  // Click handler for memo text
  const handleClick = (e: React.MouseEvent) => {
    if (memoText && !showMemo) {
      e.stopPropagation();
      calculatePosition();
      setShowTooltip(false);
      setShowMemo(true);
    }
  };
  
  // Clean up timeouts
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (longPressTimeoutRef.current) {
        clearTimeout(longPressTimeoutRef.current);
      }
    };
  }, []);
  
  // Tooltip content
  const tooltipContent = showTooltip && tooltip && (
    <div
      style={{
        position: 'fixed',
        top: placement === 'bottom' ? position.top : position.top - 28,
        left: position.left,
        transform: placement === 'left' || placement === 'right' 
          ? 'translateY(-50%)' 
          : 'translateX(-50%)',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        padding: '4px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        whiteSpace: 'nowrap',
        zIndex: 10000,
        pointerEvents: 'none',
        maxWidth: '300px',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}
    >
      {tooltip}
    </div>
  );
  
  // Memo text content
  const memoContent = showMemo && memoText && (
    <div
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        transform: 'translate(-50%, -100%)',
        backgroundColor: 'hsl(var(--popover))',
        color: 'hsl(var(--popover-foreground))',
        padding: '12px 16px',
        borderRadius: '8px',
        fontSize: '14px',
        lineHeight: 1.5,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        border: '1px solid hsl(var(--border))',
        zIndex: 10001,
        maxWidth: '400px',
        maxHeight: '300px',
        overflow: 'auto'
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={() => setShowMemo(false)}
    >
      <div style={{ whiteSpace: 'pre-wrap' }}>{memoText}</div>
      <button
        style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          background: 'none',
          border: 'none',
          fontSize: '16px',
          cursor: 'pointer',
          color: 'hsl(var(--muted-foreground))',
          padding: '0 4px',
          lineHeight: 1
        }}
        onClick={() => setShowMemo(false)}
      >
        ×
      </button>
    </div>
  );
  
  return (
    <>
      {cell ? cloneElement(cell, {
        ref: cellRef,
        className: className ? [cell.props.className, className].filter(Boolean).join(' ') : cell.props.className,
        // Match the original nested host's event order and propagation contract.
        onMouseEnter: (event) => {
          handleMouseEnter();
          cell.props.onMouseEnter?.(event);
        },
        onMouseLeave: (event) => {
          cell.props.onMouseLeave?.(event);
          if (!event.isPropagationStopped()) handleMouseLeave();
        },
        onClick: (event) => {
          cell.props.onClick?.(event);
          if (!event.isPropagationStopped()) handleClick(event);
        }
      }) : (
        // Default layout/header/frozen callers keep the display:contents host.
        <div
          ref={elementRef}
          className={className}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          style={{ display: 'contents' }}
        >
          {children}
        </div>
      )}
      {/* Portal for tooltip and memo */}
      {(tooltipContent || memoContent) && createPortal(
        <>
          {tooltipContent}
          {memoContent}
        </>,
        document.body
      )}
    </>
  );
}