"use client"
import { t, useI18n } from '@/app/i18n';

import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

const ReferenceSelect = SelectPrimitive.Root

const ReferenceSelectGroup = SelectPrimitive.Group

const ReferenceSelectValue = SelectPrimitive.Value

const ReferenceSelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background data-[placeholder]:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
ReferenceSelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const ReferenceSelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1",
      className
    )}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
))
ReferenceSelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const ReferenceSelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1",
      className
    )}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
))
ReferenceSelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName

interface ReferenceSelectContentProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
}

const ReferenceSelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  ReferenceSelectContentProps
>(({ className, children, position = "popper", searchValue = "", onSearchChange, searchPlaceholder = t('reference.search'), ...props }, ref) => {
  useI18n();
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [isContentReady, setIsContentReady] = React.useState(false);
  
  // Detect when Content mounts
  React.useEffect(() => {
    setIsContentReady(true);
  }, []);
  
  // Focus management
  React.useEffect(() => {
    if (isContentReady && searchInputRef.current) {
      // Set focus using multiple methods
      const focusSearch = () => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      };
      
      // Run immediately
      focusSearch();
      
      // Also run in RAF
      requestAnimationFrame(focusSearch);
      
      // Also run on a timer as a fallback
      const timeoutIds = [
        setTimeout(focusSearch, 0),
        setTimeout(focusSearch, 50),
        setTimeout(focusSearch, 100)
      ];
      
      return () => timeoutIds.forEach(clearTimeout);
    }
  }, [isContentReady]);
  
  // Keep focus when the search value changes too
  React.useEffect(() => {
    if (isContentReady && searchInputRef.current && document.activeElement !== searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchValue, isContentReady]);
  
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        className={cn(
          "relative z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-select-content-transform-origin]",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        style={{
          maxHeight: 'min(var(--radix-select-content-available-height), 400px)'
        }}
        position={position}
        {...props}
      >
        <div className="sticky top-0 bg-popover z-10 border-b">
          <div 
            className="flex items-center px-2 py-2"
            onKeyDown={(e) => {
              // Prevent keyboard input in search from interfering with Select navigation
              e.stopPropagation();
              
              // Let Escape propagate to the parent to close the dropdown
              if (e.key === 'Escape') {
                e.currentTarget.parentElement?.parentElement?.dispatchEvent(
                  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
                );
              }
            }}
            onPointerDown={(e) => {
              // Protect focus during pointer events too
              if ((e.target as HTMLElement).closest('input')) {
                e.preventDefault();
              }
            }}
          >
            <Search className="h-4 w-4 text-muted-foreground mr-2" />
            <Input
              ref={searchInputRef}
              data-reference-search-input="true"
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              value={searchValue}
              onChange={(e) => {
                onSearchChange?.(e.target.value);
                // Keep focus after changes
                e.currentTarget.focus();
              }}
              className="h-8 border-0 bg-muted/40 focus-visible:ring-1"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => {
                // Prevent focus on mousedown to avoid stealing focus
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.focus();
              }}
              onFocus={(e) => {
                e.stopPropagation();
              }}
              onBlur={(e) => {
                // Immediately restore focus when lost
                const relatedTarget = e.relatedTarget as HTMLElement;
                // Restore focus unless it moved to a selection item
                if (!relatedTarget?.closest('[role="option"]')) {
                  setTimeout(() => {
                    e.currentTarget.focus();
                  }, 0);
                }
              }}
            />
          </div>
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: '300px' }}>
          <ReferenceSelectScrollUpButton />
          <SelectPrimitive.Viewport
            className={cn(
              "p-1",
              position === "popper" &&
                "w-full min-w-[var(--radix-select-trigger-width)]"
            )}
            style={{
              minHeight: '100px'
            }}
          >
            {children}
          </SelectPrimitive.Viewport>
          <ReferenceSelectScrollDownButton />
        </div>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
})
ReferenceSelectContent.displayName = SelectPrimitive.Content.displayName

const ReferenceSelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", className)}
    {...props}
  />
))
ReferenceSelectLabel.displayName = SelectPrimitive.Label.displayName

const ReferenceSelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
ReferenceSelectItem.displayName = SelectPrimitive.Item.displayName

const ReferenceSelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
))
ReferenceSelectSeparator.displayName = SelectPrimitive.Separator.displayName

export {
  ReferenceSelect,
  ReferenceSelectGroup,
  ReferenceSelectValue,
  ReferenceSelectTrigger,
  ReferenceSelectContent,
  ReferenceSelectLabel,
  ReferenceSelectItem,
  ReferenceSelectSeparator,
  ReferenceSelectScrollUpButton,
  ReferenceSelectScrollDownButton,
}