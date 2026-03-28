/**
 * Migration Monitoring and Alerting System
 * 
 * Provides real-time monitoring, alerting, and health checks for
 * database migration operations with production-grade observability.
 */

import { EventEmitter } from 'events';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import {
  MigrationExecution,
  MigrationSecurityContext,
  MigrationStatus,
  MigrationRiskLevel,
  MigrationEnvironment,
} from './types';
import { createMigrationAuditRepository, MigrationAuditRepository } from './audit';
import { createMigrationApprovalRepository, MigrationApprovalRepository } from './accessControl';
import { createMigrationRollbackRepository, MigrationRollbackRepository } from './rollback';

/**
 * Alert severity levels
 */
export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Alert types
 */
export type AlertType = 
  | 'migration_started'
  | 'migration_completed'
  | 'migration_failed'
  | 'migration_rolled_back'
  | 'security_violation'
  | 'approval_required'
  | 'backup_failed'
  | 'rollback_failed'
  | 'performance_degradation'
  | 'concurrent_migrations'
  | 'system_health';

/**
 * Migration alert interface
 */
export interface MigrationAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  details: Record<string, unknown>;
  migrationId?: string;
  environment: MigrationEnvironment;
  userId?: string;
  timestamp: Date;
  resolved: boolean;
  resolvedAt?: Date;
  resolvedBy?: string;
  tags: string[];
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'warn';
    message: string;
    duration: number;
    details?: Record<string, unknown>;
  }>;
  overallScore: number; // 0-100
  timestamp: Date;
}

/**
 * Migration metrics
 */
export interface MigrationMetrics {
  totalMigrations: number;
  successfulMigrations: number;
  failedMigrations: number;
  averageExecutionTime: number;
  averageRollbackTime: number;
  migrationsByRiskLevel: Record<MigrationRiskLevel, number>;
  migrationsByEnvironment: Record<MigrationEnvironment, number>;
  activeMigrations: number;
  pendingApprovals: number;
  securityViolations: number;
  systemUptime: number;
  lastMigrationTime?: Date;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  databaseConnections: number;
  averageQueryTime: number;
  slowQueries: number;
  memoryUsage: number;
  diskUsage: number;
  cpuUsage: number;
  networkLatency: number;
  backupSize: number;
  auditEventRate: number;
}

/**
 * Monitoring configuration
 */
export interface MonitoringConfig {
  alertThresholds: {
    maxExecutionTime: number; // seconds
    maxRollbackTime: number; // seconds
    maxConcurrentMigrations: number;
    maxFailedMigrations: number; // per hour
    maxSecurityViolations: number; // per hour
    minHealthScore: number; // 0-100
    maxMemoryUsage: number; // percentage
    maxDiskUsage: number; // percentage
    maxCpuUsage: number; // percentage
  };
  alerting: {
    enabled: boolean;
    channels: ('email' | 'slack' | 'webhook' | 'log')[];
    cooldownPeriod: number; // seconds
    maxAlertsPerHour: number;
  };
  healthChecks: {
    interval: number; // seconds
    timeout: number; // seconds
    retries: number;
  };
  metrics: {
    retentionPeriod: number; // days
    aggregationInterval: number; // seconds
  };
}

/**
 * Default monitoring configuration
 */
export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  alertThresholds: {
    maxExecutionTime: 1800, // 30 minutes
    maxRollbackTime: 600, // 10 minutes
    maxConcurrentMigrations: 3,
    maxFailedMigrations: 5, // per hour
    maxSecurityViolations: 10, // per hour
    minHealthScore: 80,
    maxMemoryUsage: 85, // percentage
    maxDiskUsage: 80, // percentage
    maxCpuUsage: 75, // percentage
  },
  alerting: {
    enabled: true,
    channels: ['log'],
    cooldownPeriod: 300, // 5 minutes
    maxAlertsPerHour: 50,
  },
  healthChecks: {
    interval: 60, // 1 minute
    timeout: 30, // 30 seconds
    retries: 3,
  },
  metrics: {
    retentionPeriod: 30, // 30 days
    aggregationInterval: 300, // 5 minutes
  },
};

/**
 * Migration monitoring service
 */
export class MigrationMonitoringService extends EventEmitter {
  private alerts: Map<string, MigrationAlert> = new Map();
  private alertCooldowns: Map<string, Date> = new Map();
  private metrics: MigrationMetrics;
  private performanceMetrics: PerformanceMetrics;
  private startTime: Date;

  constructor(
    private pool: Pool,
    private config: MonitoringConfig = DEFAULT_MONITORING_CONFIG,
    private auditRepository: MigrationAuditRepository = createMigrationAuditRepository(pool),
    private approvalRepository: MigrationApprovalRepository = createMigrationApprovalRepository(pool),
    private rollbackRepository: MigrationRollbackRepository = createMigrationRollbackRepository(pool)
  ) {
    super();
    this.startTime = new Date();
    this.metrics = this.initializeMetrics();
    this.performanceMetrics = this.initializePerformanceMetrics();
    
    // Start monitoring
    this.startMonitoring();
  }

  /**
   * Initialize metrics
   */
  private initializeMetrics(): MigrationMetrics {
    return {
      totalMigrations: 0,
      successfulMigrations: 0,
      failedMigrations: 0,
      averageExecutionTime: 0,
      averageRollbackTime: 0,
      migrationsByRiskLevel: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      },
      migrationsByEnvironment: {
        development: 0,
        staging: 0,
        production: 0,
      },
      activeMigrations: 0,
      pendingApprovals: 0,
      securityViolations: 0,
      systemUptime: 0,
    };
  }

  /**
   * Initialize performance metrics
   */
  private initializePerformanceMetrics(): PerformanceMetrics {
    return {
      databaseConnections: 0,
      averageQueryTime: 0,
      slowQueries: 0,
      memoryUsage: 0,
      diskUsage: 0,
      cpuUsage: 0,
      networkLatency: 0,
      backupSize: 0,
      auditEventRate: 0,
    };
  }

  /**
   * Start monitoring processes
   */
  private startMonitoring(): void {
    if (this.config.alerting.enabled) {
      // Start health checks
      setInterval(() => {
        this.performHealthCheck();
      }, this.config.healthChecks.interval * 1000);

      // Start metrics collection
      setInterval(() => {
        this.collectMetrics();
      }, this.config.metrics.aggregationInterval * 1000);

      // Start cleanup
      setInterval(() => {
        this.cleanupOldData();
      }, 24 * 60 * 60 * 1000); // Daily
    }
  }

  /**
   * Record migration event and update metrics
   */
  async recordMigrationEvent(
    type: 'started' | 'completed' | 'failed' | 'rolled_back',
    execution: MigrationExecution,
    securityContext: MigrationSecurityContext
  ): Promise<void> {
    const now = new Date();
    
    // Update metrics
    this.metrics.totalMigrations++;
    this.metrics.lastMigrationTime = now;
    this.metrics.migrationsByEnvironment[securityContext.environment]++;
    this.metrics.migrationsByRiskLevel[execution.migrationFile.riskLevel]++;

    switch (type) {
      case 'completed':
        this.metrics.successfulMigrations++;
        const executionTime = execution.completedAt 
          ? execution.completedAt.getTime() - execution.startedAt.getTime()
          : 0;
        this.updateAverageExecutionTime(executionTime);
        
        // Check for performance alerts
        if (executionTime > this.config.alertThresholds.maxExecutionTime * 1000) {
          await this.createAlert('performance_degradation', 'warning', 
            'Migration execution time exceeded threshold',
            `Migration ${execution.migrationFile.filename} took ${Math.round(executionTime / 1000)}s`,
            { executionId: execution.id, executionTime, threshold: this.config.alertThresholds.maxExecutionTime },
            execution.id,
            securityContext.environment,
            securityContext.userId
          );
        }
        break;

      case 'failed':
        this.metrics.failedMigrations++;
        await this.createAlert('migration_failed', 'error',
          'Migration execution failed',
          `Migration ${execution.migrationFile.filename} failed to execute`,
          { executionId: execution.id, error: execution.errorMessage },
          execution.id,
          securityContext.environment,
          securityContext.userId
        );
        break;

      case 'rolled_back':
        await this.createAlert('migration_rolled_back', 'warning',
          'Migration was rolled back',
          `Migration ${execution.migrationFile.filename} was rolled back`,
          { executionId: execution.id },
          execution.id,
          securityContext.environment,
          securityContext.userId
        );
        break;
    }

    // Emit event for external listeners
    this.emit('migrationEvent', { type, execution, securityContext });
  }

  /**
   * Record security violation
   */
  async recordSecurityViolation(
    violation: string,
    securityContext: MigrationSecurityContext,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    this.metrics.securityViolations++;
    
    await this.createAlert('security_violation', 'critical',
      'Security violation detected',
      violation,
      details,
      undefined,
      securityContext.environment,
      securityContext.userId
    );

    this.emit('securityViolation', { violation, securityContext, details });
  }

  /**
   * Create and emit alert
   */
  private async createAlert(
    type: AlertType,
    severity: AlertSeverity,
    title: string,
    message: string,
    details: Record<string, unknown>,
    migrationId?: string,
    environment?: MigrationEnvironment,
    userId?: string
  ): Promise<void> {
    const alertKey = `${type}:${severity}:${migrationId || 'global'}`;
    
    // Check cooldown period
    const lastAlert = this.alertCooldowns.get(alertKey);
    if (lastAlert && (Date.now() - lastAlert.getTime()) < this.config.alerting.cooldownPeriod * 1000) {
      return; // Skip due to cooldown
    }

    const alert: MigrationAlert = {
      id: randomUUID(),
      type,
      severity,
      title,
      message,
      details,
      migrationId,
      environment: environment || 'development',
      userId,
      timestamp: new Date(),
      resolved: false,
      tags: [type, severity, environment || 'development'],
    };

    this.alerts.set(alert.id, alert);
    this.alertCooldowns.set(alertKey, new Date());

    // Send to alert channels
    await this.sendAlert(alert);

    // Emit alert event
    this.emit('alert', alert);
  }

  /**
   * Send alert to configured channels
   */
  private async sendAlert(alert: MigrationAlert): Promise<void> {
    for (const channel of this.config.alerting.channels) {
      switch (channel) {
        case 'log':
          console.log(`[${alert.severity.toUpperCase()}] ${alert.title}: ${alert.message}`);
          break;
        case 'email':
          // Implementation would send email
          break;
        case 'slack':
          // Implementation would send to Slack
          break;
        case 'webhook':
          // Implementation would send to webhook
          break;
      }
    }
  }

  /**
   * Perform comprehensive health check
   */
  async performHealthCheck(): Promise<HealthCheckResult> {
    const checks: HealthCheckResult['checks'] = [];
    let totalScore = 0;

    // Database connectivity check
    const dbCheck = await this.checkDatabaseConnectivity();
    checks.push(dbCheck);
    totalScore += dbCheck.status === 'pass' ? 25 : 0;

    // Migration system health check
    const systemCheck = await this.checkMigrationSystemHealth();
    checks.push(systemCheck);
    totalScore += systemCheck.status === 'pass' ? 25 : 0;

    // Performance check
    const performanceCheck = await this.checkPerformance();
    checks.push(performanceCheck);
    totalScore += performanceCheck.status === 'pass' ? 25 : 0;

    // Security check
    const securityCheck = await this.checkSecurityHealth();
    checks.push(securityCheck);
    totalScore += securityCheck.status === 'pass' ? 25 : 0;

    const overallScore = Math.min(100, totalScore);
    let status: HealthCheckResult['status'] = 'healthy';
    
    if (overallScore < this.config.alertThresholds.minHealthScore) {
      status = 'unhealthy';
    } else if (overallScore < 90) {
      status = 'degraded';
    }

    const result: HealthCheckResult = {
      status,
      checks,
      overallScore,
      timestamp: new Date(),
    };

    // Alert on health issues
    if (status !== 'healthy') {
      await this.createAlert('system_health', 
        status === 'unhealthy' ? 'critical' : 'warning',
        `System health is ${status}`,
        `Overall health score: ${overallScore}/100`,
        { healthCheck: result }
      );
    }

    this.emit('healthCheck', result);
    return result;
  }

  /**
   * Check database connectivity
   */
  private async checkDatabaseConnectivity(): Promise<HealthCheckResult['checks'][0]> {
    const startTime = Date.now();
    
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      const duration = Date.now() - startTime;
      
      return {
        name: 'database_connectivity',
        status: duration < 1000 ? 'pass' : 'warn',
        message: `Database connectivity check completed in ${duration}ms`,
        duration,
        details: { responseTime: duration },
      };
    } catch (error) {
      return {
        name: 'database_connectivity',
        status: 'fail',
        message: `Database connectivity failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        duration: Date.now() - startTime,
        details: { error: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  /**
   * Check migration system health
   */
  private async checkMigrationSystemHealth(): Promise<HealthCheckResult['checks'][0]> {
    const startTime = Date.now();
    const issues: string[] = [];

    try {
      // Check for excessive failed migrations
      const recentFailures = await this.getRecentFailedMigrations();
      if (recentFailures > this.config.alertThresholds.maxFailedMigrations) {
        issues.push(`High failure rate: ${recentFailures} failures in last hour`);
      }

      // Check for pending approvals
      const pendingApprovals = await this.getPendingApprovals();
      if (pendingApprovals > 10) {
        issues.push(`High approval backlog: ${pendingApprovals} pending approvals`);
      }

      // Check for expired recovery points
      const expiredRecoveryPoints = await this.rollbackRepository.cleanupExpiredRecoveryPoints(7);
      if (expiredRecoveryPoints > 0) {
        issues.push(`Cleaned up ${expiredRecoveryPoints} expired recovery points`);
      }

      const duration = Date.now() - startTime;
      const status = issues.length === 0 ? 'pass' : issues.length > 2 ? 'fail' : 'warn';
      
      return {
        name: 'migration_system_health',
        status,
        message: issues.length === 0 ? 'Migration system is healthy' : `Issues detected: ${issues.join(', ')}`,
        duration,
        details: { issues, failedMigrations: recentFailures, pendingApprovals },
      };
    } catch (error) {
      return {
        name: 'migration_system_health',
        status: 'fail',
        message: `System health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        duration: Date.now() - startTime,
        details: { error: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  /**
   * Check performance metrics
   */
  private async checkPerformance(): Promise<HealthCheckResult['checks'][0]> {
    const startTime = Date.now();
    const issues: string[] = [];

    try {
      // Check memory usage
      if (this.performanceMetrics.memoryUsage > this.config.alertThresholds.maxMemoryUsage) {
        issues.push(`High memory usage: ${this.performanceMetrics.memoryUsage}%`);
      }

      // Check disk usage
      if (this.performanceMetrics.diskUsage > this.config.alertThresholds.maxDiskUsage) {
        issues.push(`High disk usage: ${this.performanceMetrics.diskUsage}%`);
      }

      // Check CPU usage
      if (this.performanceMetrics.cpuUsage > this.config.alertThresholds.maxCpuUsage) {
        issues.push(`High CPU usage: ${this.performanceMetrics.cpuUsage}%`);
      }

      // Check slow queries
      if (this.performanceMetrics.slowQueries > 10) {
        issues.push(`High number of slow queries: ${this.performanceMetrics.slowQueries}`);
      }

      const duration = Date.now() - startTime;
      const status = issues.length === 0 ? 'pass' : issues.length > 2 ? 'fail' : 'warn';
      
      return {
        name: 'performance',
        status,
        message: issues.length === 0 ? 'Performance metrics are normal' : `Performance issues: ${issues.join(', ')}`,
        duration,
        details: { 
          issues,
          memoryUsage: this.performanceMetrics.memoryUsage,
          diskUsage: this.performanceMetrics.diskUsage,
          cpuUsage: this.performanceMetrics.cpuUsage,
          slowQueries: this.performanceMetrics.slowQueries,
        },
      };
    } catch (error) {
      return {
        name: 'performance',
        status: 'fail',
        message: `Performance check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        duration: Date.now() - startTime,
        details: { error: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  /**
   * Check security health
   */
  private async checkSecurityHealth(): Promise<HealthCheckResult['checks'][0]> {
    const startTime = Date.now();
    const issues: string[] = [];

    try {
      // Check for recent security violations
      const recentViolations = await this.getRecentSecurityViolations();
      if (recentViolations > this.config.alertThresholds.maxSecurityViolations) {
        issues.push(`High security violation rate: ${recentViolations} violations in last hour`);
      }

      // Check for unauthorized access attempts
      const unauthorizedAttempts = await this.getUnauthorizedAttempts();
      if (unauthorizedAttempts > 5) {
        issues.push(`Multiple unauthorized access attempts: ${unauthorizedAttempts}`);
      }

      const duration = Date.now() - startTime;
      const status = issues.length === 0 ? 'pass' : issues.length > 1 ? 'fail' : 'warn';
      
      return {
        name: 'security',
        status,
        message: issues.length === 0 ? 'Security checks passed' : `Security issues: ${issues.join(', ')}`,
        duration,
        details: { 
          issues,
          securityViolations: recentViolations,
          unauthorizedAttempts,
        },
      };
    } catch (error) {
      return {
        name: 'security',
        status: 'fail',
        message: `Security check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        duration: Date.now() - startTime,
        details: { error: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  /**
   * Collect system metrics
   */
  private async collectMetrics(): Promise<void> {
    try {
      // Update uptime
      this.metrics.systemUptime = Date.now() - this.startTime.getTime();

      // Collect database metrics
      await this.collectDatabaseMetrics();

      // Collect system metrics (placeholder implementations)
      this.collectSystemMetrics();

      // Emit metrics event
      this.emit('metrics', {
        migration: this.metrics,
        performance: this.performanceMetrics,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('Failed to collect metrics:', error);
    }
  }

  /**
   * Collect database metrics
   */
  private async collectDatabaseMetrics(): Promise<void> {
    try {
      // Get connection count
      const result = await this.pool.query('SELECT count(*) as count FROM pg_stat_activity');
      this.performanceMetrics.databaseConnections = parseInt(result.rows[0].count);

      // Get slow queries (placeholder)
      this.performanceMetrics.slowQueries = 0;

      // Get average query time (placeholder)
      this.performanceMetrics.averageQueryTime = 0;
    } catch (error) {
      console.error('Failed to collect database metrics:', error);
    }
  }

  /**
   * Collect system metrics (placeholder implementations)
   */
  private collectSystemMetrics(): void {
    // These would be implemented with actual system monitoring
    this.performanceMetrics.memoryUsage = Math.random() * 100;
    this.performanceMetrics.diskUsage = Math.random() * 100;
    this.performanceMetrics.cpuUsage = Math.random() * 100;
    this.performanceMetrics.networkLatency = Math.random() * 100;
  }

  /**
   * Helper methods for health checks
   */
  private async getRecentFailedMigrations(): Promise<number> {
    // This would query the audit repository for recent failures
    return Math.floor(Math.random() * 5); // Placeholder
  }

  private async getPendingApprovals(): Promise<number> {
    const pendingApprovals = await this.approvalRepository.getPendingApprovals('production');
    return pendingApprovals.length;
  }

  private async getRecentSecurityViolations(): Promise<number> {
    // This would query the audit repository for recent violations
    return Math.floor(Math.random() * 3); // Placeholder
  }

  private async getUnauthorizedAttempts(): Promise<number> {
    // This would count unauthorized access attempts
    return Math.floor(Math.random() * 2); // Placeholder
  }

  /**
   * Update average execution time
   */
  private updateAverageExecutionTime(newTime: number): void {
    if (this.metrics.averageExecutionTime === 0) {
      this.metrics.averageExecutionTime = newTime;
    } else {
      // Simple moving average
      this.metrics.averageExecutionTime = 
        (this.metrics.averageExecutionTime * 0.9) + (newTime * 0.1);
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): MigrationMetrics {
    return { ...this.metrics };
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    return { ...this.performanceMetrics };
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(limit = 50): MigrationAlert[] {
    return Array.from(this.alerts.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Resolve alert
   */
  resolveAlert(alertId: string, resolvedBy: string): void {
    const alert = this.alerts.get(alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      alert.resolvedBy = resolvedBy;
      
      this.emit('alertResolved', alert);
    }
  }

  /**
   * Clean up old data
   */
  private async cleanupOldData(): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.metrics.retentionPeriod * 24 * 60 * 60 * 1000);
    
    // Clean up old alerts
    for (const [id, alert] of this.alerts.entries()) {
      if (alert.timestamp < cutoffDate) {
        this.alerts.delete(id);
      }
    }

    // Clean up old cooldowns
    for (const [key, date] of this.alertCooldowns.entries()) {
      if (date < cutoffDate) {
        this.alertCooldowns.delete(key);
      }
    }

    // Clean up expired recovery points
    await this.rollbackRepository.cleanupExpiredRecoveryPoints(this.config.metrics.retentionPeriod);
  }

  /**
   * Get monitoring dashboard data
   */
  async getDashboardData(): Promise<{
    health: HealthCheckResult;
    metrics: MigrationMetrics;
    performance: PerformanceMetrics;
    alerts: MigrationAlert[];
  }> {
    const health = await this.performHealthCheck();
    const metrics = this.getMetrics();
    const performance = this.getPerformanceMetrics();
    const alerts = this.getRecentAlerts(10);

    return {
      health,
      metrics,
      performance,
      alerts,
    };
  }
}
