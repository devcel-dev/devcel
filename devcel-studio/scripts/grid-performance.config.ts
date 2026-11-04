import { defineConfig } from 'vite';
import tailwindcss from "@tailwindcss/vite";
import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import path from 'node:path';
export default defineConfig({ plugins: [tailwindcss(),{ name: 'temporary-profile-marks', enforce: 'pre', transform(s, id) {
                if (process.env.DEVCEL_GRID_TIMING === '1')
                    return s;
                if (id.endsWith('/DataGridView.tsx')) {
                    const filterExpression = 'const filteredRows = useMemo(() => filterMetadataRows(rows, displayColumns, searchQuery), [rows, searchQuery, displayColumns]);';
                    if (!s.includes(filterExpression)) throw new Error('Grid profile filter instrumentation anchor needs updating');
                    s = s.replace(filterExpression, `const filteredRows = useMemo(() => { const __profileStart=performance.now(); try { return filterMetadataRows(rows, displayColumns, searchQuery); } finally { (window as any).__profile?.marks.push({kind:"filter",ms:performance.now()-__profileStart}); } }, [rows, searchQuery, displayColumns]);`);
                }
                if (id.endsWith('/gridDisplayModel.ts')) {
                    const modelStart = 'table: TableData, presentation: TablePresentation | null, session: string): GridDisplayModel {';
                    const modelEnd = 'return { session, tableUuid: table.uuid, columns, rows: sharedRows };';
                    if (!s.includes(modelStart) || !s.includes(modelEnd)) throw new Error('Grid profile display-model instrumentation anchors need updating');
                    s = s.replace(modelStart, `${modelStart} const __profileStart=performance.now(); try {`).replace(modelEnd, `${modelEnd} } finally { (window as any).__profile?.marks.push({kind:"display-model",ms:performance.now()-__profileStart}); }`);
                }
                if (id.endsWith('/Cell.tsx')) {
                    // cellRenders remains host evaluation count for existing bailout contracts.
                    const host = 'transientLock = false }: CellRendererProps<R, SR>) {';
                    const component = 'function Cell<R, SR>(cellProps: CellRendererProps<R, SR>) {';
                    const plain = '  const { hostProps } = getCellHostProps(props);';
                    if (![host, component, plain].every(anchor => s.includes(anchor))) throw new Error('Cell profile anchors need updating');
                    s = s.replace(host, `${host} (window as any).__profile.cellRenders++;`)
                      .replace(component, `${component} (window as any).__profile.cellComponentRenders = ((window as any).__profile.cellComponentRenders || 0) + 1;`)
                      .replace(plain, `(window as any).__profile.pureHostBuilds = ((window as any).__profile.pureHostBuilds || 0) + 1; ${plain}`);
                    const background = 'if (backgroundColor) {';
                    if (!s.includes(background)) throw new Error('Grid profile cell-background instrumentation anchor needs updating');
                    s = s.replace(background, `(window as any).__profile.cellBackgrounds[rowIdx + ":" + column.idx] = backgroundColor; ${background}`);
                }
                if (id.endsWith('/Row.tsx'))
                    s = s.replace('}: RenderRowProps<R, SR>) {', '}: RenderRowProps<R, SR>) { (window as any).__profile.rowRenders++;');
                return s;
            } }, wyw({ include: ['**/src/lib/react-data-grid/**/*.{ts,tsx}'] }), react()], resolve: { alias: [...(process.env.DEVCEL_GRID_TIMING === '1' ? [] : [{ find: 'react-dom/client', replacement: 'react-dom/profiling' }]), { find: /^@\/lib\/react-data-grid$/, replacement: path.resolve(import.meta.dirname, '../src/lib/react-data-grid/index.ts') }, { find: '@', replacement: path.resolve(import.meta.dirname, '../src') }] }, build: { target: 'esnext' } });

