import { isMarkdownSaveKey } from '@/app/utils/shortcutGuards';
import { useI18n, localizeError } from '@/app/i18n';
import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { EditorProvider } from '@tiptap/react';
import { defaultExtensions } from '@/lib/markdown-extensions';
import { slashCommand } from '@/lib/markdown-slash-command';
import { MarkdownBubbleMenu } from '@/lib/markdown-bubble-menu';
import { markdownSaveCoordinator, type MarkdownDocument, type MarkdownSnapshot } from '@/app/utils/markdownSaveLifecycle';

interface MarkdownViewProps {
  filePath: string;
  fileName: string;
  expectedProjectSession: string;
}

const emptySnapshot: MarkdownSnapshot = {
  content: null, isLoading: true, isSaving: false, isDirty: false, loadError: null, saveError: null,
};
const extensions = [...defaultExtensions, slashCommand];

export const MarkdownView: React.FC<MarkdownViewProps> = ({ filePath, expectedProjectSession }) => {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<MarkdownSnapshot>(emptySnapshot);
  const editorInstanceRef = useRef<any>(null);
  const editorHasChangedRef = useRef(false);
  const documentRef = useRef<MarkdownDocument | null>(null);
  const fileContext = useMemo(() => ({ filePath, expectedProjectSession }), [filePath, expectedProjectSession]);
  const activeFileContext = useRef<typeof fileContext | null>(null);

  const captureContent = useCallback((editor: any, changed = false) => {
    const document = documentRef.current;
    if (activeFileContext.current !== fileContext || !document || !editor || editor.isDestroyed) return;
    if (changed) editorHasChangedRef.current = true;
    if (!editorHasChangedRef.current) return;
    try {
      // Capture while the transaction/editor is alive, never inside the debounce callback.
      const markdown = editor.storage.markdown?.getMarkdown?.() ?? editor.getHTML();
      document.update(markdown);
    } catch (error) {
      document.setCaptureError(error);
    }
  }, [fileContext]);

  useLayoutEffect(() => {
    const document = markdownSaveCoordinator.open(fileContext);
    activeFileContext.current = fileContext;
    documentRef.current = document;
    editorHasChangedRef.current = false;
    setSnapshot(document.snapshot);
    const unsubscribe = document.subscribe(next => {
      if (activeFileContext.current === fileContext) setSnapshot(next);
    });
    void document.load();
    return () => {
      // Tiptap updates normally capture every edit; take a last synchronous snapshot as well.
      captureContent(editorInstanceRef.current);
      activeFileContext.current = null;
      documentRef.current = null;
      editorInstanceRef.current = null;
      unsubscribe();
      markdownSaveCoordinator.release(document);
    };
  }, [fileContext, captureContent]);

  const flush = useCallback(async () => {
    if (activeFileContext.current !== fileContext) return;
    captureContent(editorInstanceRef.current);
    await documentRef.current?.flush();
  }, [fileContext, captureContent]);

  useEffect(() => {
    const saveOnShortcut = (event: KeyboardEvent) => {
      if (!isMarkdownSaveKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void flush().catch(() => { /* The editor and its unsaved draft stay visible for retry. */ });
    };
    window.addEventListener('keydown', saveOnShortcut, true);
    return () => window.removeEventListener('keydown', saveOnShortcut, true);
  }, [flush]);

  if (snapshot.isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">{t('grid.markdownLoading')}</div>
      </div>
    );
  }

  if (snapshot.loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="text-red-500 mb-4">{t('grid.markdownError')}</div>
        <div className="text-red-400 text-sm mb-4">{localizeError(snapshot.loadError)}</div>
        <button
          onClick={() => { void documentRef.current?.load(); }}
          className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
        >
          {t('grid.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative bg-background">
      {Boolean(snapshot.saveError) && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-red-300 bg-red-50 px-4 py-2 text-red-700">
          <span>{t('project.saveFailed', { error: localizeError(snapshot.saveError) })}</span>
          <button type="button" onClick={() => { void flush().catch(() => {}); }} className="shrink-0 underline">
            {t('grid.retry')}
          </button>
        </div>
      )}
      {/* Pending edits remain visible while debounce or an earlier write is running. */}
      {(snapshot.isSaving || (snapshot.isDirty && !snapshot.saveError)) && (
        <div className="absolute top-6 right-6 z-30 bg-linear-to-r/srgb from-accent to-secondary text-accent-foreground px-4 py-2 rounded-full shadow-lg border border-primary/30 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            <span className="text-sm font-medium">{t('grid.saving')}</span>
          </div>
        </div>
      )}


      <div className="flex-1 overflow-auto">
        <div className="min-h-full prose prose-lg max-w-none p-4">
          <EditorProvider
            content={snapshot.content ?? ''}
            extensions={extensions}
            onCreate={({ editor }) => {
              if (activeFileContext.current === fileContext) editorInstanceRef.current = editor;
            }}
            onUpdate={({ editor, transaction }) => {
              if (transaction.docChanged) captureContent(editor, true);
            }}
          >
            <MarkdownBubbleMenu />
          </EditorProvider>
        </div>
      </div>
    </div>
  );
};
