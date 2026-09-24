import { CostCategory, CostItemStatus } from '../types/enums';

export interface EffectiveCostItemLike {
  status: CostItemStatus;
  reversalOfId?: string | null;
  actualAmount: string | number;
}

export function toMoney(value: string | number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error('金额必须是有效数字');
  }

  return amount.toFixed(2);
}

/**
 * 冲销记录自身不计入成本。
 */
export function isReversalEntry(item: EffectiveCostItemLike): boolean {
  return Boolean(item.reversalOfId);
}

/**
 * 已被冲销的原始记录不再计入成本。
 */
export function isReversedItem(item: EffectiveCostItemLike): boolean {
  return item.status === CostItemStatus.Reversed;
}

/**
 * 预算已用额、成本报表只统计未被冲销的原始成本项；
 * 冲销记录与已冲销原始记录均返回 0。
 */
export function effectiveActualAmount(item: EffectiveCostItemLike): number {
  if (isReversalEntry(item) || isReversedItem(item)) {
    return 0;
  }

  return Number(item.actualAmount);
}

export function calculateVarianceAmount(budgetAmount: string | number, actualAmount: string | number): string {
  return toMoney(Number(actualAmount) - Number(budgetAmount));
}

export function calculateChangedAmount(originalAmount: string | number, changeAmount: string | number): string {
  return toMoney(Number(originalAmount) + Number(changeAmount));
}

export function sumMoney(values: Array<string | number>): string {
  return toMoney(values.reduce<number>((sum, current) => sum + Number(current), 0));
}

export function normalizeOtherCostCategory(category: CostCategory): 'labor' | 'material' | 'equipment' | 'other' {
  if (category === CostCategory.Labor) {
    return 'labor';
  }

  if (category === CostCategory.Material) {
    return 'material';
  }

  if (category === CostCategory.Equipment) {
    return 'equipment';
  }

  return 'other';
}
