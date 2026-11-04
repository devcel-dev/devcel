import { useI18n, t } from '@/app/i18n';
import React from 'react';
import { X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileNode } from "@/app/pages/main_window/project_view/file_browser_view/types";

interface PropertiesPanelProps {
    selectedItem: FileNode | null;
    onClose: () => void;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({ selectedItem, onClose }) => {
  useI18n();
    return (
        <div className="h-full border-l bg-background">
            <Card className="h-full border-0 rounded-none shadow-none flex flex-col">
                <CardHeader className="pb-2 shrink-0 flex-row items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium">{t('properties.title')}</CardTitle>
                    <button type="button" aria-label={t('common.close')} onClick={onClose} className="rounded p-1 hover:bg-muted"><X size={16} aria-hidden="true" /></button>
                </CardHeader>
                <CardContent className="space-y-4 min-h-0 flex-1 overflow-y-auto">
                  {!selectedItem ? <p className="text-muted-foreground text-sm">{t('properties.select')}</p> : <>
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('common.name')}</label>
                        <div className="text-sm font-medium break-all">{selectedItem.name}</div>
                    </div>

                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('common.type')}</label>
                        <div className="text-sm capitalize">{t(({file: 'file.kind.file', folder: 'file.kind.folder', table: 'file.kind.table', project: 'file.kind.project', markdown: 'file.kind.markdown', interface: 'file.kind.interface'} as const)[selectedItem.type])}</div>
                    </div>

                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('common.path')}</label>
                        <div className="text-xs text-muted-foreground break-all font-mono bg-muted p-1 rounded">
                            {selectedItem.path}
                        </div>
                    </div>

                    {selectedItem.uuid && (
                        <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">UUID</label>
                            <div className="text-xs text-muted-foreground break-all font-mono bg-muted p-1 rounded">
                                {selectedItem.uuid}
                            </div>
                        </div>
                    )}
                  </>}
                </CardContent>
            </Card>
        </div>
    );
};
