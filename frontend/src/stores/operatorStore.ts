/**
 * 操耍人状态管理（Zustand）
 * 维护操耍人档与角色指派关系（双向同步：角色.operatorId ↔ 操耍人.assignedRoleIds）。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  listAllRoles,
  listOperators,
  putOperator,
  putOperators,
  removeOperator,
  type OperatorRow,
  type RoleRow,
} from '../utils/db';
import type { BusySlot, OperatorDraft } from '../types/operator';
import { slotsOverlap, type SlotRange } from '../types/operator';
import { nowIso, uuid } from '../utils/uuid';

/** 指派/解绑结果：被冲突时段拦截时返回 blocked 与原因 */
export interface AssignResult {
  ok: boolean;
  blocked: boolean;
  message: string;
}

interface OperatorStoreState {
  operators: OperatorRow[];
  loading: boolean;
  error: string;
  loadOperators: () => Promise<void>;
  createOperator: (draft: OperatorDraft) => Promise<OperatorRow>;
  updateOperator: (
    operatorId: string,
    patch: Partial<Omit<OperatorRow, 'id' | 'createdAt' | 'revision'>>,
  ) => Promise<void>;
  deleteOperator: (operatorId: string) => Promise<void>;
  addBusySlot: (operatorId: string, slot: Omit<BusySlot, 'id'>) => Promise<BusySlot>;
  removeBusySlot: (operatorId: string, slotId: string) => Promise<void>;
  syncAssignments: (roles: RoleRow[]) => Promise<void>;
  operatorOfRole: (roleId: string) => OperatorRow | undefined;
  rolesOfOperator: (operatorId: string) => string[];
  slotRangesOf: (operatorId: string) => SlotRange[];
  /** 某个操耍人自身是否已经有时段互相重叠（档期自冲突） */
  selfConflicts: (operatorId: string) => Array<[SlotRange, SlotRange]>;
  /** 两个操耍人之间的共同重叠时段 */
  pairwiseConflicts: (aId: string, bId: string) => Array<[SlotRange, SlotRange]>;
  updateRehearsalHours: (operatorId: string, delta: number) => Promise<void>;
}

function toRange(operator: OperatorRow, slot: BusySlot): SlotRange {
  return {
    slotId: slot.id,
    weekday: slot.weekday,
    startMinute: slot.startMinute,
    endMinute: slot.startMinute + slot.durationMinute,
    label: `${operator.name}·${slot.label}`,
  };
}

export const useOperatorStore = create<OperatorStoreState>((set, get) => ({
  operators: [],
  loading: false,
  error: '',

  async loadOperators() {
    set({ loading: true, error: '' });
    try {
      const operators = await listOperators();
      set({ operators, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '操耍人档读取失败' });
    }
  },

  async createOperator(draft) {
    const stamp = nowIso();
    const row: OperatorRow = {
      id: uuid(),
      name: draft.name.trim() || '未具名师傅',
      skillTags: [...draft.skillTags],
      busySlots: [],
      assignedRoleIds: [],
      rehearsalHours: 0,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putOperator(row);
    await get().loadOperators();
    return row;
  },

  async updateOperator(operatorId, patch) {
    const existing = get().operators.find((item) => item.id === operatorId);
    if (!existing) return;
    await putOperator({ ...existing, ...patch, updatedAt: nowIso(), revision: ROW_REVISION });
    await get().loadOperators();
  },

  async deleteOperator(operatorId) {
    await removeOperator(operatorId);
    await get().loadOperators();
  },

  async addBusySlot(operatorId, slot) {
    const existing = get().operators.find((item) => item.id === operatorId);
    const created: BusySlot = { ...slot, id: uuid() };
    if (!existing) return created;
    await putOperator({
      ...existing,
      busySlots: [...existing.busySlots, created],
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
    await get().loadOperators();
    return created;
  },

  async removeBusySlot(operatorId, slotId) {
    const existing = get().operators.find((item) => item.id === operatorId);
    if (!existing) return;
    await putOperator({
      ...existing,
      busySlots: existing.busySlots.filter((slot) => slot.id !== slotId),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
    await get().loadOperators();
  },

  async syncAssignments(roles) {
    const operators = get().operators;
    const byOperator = new Map<string, string[]>();
    operators.forEach((operator) => byOperator.set(operator.id, []));
    roles.forEach((role) => {
      if (role.operatorId !== null && byOperator.has(role.operatorId)) {
        (byOperator.get(role.operatorId) as string[]).push(role.id);
      }
    });
    const next = operators.map((operator) => {
      const roleIds = byOperator.get(operator.id) ?? [];
      const sameLength = roleIds.length === operator.assignedRoleIds.length;
      const sameContent = sameLength && roleIds.every((id) => operator.assignedRoleIds.includes(id));
      if (sameContent) return operator;
      return { ...operator, assignedRoleIds: roleIds, updatedAt: nowIso(), revision: ROW_REVISION };
    });
    const changed = next.filter((operator, index) => operator !== operators[index]);
    if (changed.length > 0) {
      await putOperators(changed);
      await get().loadOperators();
    }
  },

  operatorOfRole(roleId) {
    return get().operators.find((operator) => operator.assignedRoleIds.includes(roleId));
  },

  rolesOfOperator(operatorId) {
    const operator = get().operators.find((item) => item.id === operatorId);
    return operator ? [...operator.assignedRoleIds] : [];
  },

  slotRangesOf(operatorId) {
    const operator = get().operators.find((item) => item.id === operatorId);
    if (!operator) return [];
    return operator.busySlots.map((slot) => toRange(operator, slot));
  },

  selfConflicts(operatorId) {
    const ranges = get().slotRangesOf(operatorId);
    const pairs: Array<[SlotRange, SlotRange]> = [];
    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        if (slotsOverlap(ranges[i], ranges[j])) pairs.push([ranges[i], ranges[j]]);
      }
    }
    return pairs;
  },

  pairwiseConflicts(aId, bId) {
    const a = get().slotRangesOf(aId);
    const b = get().slotRangesOf(bId);
    const pairs: Array<[SlotRange, SlotRange]> = [];
    a.forEach((left) => {
      b.forEach((right) => {
        if (slotsOverlap(left, right)) pairs.push([left, right]);
      });
    });
    return pairs;
  },

  async updateRehearsalHours(operatorId, delta) {
    const existing = get().operators.find((item) => item.id === operatorId);
    if (!existing) return;
    const hours = Math.max(0, Math.round((existing.rehearsalHours + delta) * 10) / 10);
    await putOperator({ ...existing, rehearsalHours: hours, updatedAt: nowIso(), revision: ROW_REVISION });
    await get().loadOperators();
  },
}));

/** 便捷选择器：按 id 取操耍人姓名 */
export function operatorNameOf(operators: OperatorRow[], operatorId: string | null): string {
  if (operatorId === null) return '待指派';
  return operators.find((operator) => operator.id === operatorId)?.name ?? '（已解绑）';
}

/** 读取全部角色的辅助函数（供页面在指派后做双向同步） */
export async function fetchAllRoles(): Promise<RoleRow[]> {
  return listAllRoles();
}
