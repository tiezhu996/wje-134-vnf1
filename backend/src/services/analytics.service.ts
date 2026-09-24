import { Injectable } from '@nestjs/common';
import { CostItem } from '../models/costItem.entity';
import { normalizeOtherCostCategory, sumMoney, toMoney } from '../utils/calculator';

export interface CostAnalysisSummary {
  laborCostTotal: string;
  materialCostTotal: string;
  equipmentCostTotal: string;
  otherCostTotal: string;
  totalCost: string;
  profitLossAnalysis: string;
}

@Injectable()
export class AnalyticsService {
  summarize(costItems: CostItem[], approvedBudgetTotal: number): CostAnalysisSummary {
    const buckets = {
      labor: 0,
      material: 0,
      equipment: 0,
      other: 0
    };

    for (const item of costItems) {
      const bucket = normalizeOtherCostCategory(item.category);
      // 成本报表只统计未冲销的实际金额（冲销后原始凭证与冲销凭证净额均为 0）
      buckets[bucket] += item.effectiveActualAmount();
    }

    const totalCost = Number(sumMoney([buckets.labor, buckets.material, buckets.equipment, buckets.other]));
    const delta = approvedBudgetTotal - totalCost;
    const profitLossAnalysis =
      delta >= 0
        ? `当前成本低于预算 ${toMoney(delta)}，项目成本处于可控区间。`
        : `当前成本超出预算 ${toMoney(Math.abs(delta))}，需复核异常成本和变更单。`;

    return {
      laborCostTotal: toMoney(buckets.labor),
      materialCostTotal: toMoney(buckets.material),
      equipmentCostTotal: toMoney(buckets.equipment),
      otherCostTotal: toMoney(buckets.other),
      totalCost: toMoney(totalCost),
      profitLossAnalysis
    };
  }
}
