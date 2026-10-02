/**
 * useOperatorConflict(roleIds)
 * 按操耍人已排时段计算冲突，并在指派时拦截；被角色指派页消费。
 */
import { useCallback, useMemo } from 'react';
import { useOperatorStore } from '../stores/operatorStore';
import { db, ROW_REVISION } from '../utils/db';
import { nowIso } from '../utils/uuid';
import type { SlotRange, Weekday } from '../types/operator';
import { WEEKDAY_LABEL, minuteToClock, slotsOverlap } from '../types/operator';

/** 两个操耍人时段的冲突描述 */
export interface OperatorConflictPair {
  left: SlotRange;
  right: SlotRange;
  weekday: Weekday;
  describe: string;
}

/** 指派候选人的可评估信息 */
export interface CandidateAssessment {
  operatorId: string;
  /** 是否与自身已排时段自冲突 */
  selfConflict: boolean;
  /** 自身冲突描述 */
  selfConflictText: string;
  /** 与同场次其他影人操耍人的冲突 */
  crossConflicts: OperatorConflictPair[];
  /** 能否指派 */
  assignable: boolean;
  /** 拦截原因（assignable 为 false 时有值） */
  blockReason: string;
}

export interface UseOperatorConflictResult {
  loading: boolean;
  /** 本场已产生的操耍人冲突（两两） */
  conflicts: OperatorConflictPair[];
  /** 全档自冲突（同一人时段互相重叠）列表 */
  selfConflictOperators: Array<{ operatorId: string; name: string; text: string }>;
  /** 评估某个操耍人能否接手某个角色 */
  assess: (roleId: string, operatorId: string) => CandidateAssessment;
  /** 指派角色；被冲突时段拦截时返回 false */
  bind: (roleId: string, operatorId: string) => Promise<boolean>;
  /** 解绑角色 */
  unbind: (roleId: string) => Promise<void>;
  /** 冲突汇总文案 */
  conflictSummary: string;
  reload: () => Promise<void>;
}

function describePair(left: SlotRange, right: SlotRange): string {
  const from = minuteToClock(Math.max(left.startMinute, right.startMinute));
  const to = minuteToClock(Math.min(left.endMinute, right.endMinute));
  return `${left.label} 与 ${right.label} 在${WEEKDAY_LABEL[left.weekday]} ${from}-${to} 重叠`;
}

export function useOperatorConflict(roleIds: string[]): UseOperatorConflictResult {
  const operators = useOperatorStore((state) => state.operators);
  const loading = useOperatorStore((state) => state.loading);
  const loadOperators = useOperatorStore((state) => state.loadOperators);
  const slotRangesOf = useOperatorStore((state) => state.slotRangesOf);
  const selfConflicts = useOperatorStore((state) => state.selfConflicts);

  /** 角色 id → 已指派操耍人 id */
  const roleOperatorMap = useMemo(() => {
    const map = new Map<string, string>();
    operators.forEach((operator) => {
      operator.assignedRoleIds.forEach((roleId) => map.set(roleId, operator.id));
    });
    return map;
  }, [operators]);

  const conflicts = useMemo<OperatorConflictPair[]>(() => {
    const assigned = new Set(roleIds);
    const active = operators.filter((operator) => operator.assignedRoleIds.some((roleId) => assigned.has(roleId)));
    const pairs: OperatorConflictPair[] = [];
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const leftRanges = slotRangesOf(active[i].id);
        const rightRanges = slotRangesOf(active[j].id);
        leftRanges.forEach((left) => {
          rightRanges.forEach((right) => {
            if (slotsOverlap(left, right)) {
              pairs.push({ left, right, weekday: left.weekday, describe: describePair(left, right) });
            }
          });
        });
      }
    }
    return pairs;
  }, [operators, roleIds, slotRangesOf]);

  const selfConflictOperators = useMemo(
    () =>
      operators
        .map((operator) => {
          const pairs = selfConflicts(operator.id);
          if (pairs.length === 0) return null;
          return {
            operatorId: operator.id,
            name: operator.name,
            text: pairs.map(([left, right]) => describePair(left, right)).join('；'),
          };
        })
        .filter((item): item is { operatorId: string; name: string; text: string } => item !== null),
    [operators, selfConflicts],
  );

  const assess = useCallback(
    (roleId: string, operatorId: string): CandidateAssessment => {
      const selfPairs = selfConflicts(operatorId);
      const selfText = selfPairs.map(([left, right]) => describePair(left, right)).join('；');

      // 同一场次内容的其他角色已派操耍人（排除当前角色绑定的那位）
      const siblings = operators.filter(
        (operator) =>
          operator.id !== operatorId && operator.assignedRoleIds.some((id) => id !== roleId && roleIds.includes(id)),
      );
      const crossConflicts: OperatorConflictPair[] = [];
      const leftRanges = slotRangesOf(operatorId);
      siblings.forEach((sibling) => {
        const rightRanges = slotRangesOf(sibling.id);
        leftRanges.forEach((left) => {
          rightRanges.forEach((right) => {
            if (slotsOverlap(left, right)) {
              crossConflicts.push({ left, right, weekday: left.weekday, describe: describePair(left, right) });
            }
          });
        });
      });

      if (selfPairs.length > 0) {
        return {
          operatorId,
          selfConflict: true,
          selfConflictText: selfText,
          crossConflicts,
          assignable: false,
          blockReason: `该操耍人自身档期重叠：${selfText}`,
        };
      }
      if (crossConflicts.length > 0) {
        return {
          operatorId,
          selfConflict: false,
          selfConflictText: selfText,
          crossConflicts,
          assignable: false,
          blockReason: `与同场其他影人操耍人时段冲突：${crossConflicts[0].describe}`,
        };
      }
      return {
        operatorId,
        selfConflict: false,
        selfConflictText: selfText,
        crossConflicts,
        assignable: true,
        blockReason: '',
      };
    },
    [operators, roleIds, selfConflicts, slotRangesOf],
  );

  const bind = useCallback(
    async (roleId: string, operatorId: string): Promise<boolean> => {
      const assessment = assess(roleId, operatorId);
      if (!assessment.assignable) return false;
      const role = await db.roles.get(roleId);
      if (!role) return false;
      const stamp = nowIso();
      await db.roles.put({ ...role, operatorId, updatedAt: stamp, revision: ROW_REVISION });

      const operator = operators.find((item) => item.id === operatorId);
      if (operator && !operator.assignedRoleIds.includes(roleId)) {
        await db.operators.put({
          ...operator,
          assignedRoleIds: [...operator.assignedRoleIds, roleId],
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
      }
      // 换人时解掉原操耍人的绑定
      const previousHolder = operators.find((item) => item.id !== operatorId && item.assignedRoleIds.includes(roleId));
      if (previousHolder) {
        await db.operators.put({
          ...previousHolder,
          assignedRoleIds: previousHolder.assignedRoleIds.filter((id) => id !== roleId),
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
      }
      await loadOperators();
      return true;
    },
    [assess, loadOperators, operators],
  );

  const unbind = useCallback(
    async (roleId: string): Promise<void> => {
      const stamp = nowIso();
      const role = await db.roles.get(roleId);
      if (role) {
        await db.roles.put({ ...role, operatorId: null, updatedAt: stamp, revision: ROW_REVISION });
      }
      const holders = operators.filter((item) => item.assignedRoleIds.includes(roleId));
      if (holders.length > 0) {
        for (const holder of holders) {
          await db.operators.put({
            ...holder,
            assignedRoleIds: holder.assignedRoleIds.filter((id) => id !== roleId),
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
      }
      await loadOperators();
    },
    [loadOperators, operators],
  );

  const conflictSummary = useMemo(() => {
    if (conflicts.length > 0) return `本场 ${conflicts.length} 处操耍人档期冲突，需调整时段`;
    if (selfConflictOperators.length > 0) return `全档有 ${selfConflictOperators.length} 人时段互相重叠`;
    const assignedCount = roleIds.filter((roleId) => roleOperatorMap.has(roleId)).length;
    return `已指派 ${assignedCount}/${roleIds.length} 个角色，无档期冲突`;
  }, [conflicts.length, roleIds, roleOperatorMap, selfConflictOperators.length]);

  return {
    loading,
    conflicts,
    selfConflictOperators,
    assess,
    bind,
    unbind,
    conflictSummary,
    reload: loadOperators,
  };
}
