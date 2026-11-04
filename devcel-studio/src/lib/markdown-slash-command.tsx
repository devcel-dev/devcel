/**
 * Adapted from Novel's slash-command example (Apache-2.0).
 * Modified by Devcel: localized commands, supported actions, and image handling.
 * See LICENSE.novel and THIRD_PARTY.md for the upstream source and license.
 */
import { t, useI18n } from '@/app/i18n';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { exitSuggestion, type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import {
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Text,
  TextQuote,
  Image,
  Minus,
} from "lucide-react";
interface CommandItem {
  title: string;
  description: string;
  searchTerms: string[];
  icon: ReactNode;
  command: (props: { editor: Editor; range: Range }) => void;
}

export const suggestionItems: CommandItem[] = [
  {
    get title() { return t('grid.markdown.command.text.title'); },
    description: '',
    searchTerms: ["p", "paragraph"],
    icon: <Text size={18} />,
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .toggleNode("paragraph", "paragraph")
        .run();
    },
  },
  {
    get title() { return t('grid.markdown.command.todo.title'); },
    description: '',
    searchTerms: ["todo", "task", "list", "check", "checkbox"],
    icon: <CheckSquare size={18} />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    get title() { return t('grid.markdown.command.heading1.title'); },
    description: '',
    searchTerms: ["title", "big", "large"],
    icon: <Heading1 size={18} />,
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 1 })
        .run();
    },
  },
  {
    get title() { return t('grid.markdown.command.heading2.title'); },
    description: '',
    searchTerms: ["subtitle", "medium"],
    icon: <Heading2 size={18} />,
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 2 })
        .run();
    },
  },
  {
    get title() { return t('grid.markdown.command.heading3.title'); },
    description: '',
    searchTerms: ["subtitle", "small"],
    icon: <Heading3 size={18} />,
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 3 })
        .run();
    },
  },
  {
    get title() { return t('grid.markdown.command.bulletList.title'); },
    description: '',
    searchTerms: ["unordered", "point"],
    icon: <List size={18} />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    get title() { return t('grid.markdown.command.numberedList.title'); },
    description: '',
    searchTerms: ["ordered"],
    icon: <ListOrdered size={18} />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    get title() { return t('grid.markdown.command.quote.title'); },
    description: '',
    searchTerms: ["blockquote"],
    icon: <TextQuote size={18} />,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .toggleNode("paragraph", "paragraph")
        .toggleBlockquote()
        .run(),
  },
  {
    get title() { return t('grid.markdown.command.code.title'); },
    description: '',
    searchTerms: ["codeblock"],
    icon: <Code size={18} />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    get title() { return t('grid.markdown.command.image.title'); },
    get description() { return t('grid.markdown.command.image.description'); },
    searchTerms: ["photo", "picture", "media"],
    icon: <Image size={18} />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      // Trigger image upload dialog
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (e) => {
            const src = e.target?.result as string;
            if (!editor.isDestroyed) editor.chain().focus().setImage({ src }).run();
          };
          reader.readAsDataURL(file);
        }
      };
      input.click();
    },
  },
  {
    get title() { return t('grid.markdown.command.divider.title'); },
    description: '',
    searchTerms: ["horizontal rule", "divider", "hr"],
    icon: <Minus size={18} />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
];

type CommandListHandle = { onKeyDown: (props: SuggestionKeyDownProps) => boolean };
const CommandList = forwardRef<CommandListHandle, SuggestionProps<CommandItem>>((props, ref) => {
  useI18n();
  const [selected, setSelected] = useState(0);
  const optionsRef = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { optionsRef.current[selected]?.scrollIntoView({ block: 'nearest' }); }, [selected, props.query]);
  useEffect(() => { setSelected(0); }, [props.query]);
  const select = (index: number) => { const item = props.items[index]; if (item) props.command(item); };
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (props.items.length) setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + props.items.length) % props.items.length);
        return true;
      }
      if (event.key === 'Enter') { select(selected); return true; }
      return false;
    },
  }));
  return <div className="markdown-command" role="listbox" id="slash-command">
    {props.items.length === 0 && <div className="markdown-command-empty">{t('grid.noEditorCommands')}</div>}
    {props.items.map((item, index) => <button type="button" role="option" aria-selected={index === selected}
      key={item.searchTerms.join("|")} ref={element => { optionsRef.current[index] = element; }} className={`markdown-command-item${index === selected ? ' bg-accent text-accent-foreground' : ''}`}
      onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => select(index)}>
      <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">{item.icon}</span>
      <span><span className="block font-medium">{item.title}</span>{item.description && <span className="block text-xs text-muted-foreground">{item.description}</span>}</span>
    </button>)}
  </div>;
});
CommandList.displayName = 'MarkdownCommandList';

export const slashCommand = Extension.create({
  name: 'slash-command',
  addProseMirrorPlugins() {
    return [Suggestion<CommandItem>({
      editor: this.editor,
      char: '/',
      allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name !== 'codeBlock',
      items: ({ query }) => {
        const search = query.trim().toLocaleLowerCase();
        return suggestionItems.filter(item => [item.title, ...item.searchTerms].some(value => value.toLocaleLowerCase().includes(search)));
      },
      command: ({ editor, range, props }) => props.command({ editor, range }),
      render: () => {
        let renderer: ReactRenderer<CommandListHandle, SuggestionProps<CommandItem>> | null = null;
        let stopPositioning: (() => void) | undefined;
        let current: SuggestionProps<CommandItem> | null = null;
        let positionRequest = 0;
        const destroy = () => {
          positionRequest++;
          stopPositioning?.(); stopPositioning = undefined;
          renderer?.element.remove(); renderer?.destroy(); renderer = null; current = null;
        };
        const updatePosition = () => {
          const rect = current?.clientRect?.();
          if (!rect || !renderer || !current) return;
          const element = renderer.element;
          const request = ++positionRequest;
          void computePosition({ getBoundingClientRect: () => rect, contextElement: current.editor.view.dom }, element, {
            strategy: 'fixed', placement: 'bottom-start', middleware: [offset(4), flip(), shift({ padding: 8 })],
          }).then(({ x, y }) => {
            if (renderer?.element === element && request === positionRequest) Object.assign(element.style, { left: `${x}px`, top: `${y}px` });
          });
        };
        return {
          onStart: props => {
            destroy(); current = props;
            renderer = new ReactRenderer(CommandList, { props, editor: props.editor });
            Object.assign(renderer.element.style, { position: 'fixed', zIndex: '50' });
            document.body.append(renderer.element);
            const reference = { getBoundingClientRect: () => current?.clientRect?.() ?? new DOMRect(), contextElement: props.editor.view.dom };
            stopPositioning = autoUpdate(reference, renderer.element, updatePosition, { layoutShift: false });
          },
          onUpdate: props => { current = props; renderer?.updateProps(props); updatePosition(); },
          onKeyDown: props => {
            if (props.event.key === 'Escape') { exitSuggestion(props.view); return true; }
            return renderer?.ref?.onKeyDown(props) ?? false;
          },
          onExit: destroy,
        };
      },
    })];
  },
});
