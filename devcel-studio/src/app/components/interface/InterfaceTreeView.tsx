import { useI18n } from '@/app/i18n';
import React from 'react';
import { FileCode } from 'lucide-react';
import { InterfaceListItem } from '@/types/interface';
import { Badge } from '@/components/ui/badge';
import { FileSelectTreeView } from '@/app/components/common/FileSelectTreeView';

interface InterfaceTreeViewProps {
  interfaces: InterfaceListItem[];
  selectedInterfaces: Set<string>;
  onToggleInterface: (path: string) => void;
  onClearAll?: () => void;
  height?: string;
}

export const InterfaceTreeView: React.FC<InterfaceTreeViewProps> = ({
  interfaces,
  selectedInterfaces,
  onToggleInterface,
  onClearAll,
  height = "300px",
}) => {
  const { t } = useI18n();
  const renderBadges = (item: InterfaceListItem) => (
    <Badge variant="secondary" className="text-xs px-1.5 py-0">
      {t('interface.columnCount', { count: item.column_count })}
    </Badge>
  );

  return (
    <FileSelectTreeView
      items={interfaces}
      selectedItems={selectedInterfaces}
      onToggleItem={onToggleInterface}
      fileIcon={FileCode}
      renderBadges={renderBadges}
      emptyMessage={t('interface.notFound')}
      height={height}
      showClearButton={true}
      onClearAll={onClearAll}
      searchPlaceholder={t('interface.list.search')}
    />
  );
};