/** Lossless offsets into the complete shipped notice; no attribution is deduplicated away. */
export function indexNotices(text: string) {
  const starts = [0];
  const boundary = /^={78}\r?\n/gm;
  for (const match of text.matchAll(boundary)) if (match.index > 0) starts.push(match.index);
  return starts.map((start, id) => {
    const end = starts[id + 1] ?? text.length;
    const head = text.slice(start, Math.min(start + 512, end)).split(/\r?\n/).find(line => line && !/^=+$/.test(line)) ?? '';
    return { id, start, end, title: head };
  });
}

export const NOTICE_PAGE_SIZE = 24000;
export function noticePages(text: string, start: number, end: number) {
  const pages: Array<[number, number]> = [];
  for (let at = start; at < end;) {
    let next = Math.min(at + NOTICE_PAGE_SIZE, end);
    if (next < end && /[\uD800-\uDBFF]/.test(text[next - 1])) next--;
    pages.push([at, next]); at = next;
  }
  return pages.length ? pages : [[start, start] as [number, number]];
}
