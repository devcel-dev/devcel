/**
 * Plugin performance monitoring system
 * Monitor execution time, memory usage, error rate, and other plugin metrics
 */

export interface PerformanceMetrics {
  pluginId: string;
  operationType: 'activation' | 'deactivation' | 'api_call' | 'event_handler';
  startTime: number;
  endTime: number;
  duration: number;
  memoryBefore: number;
  memoryAfter: number;
  memoryDelta: number;
  success: boolean;
  error?: Error;
  metadata?: Record<string, any>;
}

export interface AggregatedMetrics {
  pluginId: string;
  totalCalls: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  successRate: number;
  errorCount: number;
  avgMemoryUsage: number;
  totalMemoryDelta: number;
  lastError?: Error;
  lastUpdated: number;
}

export interface PerformanceThresholds {
  maxActivationTime: number;      // ms
  maxAPICallTime: number;         // ms
  maxMemoryUsage: number;         // MB
  minSuccessRate: number;         // %
  maxErrorRate: number;           // %
}

export class PluginPerformanceMonitor {
  private static instance: PluginPerformanceMonitor;
  private metrics: Map<string, PerformanceMetrics[]> = new Map();
  private aggregatedMetrics: Map<string, AggregatedMetrics> = new Map();
  private thresholds: PerformanceThresholds;
  private observers: ((metrics: PerformanceMetrics) => void)[] = [];

  private constructor() {
    this.thresholds = {
      maxActivationTime: 5000,    // 5 seconds
      maxAPICallTime: 1000,       // 1 second
      maxMemoryUsage: 100,        // 100MB
      minSuccessRate: 95,         // 95%
      maxErrorRate: 5             // 5%
    };
  }

  public static getInstance(): PluginPerformanceMonitor {
    if (!PluginPerformanceMonitor.instance) {
      PluginPerformanceMonitor.instance = new PluginPerformanceMonitor();
    }
    return PluginPerformanceMonitor.instance;
  }

  /**
   * Start measuring performance
   */
  public startMeasurement(
    pluginId: string, 
    operationType: PerformanceMetrics['operationType'],
    metadata?: Record<string, any>
  ): string {
    const measurementId = `${pluginId}-${operationType}-${Date.now()}-${Math.random()}`;
    
    const startMetrics: Partial<PerformanceMetrics> = {
      pluginId,
      operationType,
      startTime: performance.now(),
      memoryBefore: this.getMemoryUsage(),
      metadata
    };

    // Store metrics temporarily
    (this as any)[`_temp_${measurementId}`] = startMetrics;
    
    return measurementId;
  }

  /**
   * Finish measuring performance
   */
  public endMeasurement(
    measurementId: string, 
    success: boolean = true, 
    error?: Error
  ): PerformanceMetrics | null {
    const startMetrics = (this as any)[`_temp_${measurementId}`];
    if (!startMetrics) return null;

    const endTime = performance.now();
    const memoryAfter = this.getMemoryUsage();

    const metrics: PerformanceMetrics = {
      ...startMetrics,
      endTime,
      duration: endTime - startMetrics.startTime,
      memoryAfter,
      memoryDelta: memoryAfter - startMetrics.memoryBefore,
      success,
      error
    };

    // Delete temporary data
    delete (this as any)[`_temp_${measurementId}`];

    // Save metrics
    this.recordMetrics(metrics);

    return metrics;
  }

  /**
   * Decorator measuring function execution time
   */
  public measureFunction<T extends (...args: any[]) => any>(
    pluginId: string,
    operationType: PerformanceMetrics['operationType'],
    fn: T
  ): T {
    return ((...args: any[]) => {
      const measurementId = this.startMeasurement(pluginId, operationType, {
        functionName: fn.name,
        argumentCount: args.length
      });

      try {
        const result = fn(...args);
        
        // For asynchronous functions
        if (result instanceof Promise) {
          return result
            .then((value) => {
              this.endMeasurement(measurementId, true);
              return value;
            })
            .catch((error) => {
              this.endMeasurement(measurementId, false, error);
              throw error;
            });
        }
        
        // For synchronous functions
        this.endMeasurement(measurementId, true);
        return result;
      } catch (error) {
        this.endMeasurement(measurementId, false, error as Error);
        throw error;
      }
    }) as T;
  }

  /**
   * Record metrics
   */
  private recordMetrics(metrics: PerformanceMetrics): void {
    // Save raw metrics
    if (!this.metrics.has(metrics.pluginId)) {
      this.metrics.set(metrics.pluginId, []);
    }
    
    const pluginMetrics = this.metrics.get(metrics.pluginId)!;
    pluginMetrics.push(metrics);

    // Delete old metrics, keeping only the latest 1,000 entries
    if (pluginMetrics.length > 1000) {
      pluginMetrics.splice(0, pluginMetrics.length - 1000);
    }

    // Update aggregate metrics
    this.updateAggregatedMetrics(metrics);

    // Check thresholds
    this.checkThresholds(metrics);

    // Notify observers
    this.notifyObservers(metrics);
  }

  /**
   * Update aggregate metrics
   */
  private updateAggregatedMetrics(newMetrics: PerformanceMetrics): void {
    const existing = this.aggregatedMetrics.get(newMetrics.pluginId);
    
    if (!existing) {
      this.aggregatedMetrics.set(newMetrics.pluginId, {
        pluginId: newMetrics.pluginId,
        totalCalls: 1,
        avgDuration: newMetrics.duration,
        minDuration: newMetrics.duration,
        maxDuration: newMetrics.duration,
        successRate: newMetrics.success ? 100 : 0,
        errorCount: newMetrics.success ? 0 : 1,
        avgMemoryUsage: newMetrics.memoryDelta,
        totalMemoryDelta: newMetrics.memoryDelta,
        lastError: newMetrics.error,
        lastUpdated: Date.now()
      });
      return;
    }

    // Update the existing aggregate
    const totalCalls = existing.totalCalls + 1;
    const successCount = existing.successRate * existing.totalCalls / 100;
    const newSuccessCount = successCount + (newMetrics.success ? 1 : 0);

    this.aggregatedMetrics.set(newMetrics.pluginId, {
      ...existing,
      totalCalls,
      avgDuration: (existing.avgDuration * existing.totalCalls + newMetrics.duration) / totalCalls,
      minDuration: Math.min(existing.minDuration, newMetrics.duration),
      maxDuration: Math.max(existing.maxDuration, newMetrics.duration),
      successRate: (newSuccessCount / totalCalls) * 100,
      errorCount: existing.errorCount + (newMetrics.success ? 0 : 1),
      avgMemoryUsage: (existing.avgMemoryUsage * existing.totalCalls + newMetrics.memoryDelta) / totalCalls,
      totalMemoryDelta: existing.totalMemoryDelta + newMetrics.memoryDelta,
      lastError: newMetrics.error || existing.lastError,
      lastUpdated: Date.now()
    });
  }

  /**
   * Check thresholds
   */
  private checkThresholds(metrics: PerformanceMetrics): void {
    const warnings: string[] = [];

    // Check activation time
    if (metrics.operationType === 'activation' && 
        metrics.duration > this.thresholds.maxActivationTime) {
      warnings.push(`Plugin ${metrics.pluginId} activation took ${metrics.duration.toFixed(2)}ms (threshold: ${this.thresholds.maxActivationTime}ms)`);
    }

    // Check API call time
    if (metrics.operationType === 'api_call' && 
        metrics.duration > this.thresholds.maxAPICallTime) {
      warnings.push(`Plugin ${metrics.pluginId} API call took ${metrics.duration.toFixed(2)}ms (threshold: ${this.thresholds.maxAPICallTime}ms)`);
    }

    // Check memory usage
    if (metrics.memoryDelta > this.thresholds.maxMemoryUsage * 1024 * 1024) {
      warnings.push(`Plugin ${metrics.pluginId} used ${(metrics.memoryDelta / 1024 / 1024).toFixed(2)}MB memory (threshold: ${this.thresholds.maxMemoryUsage}MB)`);
    }

    // Check success rate
    const aggregated = this.aggregatedMetrics.get(metrics.pluginId);
    if (aggregated && aggregated.successRate < this.thresholds.minSuccessRate) {
      warnings.push(`Plugin ${metrics.pluginId} success rate is ${aggregated.successRate.toFixed(1)}% (threshold: ${this.thresholds.minSuccessRate}%)`);
    }

    // Log warnings
    for (const warning of warnings) {
      console.warn('[PluginPerformanceMonitor]', warning);
    }
  }

  /**
   * Get memory usage
   */
  private getMemoryUsage(): number {
    if (typeof performance !== 'undefined' && (performance as any).memory) {
      return (performance as any).memory.usedJSHeapSize || 0;
    }
    return 0;
  }

  /**
   * Notify observers
   */
  private notifyObservers(metrics: PerformanceMetrics): void {
    for (const observer of this.observers) {
      try {
        observer(metrics);
      } catch (error) {
        console.error('[PluginPerformanceMonitor] Observer error:', error);
      }
    }
  }

  /**
   * Add a performance observer
   */
  public addObserver(observer: (metrics: PerformanceMetrics) => void): () => void {
    this.observers.push(observer);
    
    return () => {
      const index = this.observers.indexOf(observer);
      if (index > -1) {
        this.observers.splice(index, 1);
      }
    };
  }

  /**
   * Get aggregate metrics for a plugin
   */
  public getAggregatedMetrics(pluginId: string): AggregatedMetrics | null {
    return this.aggregatedMetrics.get(pluginId) || null;
  }

  /**
   * Get aggregate metrics for all plugins
   */
  public getAllAggregatedMetrics(): Map<string, AggregatedMetrics> {
    return new Map(this.aggregatedMetrics);
  }

  /**
   * Get raw metrics for a plugin
   */
  public getRawMetrics(pluginId: string, limit?: number): PerformanceMetrics[] {
    const metrics = this.metrics.get(pluginId) || [];
    return limit ? metrics.slice(-limit) : metrics;
  }

  /**
   * Generate a performance report
   */
  public generatePerformanceReport(): {
    summary: {
      totalPlugins: number;
      averageActivationTime: number;
      overallSuccessRate: number;
      totalMemoryUsage: number;
    };
    topPerformers: AggregatedMetrics[];
    poorPerformers: AggregatedMetrics[];
    memoryLeaks: AggregatedMetrics[];
    recommendations: string[];
  } {
    const allMetrics = Array.from(this.aggregatedMetrics.values());
    
    const summary = {
      totalPlugins: allMetrics.length,
      averageActivationTime: this.calculateAverageActivationTime(),
      overallSuccessRate: allMetrics.reduce((sum, m) => sum + m.successRate, 0) / allMetrics.length || 0,
      totalMemoryUsage: allMetrics.reduce((sum, m) => sum + m.totalMemoryDelta, 0)
    };

    const topPerformers = allMetrics
      .filter(m => m.successRate >= 98 && m.avgDuration < 100)
      .sort((a, b) => a.avgDuration - b.avgDuration)
      .slice(0, 5);

    const poorPerformers = allMetrics
      .filter(m => m.successRate < 90 || m.avgDuration > 1000)
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 5);

    const memoryLeaks = allMetrics
      .filter(m => m.totalMemoryDelta > 50 * 1024 * 1024) // 50MB
      .sort((a, b) => b.totalMemoryDelta - a.totalMemoryDelta);

    const recommendations = this.generateRecommendations(allMetrics);

    return {
      summary,
      topPerformers,
      poorPerformers,
      memoryLeaks,
      recommendations
    };
  }

  /**
   * Calculate average activation time
   */
  private calculateAverageActivationTime(): number {
    let totalTime = 0;
    let count = 0;

    for (const [_pluginId, metrics] of this.metrics) {
      const activationMetrics = metrics.filter(m => m.operationType === 'activation');
      if (activationMetrics.length > 0) {
        totalTime += activationMetrics[activationMetrics.length - 1].duration;
        count++;
      }
    }

    return count > 0 ? totalTime / count : 0;
  }

  /**
   * Generate performance improvement recommendations
   */
  private generateRecommendations(metrics: AggregatedMetrics[]): string[] {
    const recommendations: string[] = [];

    // Recommendations for slow plugins
    const slowPlugins = metrics.filter(m => m.avgDuration > 500);
    if (slowPlugins.length > 0) {
      recommendations.push(
        `${slowPlugins.length} plugins have average execution time > 500ms. Consider optimization.`
      );
    }

    // Memory usage recommendations
    const memoryHeavyPlugins = metrics.filter(m => m.avgMemoryUsage > 10 * 1024 * 1024);
    if (memoryHeavyPlugins.length > 0) {
      recommendations.push(
        `${memoryHeavyPlugins.length} plugins use > 10MB memory on average. Consider memory optimization.`
      );
    }

    // Error rate recommendations
    const errorPronePlugins = metrics.filter(m => m.successRate < 95);
    if (errorPronePlugins.length > 0) {
      recommendations.push(
        `${errorPronePlugins.length} plugins have success rate < 95%. Improve error handling.`
      );
    }

    return recommendations;
  }

  /**
   * Update thresholds
   */
  public updateThresholds(newThresholds: Partial<PerformanceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...newThresholds };
  }

  /**
   * Clear metrics
   */
  public clearMetrics(pluginId?: string): void {
    if (pluginId) {
      this.metrics.delete(pluginId);
      this.aggregatedMetrics.delete(pluginId);
    } else {
      this.metrics.clear();
      this.aggregatedMetrics.clear();
    }
  }

  /**
   * Export metrics for debugging
   */
  public exportMetrics(): {
    raw: Record<string, PerformanceMetrics[]>;
    aggregated: Record<string, AggregatedMetrics>;
    thresholds: PerformanceThresholds;
  } {
    return {
      raw: Object.fromEntries(this.metrics),
      aggregated: Object.fromEntries(this.aggregatedMetrics),
      thresholds: this.thresholds
    };
  }
}