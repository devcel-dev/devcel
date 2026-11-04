import { indexNotices, noticePages } from './licenseNoticeIndex';

let text = '';
let sections: ReturnType<typeof indexNotices> = [];
self.onmessage = async (event: MessageEvent<{ kind: string; id?: number; page?: number; request?: number }>) => {
  try {
    if (event.data.kind === 'load') {
      const response = await fetch('/legal/THIRD-PARTY-NOTICES.txt');
      if (!response.ok) throw new Error(`OSS: ${response.status}`);
      text = await response.text();
      sections = indexNotices(text);
      self.postMessage({ kind: 'index', entries: sections.map(({ id, title }) => ({ id, title })) });
    } else if (event.data.kind === 'page') {
      const section = sections[event.data.id ?? 0];
      if (!section) throw new Error('OSS: unknown section');
      const pages = noticePages(text, section.start, section.end);
      const page = Math.max(0, Math.min(event.data.page ?? 0, pages.length - 1));
      const [start, end] = pages[page];
      self.postMessage({ kind: 'page', request: event.data.request, page, count: pages.length, text: text.slice(start, end) });
    }
  } catch (error) {
    self.postMessage({ kind: 'error', message: String(error) });
  }
};
