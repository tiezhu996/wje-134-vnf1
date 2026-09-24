/* eslint-disable no-console */
import { randomUUID } from 'crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { newDb } from 'pg-mem';
import { ProjectBudget } from '../src/models/budget.entity';
import { CostItem } from '../src/models/costItem.entity';
import { AuditLog } from '../src/models/auditLog.entity';
import { Role } from '../src/models/role.entity';
import { CostReport } from '../src/models/costReport.entity';
import { ChangeOrder } from '../src/models/changeOrder.entity';
import { CostItemService } from '../src/services/costItem.service';
import { BudgetService } from '../src/services/budget.service';
import { AuditLogService } from '../src/services/auditLog.service';
import { AnalyticsService } from '../src/services/analytics.service';
import { RedisService } from '../src/services/redis.service';
import { BudgetStatus, CostCategory, CostItemStatus, Currency, UserRole } from '../src/types/enums';
import { RequestContext } from '../src/types/interfaces';

const ctx: RequestContext = {
  requestId: 'test-req',
  ip: '127.0.0.1',
  user: { id: '11111111-1111-4111-8111-111111111111', role: UserRole.Accountant, name: 'tester' }
};

let passed = 0;
function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`PASS: ${message}`);
  }
}

class StubRedis {
  invalidatedPatterns: string[] = [];
  async deleteByPattern(pattern: string): Promise<number> {
    this.invalidatedPatterns.push(pattern);
    return 0;
  }
}

async function expectConflict(promise: Promise<unknown>, message: string): Promise<void> {
  let status: number | undefined;
  try {
    await promise;
  } catch (error) {
    status = (error as { status?: number }).status;
  }
  assert(status === 409, message);
}

async function expectBadRequest(promise: Promise<unknown>, message: string): Promise<void> {
  let status: number | undefined;
  try {
    await promise;
  } catch (error) {
    status = (error as { status?: number }).status;
  }
  assert(status === 400, message);
}

async function main(): Promise<void> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'version',
    returns: 'text' as never,
    implementation: () => 'PostgreSQL 15.0 (pg-mem)'
  });
  db.public.registerFunction({
    name: 'current_database',
    returns: 'text' as never,
    implementation: () => 'cost_control_test'
  });
  db.public.registerFunction({
    name: 'current_schema',
    returns: 'text' as never,
    implementation: () => 'public'
  });
  db.public.registerFunction({
    name: 'uuid_generate_v4',
    returns: 'uuid' as never,
    impure: true,
    implementation: () => randomUUID()
  });
  const dataSource: DataSource = await db.adapters.createTypeormDataSource({
    type: 'postgres',
    entities: [ProjectBudget, CostItem, AuditLog, Role, CostReport, ChangeOrder],
    synchronize: true
  });
  await dataSource.initialize();

  const budgetRepo = dataSource.getRepository(ProjectBudget);
  const costItemRepo = dataSource.getRepository(CostItem);

  const projectA = 'aaaaaaaa-0000-4000-8000-000000000001';
  const projectB = 'bbbbbbbb-0000-4000-8000-000000000002';
  const budgetA1 = 'aaaaaaaa-0000-4000-8000-000000000011';
  const budgetA2 = 'aaaaaaaa-0000-4000-8000-000000000012';
  const budgetB1 = 'bbbbbbbb-0000-4000-8000-000000000021';

  async function makeBudget(id: string, projectId: string): Promise<void> {
    await budgetRepo.save(
      budgetRepo.create({
        id,
        projectId,
        budgetName: `budget-${id}`,
        totalAmount: '1000000.00',
        usedAmount: '0.00',
        reservedAmount: '0.00',
        currency: Currency.CNY,
        status: BudgetStatus.Approved
      })
    );
  }

  await makeBudget(budgetA1, projectA);
  await makeBudget(budgetA2, projectA);
  await makeBudget(budgetB1, projectB);

  const auditLogService = new AuditLogService(dataSource.getRepository(AuditLog));
  const redisService = new StubRedis() as unknown as RedisService;
  const budgetService = new BudgetService(budgetRepo, auditLogService);
  const costItemService = new CostItemService(
    costItemRepo,
    budgetService,
    auditLogService,
    redisService,
    dataSource
  );
  const analyticsService = new AnalyticsService();

  const baseInput = {
    category: CostCategory.Material,
    costName: '钢筋采购',
    budgetAmount: 400000,
    actualAmount: 432000,
    occurredAt: '2026-06-12'
  };

  // 1. 正常录入
  const item1 = await costItemService.create(
    { ...baseInput, budgetId: budgetA1, voucherNo: 'V-001' },
    ctx
  );
  assert(item1.id, '正常录入成本项成功');
  assert(item1.projectId === projectA, '冗余 projectId 已写入');

  const budgetAfterCreate = await budgetService.getById(budgetA1);
  assert(Number(budgetAfterCreate.usedAmount) === 432000, '预算已用额按实际金额增加');

  // 2. 同项目同号凭证（不同预算）重复提交 -> 409
  await expectConflict(
    costItemService.create({ ...baseInput, budgetId: budgetA2, voucherNo: 'V-001' }, ctx),
    '同项目同号凭证（不同预算）被拒绝'
  );

  // 3. 不同项目相同凭证号允许
  const otherProjectItem = await costItemService.create(
    { ...baseInput, budgetId: budgetB1, voucherNo: 'V-001' },
    ctx
  );
  assert(Boolean(otherProjectItem.id), '不同项目可使用相同凭证号');

  // 4. 同项目同号凭证并发请求只有一笔成功
  const concurrentVoucher = 'V-CONCURRENT';
  const results = await Promise.allSettled([
    costItemService.create(
      { ...baseInput, actualAmount: 100, budgetId: budgetA1, voucherNo: concurrentVoucher },
      ctx
    ),
    costItemService.create(
      { ...baseInput, actualAmount: 200, budgetId: budgetA2, voucherNo: concurrentVoucher },
      ctx
    )
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert(fulfilled.length === 1 && rejected.length === 1, '并发同号凭证仅一笔成功');

  const concurrentCount = await costItemRepo.count({ where: { voucherNo: concurrentVoucher } });
  assert(concurrentCount === 1, '数据库中同号凭证只有一条记录');

  const rejectedReason = (rejected[0] as PromiseRejectedResult).reason as {
    status?: number;
    code?: string;
  };
  assert(
    rejectedReason.status === 409 || rejectedReason.code === '23505',
    '并发落败请求返回 409（或底层唯一约束冲突）'
  );
  const budgetA1Used = Number((await budgetService.getById(budgetA1)).usedAmount);
  const budgetA2Used = Number((await budgetService.getById(budgetA2)).usedAmount);
  const totalProjectAUsed = budgetA1Used + budgetA2Used;
  assert(totalProjectAUsed === 432100 || totalProjectAUsed === 432200, '并发后已用额不含被拒请求金额');

  // 6. 冲销：金额相反、填原因、原记录保留可查且状态为 Reversed
  const reversal = await costItemService.reverse(item1.id, '凭证金额录错，多计 12000', ctx);
  assert(Number(reversal.actualAmount) === -432000, '冲销记录金额与原记录相反');
  assert(reversal.reversalOfId === item1.id, '冲销记录关联原成本项');
  assert(reversal.reversalReason === '凭证金额录错，多计 12000', '冲销原因已保存');
  assert(reversal.status === CostItemStatus.Reversed, '冲销记录状态为 Reversed');
  assert(reversal.voucherNo === 'REV-V-001', '冲销凭证号按规则生成');

  const originalReloaded = await costItemService.getById(item1.id);
  assert(originalReloaded.status === CostItemStatus.Reversed, '原记录标记为 Reversed');
  assert(Number(originalReloaded.actualAmount) === 432000, '原记录金额保留，仍可查询');

  // 7. 冲销后预算已用额回到净额（item1 不再计入）
  const budgetAfterReverse = await budgetService.getById(budgetA1);
  const expectedUsed = budgetA1Used - 432000;
  assert(
    Number(budgetAfterReverse.usedAmount) === expectedUsed,
    `冲销后已用额按未冲销净额计算 (${budgetAfterReverse.usedAmount} == ${expectedUsed})`
  );

  // 8. 重复冲销只生效一次：应用层预检
  await expectConflict(costItemService.reverse(item1.id, '再次冲销', ctx), '重复冲销返回 409');

  // 9. 冲销记录本身不可再冲销
  await expectBadRequest(costItemService.reverse(reversal.id, '冲销冲销记录', ctx), '冲销记录不可再冲销');

  // 10. 并发冲销只有一次生效
  const item2 = await costItemService.create(
    { ...baseInput, actualAmount: 500, budgetId: budgetA2, voucherNo: 'V-002' },
    ctx
  );
  const reverseResults = await Promise.allSettled([
    costItemService.reverse(item2.id, '并发冲销1', ctx),
    costItemService.reverse(item2.id, '并发冲销2', ctx)
  ]);
  assert(
    reverseResults.filter((r) => r.status === 'fulfilled').length === 1 &&
      reverseResults.filter((r) => r.status === 'rejected').length === 1,
    '并发冲销仅一笔生效'
  );
  const reversalCount = await costItemRepo.count({ where: { reversalOfId: item2.id } });
  assert(reversalCount === 1, '同一原记录数据库中只有一笔冲销');

  // 11. 数据库层部分唯一索引真实存在并生效（直接绕过应用插入第二条冲销）
  let rawViolation: unknown;
  try {
    await costItemRepo.query(
      `INSERT INTO cost_items (id, budget_id, project_id, category, cost_name, budget_amount, actual_amount,
        variance_amount, occurred_at, voucher_no, status, reversal_of_id, reversal_reason, created_at, updated_at)
       VALUES ($6, $1, $2, $3, $4, 0, -500, -500, '2026-06-12', 'REV-V-002-DUP', 'Reversed', $5, '绕过应用', now(), now())`,
      [budgetA2, projectA, CostCategory.Material, 'dup', item2.id, randomUUID()]
    );
  } catch (error) {
    rawViolation = (error as { code?: string }).code;
  }
  assert(rawViolation === '23505', '部分唯一索引拒绝第二条冲销 (23505)');

  // 12. 唯一索引同样在数据库层拦截重复凭证（绕过应用）
  let voucherViolation: unknown;
  try {
    await costItemRepo.query(
      `INSERT INTO cost_items (id, budget_id, project_id, category, cost_name, budget_amount, actual_amount,
        variance_amount, occurred_at, voucher_no, status, created_at, updated_at)
       VALUES ($5, $1, $2, $3, $4, 1, 1, 0, '2026-06-12', 'V-001', 'Normal', now(), now())`,
      [budgetA2, projectA, CostCategory.Material, 'dup-voucher', randomUUID()]
    );
  } catch (error) {
    voucherViolation = (error as { code?: string }).code;
  }
  assert(voucherViolation === '23505', '数据库唯一索引拦截同项目重复凭证号');

  // 13. 成本列表中原记录与冲销记录均可查
  const allItems = await costItemService.list();
  const ids = allItems.map((i) => i.id);
  assert(ids.includes(item1.id) && ids.includes(reversal.id), '原记录与冲销记录均保留可查');

  // 14. 报表汇总反映冲销后净额
  const itemsForReport = await costItemRepo.find();
  const summary = analyticsService.summarize(itemsForReport, 3000000);
  // project A/B 全部成本项汇总：未冲销的 = otherProject(432000) + 并发胜出项(100 或 200)；冲销对与被冲销项均计 0
  const expectedTotal = 432000 + (totalProjectAUsed === 432100 ? 100 : 200) + (500 - 500);
  assert(Number(summary.materialCostTotal) === expectedTotal, `报表材料成本为冲销后净额 ${summary.materialCostTotal}`);
  assert(Number(summary.totalCost) === expectedTotal, `报表总成本反映冲销后净额 ${summary.totalCost}`);

  // 15. 审计日志覆盖录入与冲销
  const auditCount = await dataSource.getRepository(AuditLog).count();
  assert(auditCount >= 4, `关键操作写入审计日志（共 ${auditCount} 条）`);

  console.log(`\n${passed} 项断言全部通过`);
  await dataSource.destroy();
}

main().catch((error) => {
  console.error('集成脚本异常:', error);
  process.exitCode = 1;
});
