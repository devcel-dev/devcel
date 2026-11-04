// Development tools
import { PerformanceBenchmark } from './performanceBenchmark';

// Run performance benchmark
export const runBenchmark = async () => {
  console.log('🏃 Running performance benchmark...');
  console.log('This will test common operations in the current view.');
  console.log('Make sure you have a table with data open.\n');

  // Get current table element
  const dataGrid = document.querySelector('.rdg');
  
  if (!dataGrid) {
    console.error('❌ No table view found. Please open a table first.');
    return;
  }

  const viewName = 'DataGrid';
  console.log(`Testing ${viewName}...\n`);

  // Test 1: Cell rendering (simulate scrolling)
  await PerformanceBenchmark.run(`${viewName} - Scroll simulation`, 100, () => {
    window.scrollBy(0, 100);
    window.scrollBy(0, -100);
  });

  // Test 2: Cell selection (simulate clicks)
  const cells = document.querySelectorAll('.rdg-cell');
  if (cells.length > 0) {
    await PerformanceBenchmark.run(`${viewName} - Cell selection`, 50, () => {
      const randomCell = cells[Math.floor(Math.random() * Math.min(cells.length, 100))];
      randomCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  // Test 3: Search operation
  const searchInput = document.querySelector('input[type="search"], input[placeholder*="検索"]') as HTMLInputElement;
  if (searchInput) {
    await PerformanceBenchmark.run(`${viewName} - Search input`, 20, () => {
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  PerformanceBenchmark.printSummary();
  console.log('\n💡 Tip: Switch views and run benchmark again to compare performance.');
};


// Expose functions to window for console access
if (typeof window !== 'undefined') {
  (window as any).devTools = {
    runBenchmark
  };
  
  console.log('Development tools loaded. Use window.devTools to access:');
  console.log('- window.devTools.runBenchmark() - Run performance benchmark');
}