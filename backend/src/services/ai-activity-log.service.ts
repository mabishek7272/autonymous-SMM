import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { AiActivityStatus, Prisma } from '@prisma/client';

/** ai_activity_log.target_id is VarChar(64): a free-form identifier (uuid, phone, call id...), not necessarily a UUID. */
export const TARGET_ID_MAX_LENGTH = 64;

export interface LogEntry {
  agentId: string;
  targetId?: string;
  actionType: string;
  payload?: Record<string, unknown>;
  status: 'success' | 'failure' | 'pending';
}

/**
 * Service for logging AI agent activities to the ai_activity_log table.
 * Per Security_Plan.md §5.1: every agent action must be logged with agent ID,
 * tool called, parameters, result, and timestamp.
 */
export const aiActivityLogService = {
  /** Returns true when the row was written; failures are logged at error level and never thrown. */
  async log(entry: LogEntry): Promise<boolean> {
    try {
      let targetId = entry.targetId ?? null;
      if (targetId !== null && targetId.length > TARGET_ID_MAX_LENGTH) {
        logger.error('AI activity log targetId exceeds column length and was truncated', {
          agentId: entry.agentId, actionType: entry.actionType, length: targetId.length,
        });
        targetId = targetId.slice(0, TARGET_ID_MAX_LENGTH);
      }
      await prisma.aiActivityLog.create({
        data: {
          agentId: entry.agentId,
          targetId,
          actionType: entry.actionType,
          payload: (entry.payload as object) ?? Prisma.JsonNull,
          status: entry.status as AiActivityStatus,
        },
      });
      return true;
    } catch (error) {
      // Don't let logging failures crash the main operation, but never hide them
      logger.error('Failed to write AI activity log', {
        message: error instanceof Error ? error.message : String(error),
        agentId: entry.agentId,
        actionType: entry.actionType,
        targetId: entry.targetId,
        status: entry.status,
      });
      return false;
    }
  },

  async getByAgent(agentId: string, limit = 50) {
    return prisma.aiActivityLog.findMany({
      where: { agentId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  },

  async getByTarget(targetId: string, limit = 50) {
    return prisma.aiActivityLog.findMany({
      where: { targetId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  },

  async getRecent(limit = 100) {
    return prisma.aiActivityLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  },
};
