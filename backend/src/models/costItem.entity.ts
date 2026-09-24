import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';
import { ProjectBudget } from './budget.entity';
import { CostCategory, CostItemStatus } from '../types/enums';

@Entity({ name: 'cost_items' })
// 同一项目（预算）内凭证号唯一，数据库层兜底，防止重复或并发提交产生两笔
@Index(['budgetId', 'voucherNo'], { unique: true })
export class CostItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'budget_id', type: 'uuid' })
  budgetId: string;

  @ManyToOne(() => ProjectBudget, (budget) => budget.costItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'budget_id' })
  budget: ProjectBudget;

  @Column({ type: 'enum', enum: CostCategory })
  category: CostCategory;

  @Column({ name: 'cost_name', type: 'varchar', length: 180 })
  costName: string;

  @Column({ name: 'budget_amount', type: 'numeric', precision: 14, scale: 2 })
  budgetAmount: string;

  @Column({ name: 'actual_amount', type: 'numeric', precision: 14, scale: 2 })
  actualAmount: string;

  @Column({ name: 'variance_amount', type: 'numeric', precision: 14, scale: 2 })
  varianceAmount: string;

  @Column({ name: 'occurred_at', type: 'date' })
  occurredAt: string;

  @Column({ name: 'voucher_no', type: 'varchar', length: 80 })
  voucherNo: string;

  @Column({ name: 'material_usage_id', type: 'uuid', nullable: true })
  materialUsageId?: string | null;

  @Column({ name: 'labor_time_record_id', type: 'uuid', nullable: true })
  laborTimeRecordId?: string | null;

  @Column({ type: 'enum', enum: CostItemStatus, default: CostItemStatus.Normal })
  status: CostItemStatus;

  @Column({ name: 'exception_reason', type: 'text', nullable: true })
  exceptionReason?: string | null;

  @Column({ name: 'reversal_of_id', type: 'uuid', nullable: true })
  reversalOfId?: string | null;

  // 冲销记录指向被冲销的原始成本；original + reversal 均保留可查
  @OneToOne(() => CostItem, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reversal_of_id' })
  reversalOf?: CostItem | null;

  @Column({ name: 'reversal_reason', type: 'text', nullable: true })
  reversalReason?: string | null;

  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  get isReversal(): boolean {
    return this.reversalOfId !== null && this.reversalOfId !== undefined;
  }

  // 未冲销的实际金额：已冲销原始凭证与冲销凭证本身均不计入预算已用额与成本报表
  effectiveActualAmount(): number {
    return this.status === CostItemStatus.Reversed || this.isReversal ? 0 : Number(this.actualAmount);
  }
}
