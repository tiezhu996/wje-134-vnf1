import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CostItem } from '../models/costItem.entity';
import { AuditAction, BudgetStatus, CostCategory, CostItemStatus } from '../types/enums';
import { RequestContext } from '../types/interfaces';
import { calculateVarianceAmount, toMoney } from '../utils/calculator';
import { isUniqueViolation } from '../utils/pgError';
import { AuditLogService } from './auditLog.service';
import { BudgetService } from './budget.service';
import { RedisService } from './redis.service';
import { logger } from '../utils/logger';

export interface CreateCostItemInput {
  budgetId: string;
  category: CostCategory;
  costName: string;
  budgetAmount: number;
  actualAmount: number;
  occurredAt: string;
  voucherNo: string;
  materialUsageId?: string;
  laborTimeRecordId?: string;
}

const VOUCHER_NO_MAX_LENGTH = 80;
const REVERSAL_VOUCHER_PREFIX = 'REV-';

@Injectable()
export class CostItemService {
  constructor(
    @InjectRepository(CostItem)
    private readonly costItemRepository: Repository<CostItem>,
    private readonly budgetService: BudgetService,
    private readonly auditLogService: AuditLogService,
    private readonly redisService: RedisService,
    private readonly dataSource: DataSource
  ) {}

  async list(budgetId?: string): Promise<CostItem[]> {
    return this.costItemRepository.find({
      where: budgetId ? { budgetId } : {},
      order: { occurredAt: 'DESC', createdAt: 'DESC' }
    });
  }

  async getById(id: string): Promise<CostItem> {
    const costItem = await this.costItemRepository.findOne({ where: { id } });
    if (!costItem) {
      throw new NotFoundException('成本项不存在');
    }

    return costItem;
  }

  async create(input: CreateCostItemInput, context: RequestContext): Promise<CostItem> {
    const voucherNo = input.voucherNo.trim();

    const saved = await this.dataSource.transaction(async (manager) => {
      const budget = await this.budgetService.getByIdForUpdate(input.budgetId, manager);
      if (budget.status !== BudgetStatus.Approved) {
        throw new BadRequestException('只能在已审批预算下录入成本');
      }

      // 事务内先核对项目内凭证号，锁预算保证同预算并发串行；
      // 跨预算的并发由 uq_cost_items_project_voucher 唯一索引兜底。
      const duplicated = await manager.findOne(CostItem, {
        where: { projectId: budget.projectId, voucherNo }
      });
      if (duplicated) {
        throw new ConflictException('同一项目下凭证号已存在，请勿重复提交该凭证');
      }

      const costItem = manager.create(CostItem, {
        budgetId: input.budgetId,
        projectId: budget.projectId,
        category: input.category,
        costName: input.costName,
        budgetAmount: toMoney(input.budgetAmount),
        actualAmount: toMoney(input.actualAmount),
        varianceAmount: calculateVarianceAmount(input.budgetAmount, input.actualAmount),
        occurredAt: input.occurredAt,
        voucherNo,
        materialUsageId: input.materialUsageId ?? null,
        laborTimeRecordId: input.laborTimeRecordId ?? null,
        status: CostItemStatus.Normal,
        reversalOfId: null,
        reversalReason: null
      });

      try {
        const created = await manager.save(costItem);
        // 持有预算行锁期间重算已用金额，与并发录入/冲销串行化
        await this.budgetService.recalculateUsedAmount(input.budgetId, manager);
        return created;
      } catch (error) {
        // 本插入唯一可能违反的唯一约束就是项目内凭证号（真实 pg 驱动会带 constraint，
        // 个别驱动版本不带，故 23505 一律按重复凭证处理）
        if (isUniqueViolation(error)) {
          throw new ConflictException('同一项目下凭证号已存在，请勿重复提交该凭证');
        }

        throw error;
      }
    });

    await this.invalidateProjectReports(saved.projectId);
    await this.writeAudit(AuditAction.CostItemCreated, saved, context, {
      varianceAmount: saved.varianceAmount
    });
    return saved;
  }

  /**
   * 针对原成本发起金额相反的冲销：生成一笔红字冲销记录并填写原因，
   * 原记录标记为 Reversed 但继续保留可查。重复或并发冲销只生效一次。
   */
  async reverse(id: string, reason: string, context: RequestContext): Promise<CostItem> {
    const reversalReason = reason.trim();

    const { reversal, original } = await this.dataSource.transaction(async (manager) => {
      const originalItem = await manager.findOne(CostItem, { where: { id } });
      if (!originalItem) {
        throw new NotFoundException('成本项不存在');
      }

      if (originalItem.reversalOfId) {
        throw new BadRequestException('冲销记录不能再次冲销');
      }

      if (originalItem.status === CostItemStatus.Reversed) {
        throw new ConflictException('该成本项已冲销，请勿重复冲销');
      }

      const budget = await this.budgetService.getByIdForUpdate(originalItem.budgetId, manager);

      const reversalItem = manager.create(CostItem, {
        budgetId: originalItem.budgetId,
        projectId: budget.projectId,
        category: originalItem.category,
        costName: this.buildReversalCostName(originalItem.costName),
        budgetAmount: toMoney(0),
        actualAmount: toMoney(-Number(originalItem.actualAmount)),
        varianceAmount: calculateVarianceAmount(0, -Number(originalItem.actualAmount)),
        occurredAt: new Date().toISOString().slice(0, 10),
        voucherNo: this.buildReversalVoucherNo(originalItem.voucherNo),
        materialUsageId: originalItem.materialUsageId ?? null,
        laborTimeRecordId: originalItem.laborTimeRecordId ?? null,
        status: CostItemStatus.Reversed,
        reversalOfId: originalItem.id,
        reversalReason
      });

      originalItem.status = CostItemStatus.Reversed;

      try {
        const savedReversal = await manager.save(reversalItem);
        await manager.save(originalItem);
        // 持有预算行锁期间重算已用金额，与并发录入/冲销串行化
        await this.budgetService.recalculateUsedAmount(originalItem.budgetId, manager);
        return { reversal: savedReversal, original: originalItem };
      } catch (error) {
        // 冲销插入唯一可能违反的唯一约束是 reversal_of_id 的部分唯一索引，
        // 说明并发下已有另一笔冲销先提交（23505 一律按重复冲销处理）
        if (isUniqueViolation(error)) {
          throw new ConflictException('该成本项已冲销，请勿重复冲销');
        }

        throw error;
      }
    });

    await this.invalidateProjectReports(original.projectId);
    await this.writeAudit(AuditAction.CostItemReversed, reversal, context, {
      originalCostItemId: original.id,
      originalVoucherNo: original.voucherNo,
      reversalAmount: reversal.actualAmount,
      reason: reversalReason
    });
    return reversal;
  }

  async reviewVariance(id: string, context: RequestContext): Promise<CostItem> {
    const costItem = await this.getById(id);
    costItem.varianceAmount = calculateVarianceAmount(costItem.budgetAmount, costItem.actualAmount);
    costItem.status = CostItemStatus.VarianceReviewed;

    const saved = await this.costItemRepository.save(costItem);
    await this.writeAudit(AuditAction.CostItemReviewed, saved, context, {
      varianceAmount: saved.varianceAmount
    });
    return saved;
  }

  async markException(id: string, reason: string, context: RequestContext): Promise<CostItem> {
    const costItem = await this.getById(id);
    costItem.status = CostItemStatus.Exception;
    costItem.exceptionReason = reason;

    const saved = await this.costItemRepository.save(costItem);
    await this.writeAudit(AuditAction.CostItemMarkedException, saved, context, { reason });
    return saved;
  }

  private buildReversalVoucherNo(originalVoucherNo: string): string {
    const suffix = originalVoucherNo.slice(
      0,
      VOUCHER_NO_MAX_LENGTH - REVERSAL_VOUCHER_PREFIX.length
    );
    return `${REVERSAL_VOUCHER_PREFIX}${suffix}`;
  }

  private buildReversalCostName(originalCostName: string): string {
    const prefix = '冲销：';
    return `${prefix}${originalCostName.slice(0, 180 - prefix.length)}`;
  }

  /**
   * 成本数据变化后失效该项目的报告缓存，保证期末重新生成的报告反映冲销后净额。
   */
  private async invalidateProjectReports(projectId: string): Promise<void> {
    try {
      await this.redisService.deleteByPattern(`reports:${projectId}:*`);
    } catch (error) {
      logger.warn('invalidate report cache failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async writeAudit(
    action: AuditAction,
    costItem: CostItem,
    context: RequestContext,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.auditLogService.write({
      action,
      entityType: 'CostItem',
      entityId: costItem.id,
      user: context.user,
      requestId: context.requestId,
      ipAddress: context.ip,
      metadata
    });
  }
}
