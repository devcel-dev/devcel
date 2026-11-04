import { appPrompt } from '@/app/services/appDialogs';
import { t, useI18n } from '@/app/i18n';
import React, { useRef } from "react";
import { useCurrentEditor, type Editor } from '@tiptap/react';
import { isNodeSelection } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from "lucide-react";

function EditorBubbleItem({ onSelect, children, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> & { onSelect: (editor: Editor) => void }) {
  const { editor } = useCurrentEditor();
  if (!editor) return null;
  return <button {...props} type="button" onMouseDown={event => event.preventDefault()} onClick={() => onSelect(editor)}>{children}</button>;
}

export const MarkdownBubbleMenu: React.FC = () => {
  useI18n();
  const linkPromptPending = useRef(false);
  const { editor } = useCurrentEditor();
  if (!editor) return null;
  return (
    <BubbleMenu editor={editor} className="markdown-bubble" options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: current, state }) => current.isEditable && !current.isActive('image') && !state.selection.empty && !isNodeSelection(state.selection)}>
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().toggleBold().run();
        }}
        title={t('grid.markdown.format.bold')}
        aria-label={t('grid.markdown.format.bold')}
        className="markdown-bubble-item"
      >
        <Bold className="h-4 w-4" />
      </EditorBubbleItem>
      
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().toggleItalic().run();
        }}
        title={t('grid.markdown.format.italic')}
        aria-label={t('grid.markdown.format.italic')}
        className="markdown-bubble-item"
      >
        <Italic className="h-4 w-4" />
      </EditorBubbleItem>
      
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().toggleUnderline().run();
        }}
        title={t('grid.markdown.format.underline')}
        aria-label={t('grid.markdown.format.underline')}
        className="markdown-bubble-item"
      >
        <Underline className="h-4 w-4" />
      </EditorBubbleItem>
      
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().toggleStrike().run();
        }}
        title={t('grid.markdown.format.strike')}
        aria-label={t('grid.markdown.format.strike')}
        className="markdown-bubble-item"
      >
        <Strikethrough className="h-4 w-4" />
      </EditorBubbleItem>
      
      <div className="h-6 w-px bg-border mx-1" />
      
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().toggleCode().run();
        }}
        title={t('grid.markdown.format.inlineCode')}
        aria-label={t('grid.markdown.format.inlineCode')}
        className="markdown-bubble-item"
      >
        <Code className="h-4 w-4" />
      </EditorBubbleItem>
      
      <EditorBubbleItem
        onSelect={async (editor) => {
          if (linkPromptPending.current) return;
          linkPromptPending.current = true;
          const { from, to } = editor.state.selection;
          const document = editor.state.doc;
          try {
            const url = await appPrompt(t('grid.markdown.enterUrl'));
            if (url && !editor.isDestroyed && editor.isEditable && editor.state.doc.eq(document)) {
              editor.chain().focus().setTextSelection({ from, to }).setLink({ href: url }).run();
            }
          } finally { linkPromptPending.current = false; }
        }}
        title={t('grid.markdown.format.link')}
        aria-label={t('grid.markdown.format.link')}
        className="markdown-bubble-item"
      >
        <Link className="h-4 w-4" />
      </EditorBubbleItem>
      
      <div className="h-6 w-px bg-border mx-1" />
      
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().setTextAlign('left').run();
        }}
        title={t('grid.markdown.format.alignLeft')}
        aria-label={t('grid.markdown.format.alignLeft')}
        className="markdown-bubble-item"
      >
        <AlignLeft className="h-4 w-4" />
      </EditorBubbleItem>
      
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().setTextAlign('center').run();
        }}
        title={t('grid.markdown.format.alignCenter')}
        aria-label={t('grid.markdown.format.alignCenter')}
        className="markdown-bubble-item"
      >
        <AlignCenter className="h-4 w-4" />
      </EditorBubbleItem>
      
      <EditorBubbleItem
        onSelect={(editor) => {
          editor.chain().focus().setTextAlign('right').run();
        }}
        title={t('grid.markdown.format.alignRight')}
        aria-label={t('grid.markdown.format.alignRight')}
        className="markdown-bubble-item"
      >
        <AlignRight className="h-4 w-4" />
      </EditorBubbleItem>
    </BubbleMenu>
  );
};