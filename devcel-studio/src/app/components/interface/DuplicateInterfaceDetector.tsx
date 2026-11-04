import { useI18n, localizeError } from '@/app/i18n';
// Automatically detect other copies of the same interface (conflict copies)
//
// When loading a project, automatically detect conflict copies created
// by file synchronization services such as Dropbox and guide users through merging.
// Do not require users to locate file paths themselves (artist-friendly design).

import React, { useState, useEffect, useCallback } from "react";
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
import { useToast } from "@/components/ui/use-toast";
import {
  findDuplicateInterfaceCopies,
  importInterfaceHistory,
} from "@/api/interface";
import { DuplicateInterfaceCopy } from "@/types/interface";

interface DuplicateInterfaceDetectorProps {
  /** Project identifier; recheck whenever it changes */
  expectedProjectSession: string;
}

export const DuplicateInterfaceDetector: React.FC<DuplicateInterfaceDetectorProps> = ({
  expectedProjectSession,
}) => {
  const { t } = useI18n();
  const [duplicates, setDuplicates] = useState<DuplicateInterfaceCopy[]>([]);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const check = useCallback(async () => {
    try {
      const found = await findDuplicateInterfaceCopies(expectedProjectSession);
      setDuplicates(found);
    } catch (error) {
      // Detection failures are nonfatal; skip quietly without interrupting normal work
      console.warn("Failed to detect conflict copies:", error);
    }
  }, [expectedProjectSession]);

  useEffect(() => {
    check();
  }, [check]);

  const current = duplicates[0];

  const handleAbsorb = async () => {
    if (!current) return;
    setBusy(true);
    try {
      // Retain the source copy: external writers may add history during import.
      const absorbed = await importInterfaceHistory(
        current.interface_uuid,
        current.duplicate_path,
        expectedProjectSession,
        false
      );
      if (absorbed > 0) {
        toast({
          title: t('interface.duplicate.imported'),
          description: t('interface.duplicate.review', { name: current.name }),
        });
      } else {
        toast({
          title: t('interface.duplicate.imported'),
          description: t('interface.duplicate.noNewEdits', { name: current.name }),
        });
      }
      setDuplicates((prev) => prev.slice(1));
    } catch (error) {
      console.error(error);
      toast({
        title: t('interface.duplicate.failed'),
        description: localizeError(error),
        variant: "destructive",
      });
      setDuplicates((prev) => prev.slice(1));
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = () => {
    setDuplicates((prev) => prev.slice(1));
  };

  if (!current) return null;

  return (
    <AlertDialog open={true}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('interface.duplicate.found', { name: current.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('interface.duplicate.explanation')}
            <br />
            <br />
            {t('interface.duplicate.remindLater')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleSkip} disabled={busy}>

            {t('interface.duplicate.later')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleAbsorb} disabled={busy}>
            {busy ? t('interface.duplicate.importing') : t('interface.duplicate.import')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
