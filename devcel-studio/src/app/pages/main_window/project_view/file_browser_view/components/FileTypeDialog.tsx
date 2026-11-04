import { appAlert } from '@/app/services/appDialogs';
import { useI18n, t, localizeError } from '@/app/i18n';
import React, { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { CircleHelp, Table2, FileCode, FileText } from "lucide-react";
import { validateDataName } from "@/app/utils/validation";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// A separate button keeps help clicks out of the radio label's activation area.
function FileTypeHelp({ label, description }: { label: string; description: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const dismiss = () => { setOpen(false); setPinned(false); };

  return (
    <Tooltip open={open || pinned} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t('file.typeHelp', { type: label })}
          aria-pressed={pinned}
          className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            setOpen(false);
            setPinned((value) => !value);
          }}
          onKeyDown={(event) => {
            // RadioGroup's arrow navigation must not select a type from help.
            event.stopPropagation();
            if (event.key === 'Escape' && (open || pinned)) {
              event.preventDefault();
              dismiss();
            }
          }}
        >
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="max-w-[min(20rem,calc(100vw-3rem))] border bg-popover px-3 py-2 text-sm leading-relaxed text-popover-foreground shadow-md"
        onPointerDownOutside={dismiss}
        onEscapeKeyDown={(event) => { event.stopPropagation(); dismiss(); }}
      >
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

export type FileType = "table" | "interface" | "markdown";

interface FileTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (type: FileType, name: string) => Promise<boolean>;
}

export const FileTypeDialog: React.FC<FileTypeDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
}) => {
  useI18n();
  const [fileType, setFileType] = useState<FileType>("table");
  const [fileName, setFileName] = useState("");
  const [validationError, setValidationError] = useState<string>();

  const submitting = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      submitting.current = false;
      setIsSubmitting(false);
      setValidationError(undefined);
    }
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    // A pending creation cannot be cancelled by hiding its result or reopening
    // the same dialog with a second request.
    if (!submitting.current) onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    // Ref guard closes the gap before React commits disabled button state.
    if (!open || submitting.current) return;
    if (!fileName.trim()) {
      setValidationError(t('file.enterName'));
      return;
    }

    // Validate the name without its extension
    const nameWithoutExt = fileName.replace(/\.(table\.toml|interface\.toml|md)$/, "");
    const validation = validateDataName(nameWithoutExt);
    if (!validation.isValid) { setValidationError(validation.errorMessage); return; }
    setValidationError(undefined);

    submitting.current = true;
    setIsSubmitting(true);
    let created = false;
    try {
      created = await onConfirm(fileType, nameWithoutExt);
      if (created) {
        onOpenChange(false);
        setFileName("");
        setFileType("table");
      }
    } catch (error) {
      await appAlert(t('file.createFailed', { error: localizeError(error) }));
    } finally {
      // Keep the latch set until the next opening after success, so queued
      // clicks cannot submit the cleared name while close is being rendered.
      if (!created) {
        submitting.current = false;
        setIsSubmitting(false);
      }
    }
  };

  const getPlaceholder = () => {
    switch (fileType) {
      case "table":
        return t('file.exampleTable');
      case "interface":
        return t('file.exampleInterface');
      case "markdown":
        return t('file.exampleMarkdown');
    }
  };

  const getFileExtension = () => {
    switch (fileType) {
      case "table":
        return ".table.toml";
      case "interface":
        return ".interface.toml";
      case "markdown":
        return ".md";
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('file.newTitle')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <TooltipProvider delayDuration={200}>
          <RadioGroup disabled={isSubmitting} value={fileType} onValueChange={(value) => setFileType(value as FileType)}>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="table" id="table" />
              <Label htmlFor="table" className="flex items-center gap-2 cursor-pointer">
                <Table2 className="w-4 h-4" />
                {t('file.typeTable')}</Label>
              <FileTypeHelp label={t('file.typeTable')} description={t('file.helpTable')} />
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="interface" id="interface" />
              <Label htmlFor="interface" className="flex items-center gap-2 cursor-pointer">
                <FileCode className="w-4 h-4" />
                {t('file.typeInterface')}</Label>
              <FileTypeHelp label={t('file.typeInterface')} description={t('file.helpInterface')} />
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="markdown" id="markdown" />
              <Label htmlFor="markdown" className="flex items-center gap-2 cursor-pointer">
                <FileText className="w-4 h-4" />
                {t('file.typeMarkdown')}</Label>
              <FileTypeHelp label={t('file.typeMarkdown')} description={t('file.helpMarkdown')} />
            </div>
          </RadioGroup>
          </TooltipProvider>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="name" className="break-words">
              {t('common.name')}</Label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                id="name"
                className="min-w-0 flex-1 basis-40"
                aria-invalid={!!validationError}
                aria-describedby={validationError ? "file-create-error" : undefined}
                disabled={isSubmitting}
                value={fileName}
                onChange={(e) => { setFileName(e.target.value); setValidationError(undefined); }}
                placeholder={getPlaceholder()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
              <span className="break-all text-sm text-muted-foreground">
                {getFileExtension()}
              </span>
            </div>
          </div>
        </div>
        {validationError && <p id="file-create-error" role="alert" className="break-words text-sm text-destructive">{validationError}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={isSubmitting} onClick={() => handleOpenChange(false)}>
            {t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>{t('common.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};