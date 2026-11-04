import { useI18n } from '@/app/i18n';
import { PluginContextItems } from '@/app/components/plugins/PluginExtensions';
import React, { useEffect, useRef } from 'react';
import { Trash2, Plus } from 'lucide-react';

interface ContextMenuProps {
  type: 'row' | 'column';
  metadataAllowed?: boolean;
  onEditTags?: () => void;
  onEditParent?: () => void;
  addAllowed?: boolean;
  deleteAllowed?: boolean;
  transposed?: boolean;
  pluginContext?: any;
  x: number;
  y: number;
  onClose: () => void;
  // Row actions
  onAddRowAbove?: () => void;
  onAddRowBelow?: () => void;
  onDeleteRow?: () => void;
  // Column actions
  onAddColumnLeft?: () => void;
  onAddColumnRight?: () => void;
  onDeleteColumn?: () => void;
}

export const DataGridContextMenu: React.FC<ContextMenuProps> = ({
  type,
  metadataAllowed = true, onEditTags, onEditParent,
  addAllowed = true,
  deleteAllowed = true,  transposed = false,
  pluginContext,
  x,
  y,
  onClose,
  onAddRowAbove,
  onAddRowBelow,
  onDeleteRow,
  onAddColumnLeft,
  onAddColumnRight,
  onDeleteColumn
}) => {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  
  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);
  
  // Adjust position to keep menu on screen
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      let adjustedX = x;
      let adjustedY = y;
      
      if (x + rect.width > viewportWidth) {
        adjustedX = viewportWidth - rect.width - 10;
      }
      
      if (y + rect.height > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 10;
      }
      
      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    }
  }, [x, y]);
  
  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-background rounded-lg shadow-lg border border-border py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {type === 'row' ? (
        <>
          {[['tags', onEditTags], ['parent', onEditParent]].map(([kind, action]) => typeof action === 'function' && <button key={String(kind)} disabled={!metadataAllowed} className="w-full px-3 py-2 text-sm text-start hover:bg-muted disabled:opacity-50" onClick={() => { action(); onClose(); }}>{t(kind === 'tags' ? 'metadata.tags' : 'metadata.parent')}</button>)}
          <button disabled={!addAllowed} title={!addAllowed ? t('table.edit.structureBlocked') : undefined}
            onClick={() => {
              onAddRowAbove?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>{t(transposed ? 'grid.insertRecordBefore' : 'grid.insertRowAbove')}</span>
          </button>
          <button disabled={!addAllowed} title={!addAllowed ? t('table.edit.structureBlocked') : undefined}
            onClick={() => {
              onAddRowBelow?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>{t(transposed ? 'grid.insertRecordAfter' : 'grid.insertRowBelow')}</span>
          </button>
          <div className="border-t border-border my-1" />
          <button disabled={!deleteAllowed} title={!deleteAllowed ? t('table.edit.structureBlocked') : undefined}
            onClick={() => {
              onDeleteRow?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-red-600"
          >
            <Trash2 className="w-4 h-4" />
            <span>{t(transposed ? 'grid.deleteRecord' : 'grid.deleteRow')}</span>
          </button>
        </>
      ) : (
        <>
          <button disabled={!addAllowed} title={!addAllowed ? t('table.edit.structureBlocked') : undefined}
            onClick={() => {
              onAddColumnLeft?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>{t('grid.insertColumnLeft')}</span>
          </button>
          <button disabled={!addAllowed} title={!addAllowed ? t('table.edit.structureBlocked') : undefined}
            onClick={() => {
              onAddColumnRight?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>{t('grid.insertColumnRight')}</span>
          </button>
          <div className="border-t border-border my-1" />
          <button disabled={!deleteAllowed} title={!deleteAllowed ? t('table.edit.structureBlocked') : undefined}
            onClick={() => {
              onDeleteColumn?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-red-600"
          >
            <Trash2 className="w-4 h-4" />
            <span>{t('grid.deleteColumn')}</span>
          </button>
        </>
      )}
      {pluginContext && <PluginContextItems context={{ ...pluginContext, type }} onClose={onClose} />}
    </div>
  );
};