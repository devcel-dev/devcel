interface BenchmarkResult {
  name: string;
  duration: number;
  operations: number;
  opsPerSecond: number;
}

export class PerformanceBenchmark {
  private static results: BenchmarkResult[] = [];

  /**
   * Run a benchmark
   */
  static async run(
    name: string, 
    operations: number, 
    fn: () => void | Promise<void>
  ): Promise<BenchmarkResult> {
    // Warm up
    for (let i = 0; i < 10; i++) {
      await fn();
    }

    // Actual benchmark
    const start = performance.now();
    
    for (let i = 0; i < operations; i++) {
      await fn();
    }
    
    const end = performance.now();
    const duration = end - start;
    const opsPerSecond = (operations / duration) * 1000;

    const result: BenchmarkResult = {
      name,
      duration,
      operations,
      opsPerSecond
    };

    this.results.push(result);
    return result;
  }

  /**
   * Compare two implementations
   */
  static async compare(
    name1: string,
    fn1: () => void | Promise<void>,
    name2: string,
    fn2: () => void | Promise<void>,
    operations: number = 1000
  ): Promise<void> {
    console.log(`🏁 Starting benchmark: ${name1} vs ${name2}`);
    console.log(`Operations per test: ${operations}\n`);

    const result1 = await this.run(name1, operations, fn1);
    const result2 = await this.run(name2, operations, fn2);

    console.log(`📊 Results:`);
    console.log(`${name1}:`);
    console.log(`  Duration: ${result1.duration.toFixed(2)}ms`);
    console.log(`  Ops/sec: ${result1.opsPerSecond.toFixed(0)}`);
    
    console.log(`\n${name2}:`);
    console.log(`  Duration: ${result2.duration.toFixed(2)}ms`);
    console.log(`  Ops/sec: ${result2.opsPerSecond.toFixed(0)}`);

    const speedup = result2.opsPerSecond / result1.opsPerSecond;
    console.log(`\n🚀 ${name2} is ${speedup.toFixed(2)}x ${speedup > 1 ? 'faster' : 'slower'} than ${name1}`);
  }

  /**
   * Clear results
   */
  static clear(): void {
    this.results = [];
  }

  /**
   * Get all results
   */
  static getResults(): BenchmarkResult[] {
    return [...this.results];
  }

  /**
   * Print summary
   */
  static printSummary(): void {
    if (this.results.length === 0) {
      console.log('No benchmark results available');
      return;
    }

    console.log('\n📈 Benchmark Summary:');
    console.log('='.repeat(60));
    
    // Sort by ops/sec descending
    const sorted = [...this.results].sort((a, b) => b.opsPerSecond - a.opsPerSecond);
    
    sorted.forEach((result, index) => {
      console.log(`${index + 1}. ${result.name}`);
      console.log(`   Duration: ${result.duration.toFixed(2)}ms`);
      console.log(`   Operations: ${result.operations}`);
      console.log(`   Ops/sec: ${result.opsPerSecond.toFixed(0)}`);
      console.log('');
    });
  }
}

// Export to window for console access
if (typeof window !== 'undefined') {
  (window as any).benchmark = PerformanceBenchmark;
}