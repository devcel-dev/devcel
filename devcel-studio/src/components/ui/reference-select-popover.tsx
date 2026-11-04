"use client"
import { t, useI18n } from '@/app/i18n';

import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Check, ChevronDown, Search, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { isComposingKey } from "@/app/utils/shortcutGuards"

interface ReferenceSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface ReferenceSelectPopoverProps {
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  options: ReferenceSelectOption[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  nullLabel?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}

const ReferenceSelectPopover = React.forwardRef<HTMLInputElement, ReferenceSelectPopoverProps>(({
  value,
  onValueChange,
  placeholder = t('reference.select'),
  options,
  open,
  onOpenChange,
  searchValue = "",
  onSearchChange,
  searchPlaceholder = t('reference.search'),
  className: _className,
  triggerClassName,
  contentClassName,
  nullLabel = t('reference.none'),
  onRefresh,
  refreshing = false,
}: ReferenceSelectPopoverProps, forwardedRef) => {
  useI18n();
  const [isOpen, setIsOpen] = React.useState(open ?? false);
  const [search, setSearch] = React.useState(searchValue);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const composing = React.useRef(false);
  const listId = React.useId();
  const [activeValue, setActiveValue] = React.useState<string | undefined>(value);

  // Handle forwardedRef
  React.useImperativeHandle(forwardedRef, () => searchInputRef.current!, []);

  // External control of open state
  React.useEffect(() => {
    if (open !== undefined) {
      setIsOpen(open);
    }
  }, [open]);

  // External control of searchValue
  React.useEffect(() => {
    if (searchValue !== undefined) {
      setSearch(searchValue);
    }
  }, [searchValue]);

  // Focus search when the popover opens
  React.useEffect(() => {
    if (isOpen) {
      // Try multiple ways to focus
      const attemptFocus = () => {
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();

          // Retry if focus was not acquired
          if (document.activeElement !== searchInputRef.current) {
            searchInputRef.current.focus();
          }
        }
      };

      // Run immediately
      attemptFocus();

      // Also run in requestAnimationFrame
      requestAnimationFrame(attemptFocus);

      // Also run after a delay
      const timers = [
        setTimeout(attemptFocus, 0),
        setTimeout(attemptFocus, 50),
        setTimeout(attemptFocus, 100),
        setTimeout(attemptFocus, 200),
      ];

      return () => timers.forEach(clearTimeout);
    }
  }, [isOpen]);

  const handleOpenChange = (newOpen: boolean) => {
    setIsOpen(newOpen);
    onOpenChange?.(newOpen);
    if (newOpen) {
      // Reset search when opened
      setSearch("");
      setActiveValue(value);
      onSearchChange?.("");
    }
  };

  const handleSelect = (selectedValue: string) => {
    onValueChange?.(selectedValue);
    setIsOpen(false);
    onOpenChange?.(false);
  };

  const handleSearchChange = (newSearch: string) => {
    setSearch(newSearch);
    setActiveValue(undefined);
    onSearchChange?.(newSearch);
  };

  // Filtered options
  const filteredOptions = React.useMemo(() => {
    const searchLower = search.toLowerCase();
    return options.filter(option =>
      option.label.toLowerCase().includes(searchLower)
    );
  }, [options, search]);

  const navigable = React.useMemo(() => [
    ...(search === "" ? [{ value: "__NULL__", id: `${listId}-null` }] : []),
    ...filteredOptions.flatMap((option, index) => option.disabled ? [] : [{ value: option.value, id: `${listId}-${index}` }])
  ], [filteredOptions, search, listId]);
  const activeOption = navigable.find(option => option.value === activeValue) ?? navigable[0];
  React.useEffect(() => {
    if (isOpen && activeOption) document.getElementById(activeOption.id)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOption, isOpen]);

  // Get the label for the selected value
  const selectedLabel = React.useMemo(() => {
    if (value === "__NULL__" || !value) return nullLabel;
    const selected = options.find(opt => opt.value === value);
    // Display 'Loading...' if the label is unavailable; do not display the GUID
    return selected?.label || 'Loading...';
  }, [value, options, nullLabel]);

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={isOpen}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground",
            triggerClassName
          )}
        >
          <span className="truncate">{value ? selectedLabel : placeholder}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("p-0", contentClassName)}
        align="start"
        sideOffset={4}
        onCompositionStartCapture={() => { composing.current = true; }}
        onCompositionEndCapture={() => { composing.current = false; }}
        onEscapeKeyDown={event => { if (composing.current || isComposingKey(event)) event.preventDefault(); }}
        onOpenAutoFocus={(e) => {
          // Disable the popover's default focus behavior
          e.preventDefault();
          // Set focus manually
          setTimeout(() => {
            searchInputRef.current?.focus();
          }, 0);
        }}
        onInteractOutside={(e) => {
          // Ignore interactions with the search input
          if ((e.target as HTMLElement).closest('input')) {
            e.preventDefault();
          }
        }}
      >
        <div className="border-b p-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center space-x-2" onPointerDown={(e) => {
            // Prevent pointer events from stealing focus
            e.preventDefault();
            e.stopPropagation();
          }}>
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={isOpen}
              aria-controls={listId}
              aria-activedescendant={activeOption?.id}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-8 border-0 bg-transparent p-0 placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-0 flex-1"
              tabIndex={0}
              autoFocus
              onFocus={(e) => {
                // Stop focus event propagation
                e.stopPropagation();
              }}
              onBlur={(e) => {
                // Restore lost focus unless it moved to an option
                const relatedTarget = e.relatedTarget as HTMLElement;
                if (relatedTarget && !relatedTarget.closest('[role="option"]') && relatedTarget.closest('[data-radix-popper-content-wrapper]')) {
                  // If focus moves to an element within the popover
                  setTimeout(() => {
                    searchInputRef.current?.focus();
                  }, 0);
                }
              }}
              onKeyDown={(e) => {
                if (composing.current || isComposingKey(e.nativeEvent)) {
                  if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
                  return;
                }
                if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  e.preventDefault(); e.stopPropagation();
                  const current = navigable.findIndex(option => option.value === activeOption?.value);
                  const next = Math.max(0, Math.min(navigable.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
                  setActiveValue(navigable[next]?.value);
                } else if (e.key === "Escape") {
                  // Radix handles ordinary Escape in its document capture listener.
                  // Do not notify twice when the same event reaches the input.
                  e.preventDefault(); e.stopPropagation();
                } else if (e.key === "Enter" && activeOption) {
                  e.preventDefault(); e.stopPropagation(); handleSelect(activeOption.value);
                }
              }}
            />
            {onRefresh && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefresh();
                }}
                disabled={refreshing}
                className="h-8 w-8 p-0"
                title={t('reference.refresh')}
                aria-label={t('reference.refresh')}
              >
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              </Button>
            )}
          </div>
        </div>
        <div
          id={listId}
          role="listbox"
          className="max-h-[300px] overflow-y-auto"
          onScroll={(e) => {
            // Stop scroll event propagation
            e.stopPropagation();
          }}
          onClick={(e) => {
            // Return focus to the search bar after clicking the scroll area
            const target = e.target as HTMLElement;
            if (!target.closest('[role="option"]')) {
              // Focus search when clicking anything other than an option
              searchInputRef.current?.focus();
            }
          }}
        >
          {search === "" && (
            <div
              id={`${listId}-null`}
              role="option"
              aria-selected={activeOption?.value === "__NULL__"}
              onMouseMove={() => setActiveValue("__NULL__")}
              onMouseDown={event => event.preventDefault()}
              className={cn(
                "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-accent hover:text-accent-foreground",
                activeOption?.value === "__NULL__" && "bg-accent text-accent-foreground"
              )}
              onClick={() => handleSelect("__NULL__")}
            >
              {value === "__NULL__" && (
                <Check className="mr-2 h-4 w-4" />
              )}
              <span className={cn("text-muted-foreground", value !== "__NULL__" && "ml-6")}>
                {nullLabel}
              </span>
            </div>
          )}
          {filteredOptions.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {t('reference.noSearchResults')}
            </div>
          ) : (
            filteredOptions.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={activeOption?.value === option.value}
                onMouseMove={() => { if (!option.disabled) setActiveValue(option.value); }}
                onMouseDown={event => event.preventDefault()}
                aria-disabled={option.disabled}
                className={cn(
                  "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-accent hover:text-accent-foreground",
                  option.disabled && "pointer-events-none opacity-50",
                  activeOption?.value === option.value && "bg-accent text-accent-foreground"
                )}
                onClick={() => !option.disabled && handleSelect(option.value)}
              >
                {value === option.value && (
                  <Check className="mr-2 h-4 w-4" />
                )}
                <span className={value !== option.value ? "ml-6" : ""}>
                  {option.label}
                </span>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});

ReferenceSelectPopover.displayName = "ReferenceSelectPopover";

export { ReferenceSelectPopover };
