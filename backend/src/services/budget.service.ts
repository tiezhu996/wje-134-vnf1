import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ProjectBudget } from '../models/budget.entity';
import { CostItem } from '../models/costItem.entity';
import { AuditAction, BudgetStatus, CostItemStatus, Currency } from '../types/enums';
import { AuthenticatedUser, RequestContext } from '../types/interfaces';
import { toMoney } from '../utils/calculator';
import { AuditLogService } from './auditLog.service';

export interface CreateBudgetInput {
  projectId: string;
  budgetName: string;
  totalAmount: number;
  reservedAmount?: number;
  currency?: Currency;
  remark?: string;
}

export interface ReviewBudgetInput {
  approved: boolean;
  remark?: string;
}

@Injectable()
export class BudgetService {
  constructor(
    @InjectRepository(ProjectBudget)
    private readonly budgetRepository: Repository<ProjectBudget>,
    private readonly auditLogService: AuditLogService
  ) {}

  async list(projectId?: string): Promise<ProjectBudget[]> {
    return this.budgetRepository.find({
      where: projectId ? { projectId } : {},
      relations: ['costItems'],
      order: { createdAt: 'DESC' }
    });
  }

  async getById(id: string): Promise<ProjectBudget> {
    const budget = await this.budgetRepository.findOne({
      where: { id },
      relations: ['costItems']
    });

    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }

    return budget;
  }

  async create(input: CreateBudgetInput, context: RequestContext): Promise<ProjectBudget> {
    const budget = this.budgetRepository.create({
      projectId: input.projectId,
      budgetName: input.budgetName,
      totalAmount: toMoney(input.totalAmount),
      usedAmount: toMoney(0),
      reservedAmount: toMoney(input.reservedAmount ?? 0),
      currency: input.currency ?? Currency.CNY,
      status: BudgetStatus.Draft,
      remark: input.remark ?? null
    });

    const saved = await this.budgetRepository.save(budget);
    await this.writeAudit(AuditAction.BudgetCreated, saved, context, { totalAmount: saved.totalAmount });
    return saved;
  }

  async submit(id: string, context: RequestContext): Promise<ProjectBudget> {
    const budget = await this.getById(id);
    if (budget.status !== BudgetStatus.Draft && budget.status !== BudgetStatus.Rejected) {
      throw new BadRequestException('只有草稿或已驳回预算可以提交审批');
    }

    budget.status = BudgetStatus.Submitted;
    const saved = await this.budgetRepository.save(budget);
    await this.writeAudit(AuditAction.BudgetSubmitted, saved, context);
    return saved;
  }

  async review(id: string, input: ReviewBudgetInput, reviewer: AuthenticatedUser, context: RequestContext): Promise<ProjectBudget> {
    const budget = await this.getById(id);
    if (budget.status !== BudgetStatus.Submitted) {
      throw new BadRequestException('只有已提交预算可以审批');
    }

    budget.status = input.approved ? BudgetStatus.Approved : BudgetStatus.Rejected;
    budget.approverId = reviewer.id;
    budget.approvedAt = new Date();
    budget.remark = input.remark ?? budget.remark;

    const saved = await this.budgetRepository.save(budget);
    await this.writeAudit(input.approved ? AuditAction.BudgetApproved : AuditAction.BudgetRejected, saved, context, {
      approverId: reviewer.id,
      remark: input.remark
    });
    return saved;
  }

  /**
   * 在事务内锁定预算行，保证同一预算上的成本录入/冲销串行化，
   * 避免并发请求同时重算已用金额导致的丢失更新。
   */
  async getByIdForUpdate(id: string, manager: EntityManager): Promise<ProjectBudget> {
    const budget = await manager.findOne(ProjectBudget, {
      where: { id },
      lock: { mode: 'pessimistic_write' }
    });

    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }

    return budget;
  }

  /**
   * 重算预算已用金额：仅统计未被冲销的原始成本项。
   * 冲销记录（reversal_of_id 非空）与已冲销原始记录（status=Reversed）均不计入。
   */
  async recalculateUsedAmount(id: string, manager?: EntityManager): Promise<ProjectBudget> {
    const runner = manager ?? this.budgetRepository.manager;

    const row = await runner
      .createQueryBuilder()
      .select('COALESCE(SUM(ci.actual_amount), 0)', 'usedAmount')
      .from(CostItem, 'ci')
      .where('ci.budget_id = :budgetId', { budgetId: id })
      .andWhere("COALESCE(ci.reversal_of_id::text, '') = ''")
      .andWhere('ci.status::text != :reversedStatus', { reversedStatus: CostItemStatus.Reversed })
      .getRawOne<{ usedAmount: string }>();

    const budget = await runner.findOneBy(ProjectBudget, { id });
    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }

    budget.usedAmount = toMoney(row?.usedAmount ?? 0);
    return runner.save(budget);
  }

  private async writeAudit(
    action: AuditAction,
    budget: ProjectBudget,
    context: RequestContext,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.auditLogService.write({
      action,
      entityType: 'ProjectBudget',
      entityId: budget.id,
      user: context.user,
      requestId: context.requestId,
      ipAddress: context.ip,
      metadata
    });
  }
}
