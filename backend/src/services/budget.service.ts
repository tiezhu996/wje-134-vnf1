import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ProjectBudget } from '../models/budget.entity';
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

  async lockById(id: string, manager: EntityManager): Promise<ProjectBudget> {
    // 行级锁串行化同一预算下的成本写入，配合唯一索引防止并发重复提交
    const budget = await manager.findOne(ProjectBudget, {
      where: { id },
      lock: { mode: 'pessimistic_write' }
    });

    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }

    return budget;
  }

  async recalculateUsedAmount(id: string, manager?: EntityManager): Promise<ProjectBudget> {
    const managerOrRepo = manager ?? this.budgetRepository.manager;

    // 已用额按未冲销的实际金额合计：已冲销原始凭证与冲销凭证本身均计 0
    await managerOrRepo
      .createQueryBuilder()
      .update(ProjectBudget)
      .set({
        usedAmount: () =>
          `(SELECT COALESCE(SUM(ci.actual_amount), 0)
              FROM cost_items ci
             WHERE ci.budget_id = :id
               AND ci.status != :reversedStatus
               AND ci.reversal_of_id IS NULL)`
      })
      .where('id = :id', { id, reversedStatus: CostItemStatus.Reversed })
      .execute();

    return managerOrRepo.findOneOrFail(ProjectBudget, { where: { id } });
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
