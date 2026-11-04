/**
 * Adapted from Novel's editor extension examples (Apache-2.0).
 * Modified by Devcel: localization, extension selection, and editor behavior.
 * See LICENSE.novel and THIRD_PARTY.md for the upstream source and license.
 */
import { t, subscribeLocale } from '@/app/i18n';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Image } from '@tiptap/extension-image';
import { Underline } from '@tiptap/extension-underline';
import type MarkdownIt from 'markdown-it';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { StarterKit } from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from "tiptap-markdown";
import TextAlign from '@tiptap/extension-text-align';
import AutoJoiner from 'tiptap-extension-auto-joiner';
import { cx } from "class-variance-authority";

const localePresentation = Extension.create({
  name: 'localePresentation',
  addProseMirrorPlugins() {
    return [new Plugin({
      view(view) {
        const unsubscribe = subscribeLocale(() => {
          if (!view.isDestroyed) view.updateState(view.state);
        });
        return { destroy: unsubscribe };
      },
    })];
  },
});

const placeholder = Placeholder.configure({
  placeholder: ({ node }) => {
    if (node.type.name === "heading") {
      return t('grid.markdown.headingPlaceholder', { level: node.attrs.level });
    }
    return t('grid.markdown.bodyPlaceholder');
  },
  includeChildren: true,
});

// CommonMark has no underline syntax. Only exact <u> tags are accepted; all
// other raw HTML still passes through Markdown's html:false escaping.
const underlineParsers = new WeakSet<MarkdownIt>();
const underline = Underline.extend({
  addStorage() {
    return {
      markdown: {
        serialize: { open: '<u>', close: '</u>', mixable: true, expelEnclosingWhitespace: true },
        parse: {
          setup(markdown: MarkdownIt) {
            if (underlineParsers.has(markdown)) return;
            underlineParsers.add(markdown);
            markdown.inline.ruler.before('html_inline', 'devcel_underline', (state, silent) => {
              const match = /^<\/?u>/i.exec(state.src.slice(state.pos));
              if (!match) return false;
              if (!silent) {
                const token = state.push('html_inline', '', 0);
                token.content = match[0].toLowerCase();
                state.pos += match[0].length;
              }
              return true;
            });
          },
        },
      },
    };
  },
});

const image = Image.configure({
  // Slash-command image uploads are stored as data URLs in Markdown.
  allowBase64: true,
  HTMLAttributes: { class: cx("rounded-lg border border-muted") },
});

const taskList = TaskList.configure({
  HTMLAttributes: {
    class: cx("not-prose pl-2 list-none"),
  },
});

const taskItem = TaskItem.configure({
  HTMLAttributes: {
    class: cx("flex gap-2 items-start my-4"),
  },
  nested: true,
});

const horizontalRule = HorizontalRule.configure({
  HTMLAttributes: {
    class: cx("mt-4 mb-6 border-t border-muted-foreground"),
  },
});

const starterKit = StarterKit.configure({
  bulletList: {
    HTMLAttributes: {
      class: cx("list-disc list-outside leading-3 -mt-2"),
    },
  },
  orderedList: {
    HTMLAttributes: {
      class: cx("list-decimal list-outside leading-3 -mt-2"),
    },
  },
  listItem: {
    HTMLAttributes: {
      class: cx("leading-normal -mb-2"),
    },
  },
  blockquote: {
    HTMLAttributes: {
      class: cx("border-l-4 border-muted-foreground pl-4"),
    },
  },
  codeBlock: {
    HTMLAttributes: {
      class: cx("rounded-sm bg-muted border p-5 font-mono font-medium"),
    },
  },
  code: {
    HTMLAttributes: {
      class: cx("rounded-md bg-muted px-1.5 py-1 font-mono font-medium"),
      spellcheck: "false",
    },
  },
  horizontalRule: false,
  underline: false,
  link: {
    HTMLAttributes: { class: cx("text-muted-foreground underline underline-offset-[3px] hover:text-primary transition-colors cursor-pointer") },
  },
  // Documents contain only authored nodes; list shortcuts follow the editor keymap.
  trailingNode: false,
  listKeymap: false,
  dropcursor: {
    color: "hsl(var(--ring))",
    width: 4,
  },
  gapcursor: false,
  undoRedo: {
    depth: 100,
    newGroupDelay: 500,
  },
});

const textAlign = TextAlign.configure({
  types: ['heading', 'paragraph'],
});

const markdown = Markdown.configure({
  html: false,
  transformCopiedText: false,
  transformPastedText: false,
  breaks: false,
  linkify: false,
  bulletListMarker: '-',
});


const autoJoiner = AutoJoiner.configure({
  elementsToJoin: ["bulletList", "orderedList"],
});

export const defaultExtensions = [
  localePresentation,
  starterKit,
  placeholder,
  image,
  taskList,
  taskItem,
  horizontalRule,
  underline,
  textAlign,
  markdown,
  autoJoiner,
];
