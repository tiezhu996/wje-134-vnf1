import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { CostItem } from '../models/costItem.entity';
import { AuditAction, BudgetStatus, CostCategory, CostItemStatus } from '../types/enums';
import { RequestContext } from '../types/interfaces';
import { calculateVarianceAmount, toMoney } from '../utils/calculator';
import { AuditLogService } from './auditLog.service';
import { BudgetService } from './budget.service';
import { RedisService } from './redis.service';

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

export interface ReverseCostItemInput {
  reason: string;
}

// Postgres 唯一约束/索引冲突错误码
const UNIQUE_VIOLATION_CODE = '23505';

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

    // 同一项目（预算）内凭证号加预算行锁串行化，重复或并发请求只落一笔
    const result = await this.dataSource.transaction(async (manager) => {
      const budget = await this.budgetService.lockById(input.budgetId, manager);
      if (budget.status !== BudgetStatus.Approved) {
        throw new BadRequestException('只能在已审批预算下录入成本');
      }

      const existing = await manager.findOne(CostItem, {
        where: { budgetId: input.budgetId, voucherNo }
      });
      if (existing) {
        return { costItem: existing, created: false };
      }

      const costItem = manager.create(CostItem, {
        budgetId: input.budgetId,
        category: input.category,
        costName: input.costName,
        budgetAmount: toMoney(input.budgetAmount),
        actualAmount: toMoney(input.actualAmount),
        varianceAmount: calculateVarianceAmount(input.budgetAmount, input.actualAmount),
        occurredAt: input.occurredAt,
        voucherNo,
        materialUsageId: input.materialUsageId ?? null,
        laborTimeRecordId: input.laborTimeRecordId ?? null,
        status: CostItemStatus.Normal
      });

      try {
        const saved = await manager.save(costItem);
        await this.budgetService.recalculateUsedAmount(input.budgetId, manager);
        return { costItem: saved, created: true };
      } catch (error) {
        // 唯一索引兜底：极端并发下命中 (budget_id, voucher_no) 唯一约束时返回已存在的一笔
        if (this.isUniqueViolation(error)) {
          const concurrent = await manager.findOneOrFail(CostItem, {
            where: { budgetId: input.budgetId, voucherNo }
          });
          return { costItem: concurrent, created: false };
        }

        throw error;
      }
    });

    if (result.created) {
      await this.writeAudit(AuditAction.CostItemCreated, result.costItem, context, {
        varianceAmount: result.costItem.varianceAmount
      });
      await this.invalidateProjectReports(input.budgetId);
    }

    return result.costItem;
  }

  async reverse(id: string, input: ReverseCostItemInput, context: RequestContext): Promise<CostItem> {
    const reason = input.reason?.trim();
    if (!reason) {
      throw new BadRequestException('冲销原因不能为空');
    }

    const reversal = await this.dataSource.transaction(async (manager) => {
      // 先锁原成本行（并发冲销第二个请求会在此等待并看到已冲销状态），
      // 再锁预算行，与录入成本的重算串行化，避免并发录入/冲销丢失已用额更新
      const original = await manager.findOne(CostItem, {
        where: { id },
        lock: { mode: 'pessimistic_write' }
      });
      if (!original) {
        throw new NotFoundException('成本项不存在');
      }

      await this.budgetService.lockById(original.budgetId, manager);

      if (original.isReversal) {
        throw new BadRequestException('冲销凭证不能再次冲销');
      }
      if (original.status === CostItemStatus.Reversed) {
        throw new BadRequestException('该成本项已冲销，不能重复冲销');
      }

      const reversedAt = new Date();
      const reversalAmount = toMoney(-Number(original.actualAmount));

      const reversalItem = manager.create(CostItem, {
        budgetId: original.budgetId,
        category: original.category,
        costName: this.buildReversalName(original.costName),
        budgetAmount: toMoney(0),
        actualAmount: reversalAmount,
        varianceAmount: reversalAmount,
        occurredAt: reversedAt.toISOString().slice(0, 10),
        voucherNo: this.buildReversalVoucherNo(original.id),
        materialUsageId: null,
        laborTimeRecordId: null,
        status: CostItemStatus.Normal,
        reversalOfId: original.id,
        reversalReason: reason
      });

      let savedReversal: CostItem;
      try {
        savedReversal = await manager.save(reversalItem);
      } catch (error) {
        // reversal_of_id / 凭证号唯一约束兜底，保证并发或重复冲销只生效一次
        if (this.isUniqueViolation(error)) {
          throw new BadRequestException('该成本项已冲销，不能重复冲销');
        }

        throw error;
      }

      original.status = CostItemStatus.Reversed;
      original.reversedAt = reversedAt;
      original.reversalReason = reason;
      await manager.save(original);

      await this.budgetService.recalculateUsedAmount(original.budgetId, manager);
      return { original, reversal: savedReversal };
    });

    await this.writeAudit(AuditAction.CostItemReversed, reversal.original, context, {
      reversalId: reversal.reversal.id,
      reversalVoucherNo: reversal.reversal.voucherNo,
      reason
    });
    await this.invalidateProjectReports(reversal.reversal.budgetId);

    return reversal.reversal;
  }

  async reviewVariance(id: string, context: RequestContext): Promise<CostItem> {
    const costItem = await this.getById(id);
    this.ensureNotReversed(costItem);
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
    this.ensureNotReversed(costItem);
    costItem.status = CostItemStatus.Exception;
    costItem.exceptionReason = reason;

    const saved = await this.costItemRepository.save(costItem);
    await this.writeAudit(AuditAction.CostItemMarkedException, saved, context, { reason });
    return saved;
  }

  private ensureNotReversed(costItem: CostItem): void {
    if (costItem.isReversal) {
      throw new BadRequestException('冲销凭证不支持该操作');
    }
    if (costItem.status === CostItemStatus.Reversed) {
      throw new BadRequestException('已冲销成本项不支持该操作');
    }
  }

  private buildReversalVoucherNo(originalId: string): string {
    return `REV-${originalId}`;
  }

  private buildReversalName(originalName: string): string {
    const suffix = '（冲销）';
    const base = originalName.length > 180 - suffix.length ? originalName.slice(0, 180 - suffix.length) : originalName;
    return `${base}${suffix}`;
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof QueryFailedError && error.driverError?.code === UNIQUE_VIOLATION_CODE;
  }

  private async invalidateProjectReports(budgetId: string): Promise<void> {
    const budget = await this.budgetService.getById(budgetId);
    await this.redisService.deleteByPattern(`reports:${budget.projectId}:*`);
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
