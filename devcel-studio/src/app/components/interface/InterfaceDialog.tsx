import { appConfirm } from '@/app/services/appDialogs';
import { isTableInteractionAllowed, subscribeTableInteractionScope } from '@/app/services/tableInteractionScope';
import { useI18n, formatDateTime, localizeError, message, resolveMessage, type LocalizedMessage } from '@/app/i18n';
// Interface operations dialog

import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { columnTypeLabel } from "@/app/utils/columnTypes";
import { useToast } from "@/components/ui/use-toast";
import { FileCode, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  listInterfaces,
  applyInterfaceToTable,
  syncTableWithInterface,
  getTableInterfaces,
  removeInterfaceFromTable,
  validateInterfaceImplementation,
  checkInterfaceNameCollisions,
  previewInterfaceRemovalImpact,
} from "@/api/interface";
import {
  InterfaceListItem,
  InterfaceImplementation,
  InterfaceValidation,
} from "@/types/interface";
import { InterfaceTreeView } from "./InterfaceTreeView";

interface DialogContext {
  open: boolean;
  tableName: string;
  tableUuid: string;
  expectedProjectSession: string;
}

interface InterfaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableName: string;
  tableUuid: string;
  expectedProjectSession: string;
}

export const InterfaceDialog: React.FC<InterfaceDialogProps> = ({
  open,
  onOpenChange,
  tableName,
  tableUuid,
  expectedProjectSession,
}) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"apply" | "manage">("apply");
  const [interfaces, setInterfaces] = useState<InterfaceListItem[]>([]);
  const [implementedInterfaces, setImplementedInterfaces] = useState<InterfaceImplementation[]>([]);
  const [selectedInterfaces, setSelectedInterfaces] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [interfaceToRemove, setInterfaceToRemove] = useState<{
    interfaceUuid: string;
    tableName: string;
    tableUuid: string;
    expectedProjectSession: string;
    context: DialogContext;
  } | null>(null);
  const [validationResults, setValidationResults] = useState<
    Record<string, InterfaceValidation>
  >({});
  const [removalImpactText, setRemovalImpactText] = useState<LocalizedMessage | null>(null);
  const { toast } = useToast();
  // UUIDs may be identical in copied projects. Bind pending work to this exact
  // dialog lifetime as well as the backend's open-project session.
  const dialogContext = useMemo(() => ({ open, tableName, tableUuid, expectedProjectSession }), [
    open, tableName, tableUuid, expectedProjectSession,
  ]);
  const activeContext = useRef<DialogContext | null>(null);
  const activeRequestController = useRef<AbortController | null>(null);
  const isCurrentContext = useCallback(() => dialogContext.open && activeContext.current === dialogContext
    && isTableInteractionAllowed(dialogContext.expectedProjectSession, dialogContext.tableUuid), [dialogContext]);
  useEffect(() => subscribeTableInteractionScope(() => {
    if (!isTableInteractionAllowed(expectedProjectSession, tableUuid)) activeRequestController.current?.abort();
  }), [expectedProjectSession, tableUuid]);

  useLayoutEffect(() => {
    activeContext.current = dialogContext;
    const controller = new AbortController();
    activeRequestController.current = controller;
    setInterfaces([]);
    setImplementedInterfaces([]);
    setSelectedInterfaces(new Set());
    setValidationResults({});
    setIsLoading(false);
    setDeleteDialogOpen(false);
    setInterfaceToRemove(null);
    setRemovalImpactText(null);
    return () => {
      activeContext.current = null;
      activeRequestController.current = null;
      controller.abort();
    };
  }, [dialogContext]);

  const loadRequest = useRef(0);
  const loadData = useCallback(async () => {
    const request = ++loadRequest.current;
    const live = () => isCurrentContext() && request === loadRequest.current;
    if (!live()) return;
    if (!tableUuid) {
      console.error("Table UUID is not provided");
      return;
    }

    try {
      // Get the list of interfaces
      const interfaceList = await listInterfaces(expectedProjectSession);
      if (!live()) return;
      setInterfaces(interfaceList);

      // Get table implementation information, handling errors separately
      try {
        const tableInterfaces = await getTableInterfaces(tableUuid, expectedProjectSession);
        if (!live()) return;
        setImplementedInterfaces(tableInterfaces);
      } catch (tableError) {
        if (!live()) return;
        console.warn("Failed to load table interfaces:", tableError);
        // Set an empty array if the table is not found
        setImplementedInterfaces([]);
      }
    } catch (error) {
      if (!live()) return;
      console.error("Failed to load interfaces:", error);
      toast({
        title: t('common.error'),
        description: t('interface.list.loadFailed'),
        variant: "destructive",
      });
    }
  }, [isCurrentContext, tableUuid, expectedProjectSession, t, toast]);

  useEffect(() => {
    if (open) {
      void loadData();
      setSelectedInterfaces(new Set());
    }
  }, [dialogContext, loadData, open]);

  const applying = useRef(false);
  const handleApply = async () => {
    if (!isCurrentContext() || applying.current) return;
    if (selectedInterfaces.size === 0) {
      toast({
        title: t('common.error'),
        description: t('interface.dialog.selectRequired'),
        variant: "destructive",
      });
      return;
    }

    applying.current = true;
    setIsLoading(true);
    const requestedInterfaces = [...selectedInterfaces];
    try {
      // Warn before adding columns with the same names as existing columns
      // because they can be hard to distinguish during export
      if (tableUuid) {
        const precedingInterfaceUuids: string[] = [];
        for (const selectedPath of requestedInterfaces) {
          const selectedItem = interfaces.find((i) => i.path === selectedPath);
          if (!selectedItem) continue;
          try {
            const collisions = await checkInterfaceNameCollisions(
              tableUuid,
              selectedItem.uuid,
              expectedProjectSession,
              precedingInterfaceUuids,
            );
            if (!isCurrentContext()) return;
            if (collisions.length > 0) {
              const proceed = await appConfirm(
                t('interface.dialog.collisionConfirm', { name: selectedItem.name, columns: collisions.join(', ') })
              );
              if (!proceed || !isCurrentContext()) return;
            }
            precedingInterfaceUuids.push(selectedItem.uuid);
          } catch (error) {
            if (!isCurrentContext()) return;
            // A failed preview must not silently permit an unreviewed mutation.
            toast({ title: t('common.error'), description: localizeError(error), variant: 'destructive' });
            return;
          }
        }
      }

      let successCount = 0;
      let errorCount = 0;

      // Apply each selected interface in sequence
      for (const selectedPath of requestedInterfaces) {
        const selectedItem = interfaces.find(i => i.path === selectedPath);
        if (!selectedItem) {
          errorCount++;
          continue;
        }

        try {
          const result = await applyInterfaceToTable(tableUuid, selectedItem.uuid, expectedProjectSession, true, activeRequestController.current?.signal);
          if (!isCurrentContext()) return;
          if (result === "ok") {
            successCount++;
          } else {
            errorCount++;
            console.error(`Failed to apply interface ${selectedItem.name}: ${result}`);
          }
        } catch (error) {
          if (!isCurrentContext()) return;
          errorCount++;
          console.error(`Error applying interface ${selectedItem.name}:`, error);
        }
      }

      // Display the result
      if (successCount > 0 && errorCount === 0) {
        toast({
          title: t('interface.dialog.appliedCount', { count: successCount }),
        });
        await loadData();
        if (!isCurrentContext()) return;
        setSelectedInterfaces(new Set());

        // Close the dialog and notify the parent of changes
        onOpenChange(false);

        // Trigger a table reload
        window.dispatchEvent(new CustomEvent('table-data-changed', {
          detail: { tableUuid, projectSession: expectedProjectSession }
        }));
      } else if (successCount > 0 && errorCount > 0) {
        toast({
          title: t('interface.dialog.partialSuccess'),
          description: t('interface.dialog.appliedPartial', { success: successCount, failed: errorCount }),
          variant: "destructive",
        });
        await loadData();
        if (!isCurrentContext()) return;

        // Reload the table even after partial success
        window.dispatchEvent(new CustomEvent('table-data-changed', {
          detail: { tableUuid, projectSession: expectedProjectSession }
        }));
      } else {
        toast({
          title: t('common.error'),
          description: t('interface.dialog.applyFailed'),
          variant: "destructive",
        });
      }
    } finally {
      applying.current = false;
      if (isCurrentContext()) setIsLoading(false);
    }
  };

  const handleSync = async (interfaceUuid: string) => {
    if (!isCurrentContext()) return;

    setIsLoading(true);
    try {
      // Forced synchronization: Use reconcileAfterSync=true to ensure full consistency
      const result = await syncTableWithInterface(tableUuid, interfaceUuid, expectedProjectSession, true, true, activeRequestController.current?.signal);
      if (!isCurrentContext()) return;

      if (result === "ok") {
        toast({
          title: t('interface.dialog.synced'),
        });
        await loadData();
        if (!isCurrentContext()) return;

        // Trigger a table reload
        window.dispatchEvent(new CustomEvent('table-data-changed', {
          detail: {
            tableUuid,
            projectSession: expectedProjectSession
          }
        }));
      } else {
        console.error("Synchronization error:", result);
        toast({
          title: t('common.error'),
          description: localizeError(result),
          variant: "destructive",
        });
      }
    } catch (error) {
      if (!isCurrentContext()) return;
      console.error("Synchronization exception:", error);
      toast({
        title: t('common.error'),
        description: t('interface.dialog.syncFailed'),
        variant: "destructive",
      });
    } finally {
      if (isCurrentContext()) setIsLoading(false);
    }
  };

  const handleValidate = async (interfaceUuid: string) => {
    if (!isCurrentContext()) return;
    setIsLoading(true);
    try {
      const result = await validateInterfaceImplementation(
        tableUuid,
        interfaceUuid,
        expectedProjectSession
      );
      if (!isCurrentContext()) return;
      setValidationResults((prev) => ({ ...prev, [interfaceUuid]: result }));

      if (result.isValid) {
        toast({
          title: t('interface.dialog.validationSuccess'),
        });
      } else {
        const issueCount =
          result.missingColumns.length +
          result.typeMismatches.length +
          result.constraintViolations.length;
        toast({
          title: t('interface.dialog.validationIssues'),
          description: t('interface.dialog.issueCount', { count: issueCount }),
          variant: "destructive",
        });
      }
    } catch (error) {
      if (!isCurrentContext()) return;
      console.error("Validation failed:", error);
      toast({
        title: t('common.error'),
        description: t('interface.dialog.validateFailed', { error: localizeError(error) }),
        variant: "destructive",
      });
    } finally {
      if (isCurrentContext()) setIsLoading(false);
    }
  };

  const handleRemoveInterface = async (interfaceUuid: string) => {
    if (!isCurrentContext()) return;
    // Show exactly what will be lost and how much before asking for confirmation
    let impactText: LocalizedMessage = message('interface.dialog.removeImpact');
    if (tableUuid) {
      try {
        const impact = await previewInterfaceRemovalImpact(tableUuid, interfaceUuid, expectedProjectSession);
        if (!isCurrentContext()) return;
        if (impact.columns.length > 0) {
          impactText = message('interface.dialog.removeImpactValues', { columns: impact.columns.join(', '), count: impact.value_count });
        }
      } catch (error) {
        if (!isCurrentContext()) return;
        console.warn("Failed to retrieve removal impact:", error);
      }
    }
    setRemovalImpactText(impactText);
    setInterfaceToRemove({ interfaceUuid, tableName, tableUuid, expectedProjectSession, context: dialogContext });
    setDeleteDialogOpen(true);
  };

  const confirmRemoveInterface = async () => {
    if (!interfaceToRemove || !isCurrentContext() || interfaceToRemove.context !== dialogContext) return;
    const removal = interfaceToRemove;

    setIsLoading(true);
    try {
      const result = await removeInterfaceFromTable(
        removal.tableUuid,
        removal.interfaceUuid,
        removal.expectedProjectSession,
        activeRequestController.current?.signal
      );
      if (!isCurrentContext()) return;

      if (result === "ok") {
        toast({
          title: t('interface.dialog.removed', { name: removal.interfaceUuid }),
        });
        await loadData();
        if (!isCurrentContext()) return;

        // Trigger a table reload
        window.dispatchEvent(new CustomEvent('table-data-changed', {
          detail: { tableUuid, projectSession: expectedProjectSession }
        }));
      } else {
        toast({
          title: t('common.error'),
          description: localizeError(result),
          variant: "destructive",
        });
      }
    } catch {
      if (!isCurrentContext()) return;
      toast({
        title: t('common.error'),
        description: t('interface.dialog.removeFailed'),
        variant: "destructive",
      });
    } finally {
      if (isCurrentContext()) {
        setIsLoading(false);
        setDeleteDialogOpen(false);
        setInterfaceToRemove(null);
      }
    }
  };

  const handleSyncAll = async () => {
    if (!isCurrentContext()) return;
    if (implementedInterfaces.length === 0) {
      toast({
        title: t('common.error'),
        description: t('interface.dialog.noSyncTargets'),
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    let successCount = 0;
    let errorCount = 0;

    try {
      for (const impl of implementedInterfaces) {
        try {
          const result = await syncTableWithInterface(tableUuid, impl.interfaceUuid, expectedProjectSession, true, true, activeRequestController.current?.signal);
          if (!isCurrentContext()) return;
          if (result === "ok") {
            successCount++;
          } else {
            errorCount++;
            console.error(`Failed to sync interface ${impl.interfaceUuid}: ${result}`);
          }
        } catch (error) {
          if (!isCurrentContext()) return;
          errorCount++;
          console.error(`Error syncing interface ${impl.interfaceUuid}:`, error);
        }
      }

      // Display the result
      if (successCount > 0 && errorCount === 0) {
        toast({
          title: t('interface.dialog.syncedCount', { count: successCount }),
        });
        await loadData();
        if (!isCurrentContext()) return;

        // Trigger a table reload
        window.dispatchEvent(new CustomEvent('table-data-changed', {
          detail: { tableUuid, projectSession: expectedProjectSession }
        }));
      } else if (successCount > 0 && errorCount > 0) {
        toast({
          title: t('interface.dialog.partialSuccess'),
          description: t('interface.dialog.syncedPartial', { success: successCount, failed: errorCount }),
          variant: "destructive",
        });
        await loadData();
        if (!isCurrentContext()) return;

        // Reload the table even after partial success
        window.dispatchEvent(new CustomEvent('table-data-changed', {
          detail: { tableUuid, projectSession: expectedProjectSession }
        }));
      } else {
        toast({
          title: t('common.error'),
          description: t('interface.dialog.syncAllFailed'),
          variant: "destructive",
        });
      }
    } finally {
      if (isCurrentContext()) setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] h-[600px] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('interface.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('interface.dialog.description', { name: tableName })}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "apply" | "manage")} className="flex-1 flex flex-col">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="apply">{t('interface.dialog.applyTab')}</TabsTrigger>
            <TabsTrigger value="manage">{t('interface.dialog.manageTab')}</TabsTrigger>
          </TabsList>

          <TabsContent value="apply" className="flex-1 space-y-4 mt-4">
            <Label>{t('interface.dialog.applyLabel')}</Label>
            <InterfaceTreeView
              interfaces={interfaces}
              selectedInterfaces={selectedInterfaces}
              onToggleInterface={(path) => {
                setSelectedInterfaces(prev => {
                  const newSet = new Set(prev);
                  if (newSet.has(path)) {
                    newSet.delete(path);
                  } else {
                    newSet.add(path);
                  }
                  return newSet;
                });
              }}
              onClearAll={() => setSelectedInterfaces(new Set())}
              height="250px"
            />
          </TabsContent>

          <TabsContent value="manage" className="flex-1 space-y-4 mt-4">
            <div className="flex items-center justify-between">
              <Label>{t('interface.dialog.implemented')}</Label>
              {implementedInterfaces.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSyncAll}
                  disabled={isLoading}
                >

                  {t('interface.dialog.syncAll')}
                </Button>
              )}
            </div>
            {implementedInterfaces.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">

                {t('interface.dialog.notImplemented')}
              </div>
            ) : (
              <ScrollArea className="h-[calc(100%-40px)]">
                <div className="space-y-2 pr-4">
                  {[...implementedInterfaces]
                    .sort((a, b) => {
                      // Sort by interface name in ascending order
                      const nameA = interfaces.find(i => i.uuid === a.interfaceUuid)?.name || a.interfaceUuid;
                      const nameB = interfaces.find(i => i.uuid === b.interfaceUuid)?.name || b.interfaceUuid;
                      return nameA.localeCompare(nameB);
                    })
                    .map((impl) => {
                      // Get the corresponding name from the interface list
                      const interfaceInfo = interfaces.find(i => i.uuid === impl.interfaceUuid);
                      const displayName = interfaceInfo?.name || impl.interfaceUuid;

                      const validation = validationResults[impl.interfaceUuid];

                      return (
                        <div key={impl.interfaceUuid} className="border rounded-lg">
                          <div className="flex items-center justify-between p-3">
                            <div className="flex items-center gap-2">
                              <FileCode className="w-4 h-4 text-muted-foreground" />
                              <div>
                                <div className="font-medium">{displayName}</div>
                                <div className="text-sm text-muted-foreground">
                                  {t('interface.dialog.lastSynced', { date: formatDateTime(new Date(impl.lastSyncDate), { dateStyle: 'short', timeStyle: 'medium' }) })}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleValidate(impl.interfaceUuid)}
                                disabled={isLoading}
                              >

                                {t('interface.dialog.validate')}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleSync(impl.interfaceUuid)}
                                disabled={isLoading}
                              >

                                {t('interface.dialog.sync')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleRemoveInterface(impl.interfaceUuid)}
                                disabled={isLoading}
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                title={t('interface.dialog.removeTooltip')}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                          {validation && (
                            <div className="px-3 pb-3 text-sm space-y-1">
                              {validation.isValid ? (
                                <div className="text-green-600">
                                  ✓ {t('interface.dialog.requirementsMet')}
                                </div>
                              ) : (
                                <>
                                  {validation.missingColumns.map((col) => (
                                    <div key={`missing-${col}`} className="text-destructive">
                                      ✗ {t('interface.dialog.missingColumn', { name: col })}
                                    </div>
                                  ))}
                                  {validation.typeMismatches.map((m) => (
                                    <div
                                      key={`type-${m.columnName}`}
                                      className="text-destructive"
                                    >
                                      ✗ {t('interface.dialog.typeMismatch', { name: m.columnName, expected: columnTypeLabel(m.expectedType), actual: columnTypeLabel(m.actualType) })}
                                    </div>
                                  ))}
                                  {validation.constraintViolations.map((v, i) => (
                                    <div
                                      key={`constraint-${v.columnName}-${i}`}
                                      className="text-destructive"
                                    >
                                      ✗ {localizeError(v.diagnostic)}
                                    </div>
                                  ))}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>

            {t('common.close')}
          </Button>
          {activeTab === "apply" && (
            <Button onClick={handleApply} disabled={selectedInterfaces.size === 0 || isLoading}>
              {selectedInterfaces.size > 1
                ? t('interface.dialog.applyCount', { count: selectedInterfaces.size })
                : t('interface.dialog.apply')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('interface.dialog.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const interfaceInfo = interfaces.find(i => i.uuid === interfaceToRemove?.interfaceUuid);
                const displayName = interfaceInfo?.name || interfaceToRemove?.interfaceUuid;
                return (
                  <>
                    {t('interface.dialog.removeConfirm', { table: tableName, name: displayName ?? '' })}
                    <br />
                    <br />
                    {removalImpactText && resolveMessage(removalImpactText)}
                    <br />

                    {t('interface.dialog.irreversible')}
                  </>
                );
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveInterface}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};
