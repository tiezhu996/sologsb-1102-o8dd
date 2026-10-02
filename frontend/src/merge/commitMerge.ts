/**
 * 合并提交：把已核对的合并计划一次性写入本机库（单事务）。
 * - 远端新增的实体按业务编号派生稳定本机 id，同一包重试不会重复追加
 * - 场次撤掉：角色指派与锣鼓点级联清掉
 * - 操耍人撤掉：名下角色 / 锣鼓点领奏解绑为待指派
 * - 提交后场次按场序连续重排，并回写剧目场次总数
 */
import {
  db,
  ROW_REVISION,
  type CueRow,
  type OperatorRow,
  type PlayRow,
  type RoleRow,
  type SceneRow,
} from '../utils/db';
import type { Operator, BusySlot } from '../types/operator';
import type { MergeOutcome } from '../types/rehearsalPackage';
import { nowIso, uuid } from '../utils/uuid';
import { stableLocalId } from '../utils/bizCode';
import type { RehearsalPackageView } from './packageIO';
import {
  ARRAY_FIELD_META,
  FIELD_META,
  isSceneDeleted,
  resolveArrayValue,
  toItems,
  type EntityPlan,
  type MergePlan,
} from './mergeEngine';

export class UnresolvedConflictError extends Error {}

/** 合并提交所需的本机范围数据（剧目 + 场次/角色/锣鼓点 + 全档操耍人） */
export interface LocalScope {
  play: PlayRow | null;
  scenes: SceneRow[];
  roles: RoleRow[];
  cues: CueRow[];
  operators: OperatorRow[];
}

/** 从库里取某剧目的合并范围 */
export async function loadLocalScope(playBizCode: string): Promise<LocalScope> {
  const play = await db.plays.where('bizCode').equals(playBizCode).first();
  const scenes = play ? await db.scenes.where('playId').equals(play.id).toArray() : [];
  const sceneIds = scenes.map((scene) => scene.id);
  const [roles, cues, operators] = await Promise.all([
    sceneIds.length > 0 ? db.roles.where('sceneId').anyOf(sceneIds).toArray() : Promise.resolve([] as RoleRow[]),
    sceneIds.length > 0 ? db.cues.where('sceneId').anyOf(sceneIds).toArray() : Promise.resolve([] as CueRow[]),
    db.operators.toArray(),
  ]);
  return { play: play ?? null, scenes, roles, cues, operators };
}

/** 提交合并（要求全部冲突已选定）；返回写入统计 */
export async function commitMerge(plan: MergePlan, pkg: RehearsalPackageView, local: LocalScope): Promise<MergeOutcome> {
  const unresolved = plan.entries.filter((entry) =>
    entry.conflicts.some((conflict) => conflict.resolution === null),
  );
  if (unresolved.length > 0) {
    throw new UnresolvedConflictError(`还有 ${unresolved.length} 个实体的冲突未核对`);
  }

  const stamp = nowIso();
  const outcome: MergeOutcome = {
    playId: local.play?.id ?? stableLocalId('play', plan.playBizCode),
    playsChanged: 0,
    scenesAdded: 0,
    scenesDeleted: 0,
    scenesChanged: 0,
    rolesAdded: 0,
    rolesDeleted: 0,
    rolesChanged: 0,
    cuesAdded: 0,
    cuesDeleted: 0,
    cuesChanged: 0,
    operatorsAdded: 0,
    operatorsChanged: 0,
    conflictsResolved: 0,
    cascadedRoles: 0,
    cascadedCues: 0,
    unboundRoles: 0,
    unboundCues: 0,
  };
  plan.entries.forEach((entry) => {
    outcome.conflictsResolved += entry.conflicts.length;
  });

  const playEntry = plan.entries.find((entry) => entry.kind === 'play');
  const operatorEntries = plan.entries.filter((entry) => entry.kind === 'operator');
  const sceneEntries = plan.entries.filter((entry) => entry.kind === 'scene');
  const roleEntries = plan.entries.filter((entry) => entry.kind === 'role');
  const cueEntries = plan.entries.filter((entry) => entry.kind === 'cue');

  // 操耍人业务编号 → 本机 id（含本次新增），供角色 / 锣鼓点重绑
  const operatorIdByCode = new Map<string, string>();
  local.operators.forEach((operator) => operatorIdByCode.set(operator.bizCode, operator.id));

  const deletedOperatorCodes = new Set<string>();
  const operatorPuts: OperatorRow[] = [];
  operatorEntries.forEach((entry) => {
    const del = entry.conflicts.find((conflict) => conflict.conflictKind === 'deleteModify');
    if (entry.local && !entry.remote) {
      if (entry.status === 'deleted' || del?.resolution === 'delete') {
        deletedOperatorCodes.add(entry.bizCode);
        return;
      }
      // 选 keep / 本机打包后新增：保留本机，不覆盖
      return;
    }
    if (!entry.local && entry.remote) {
      const id = stableLocalId('operator', entry.bizCode);
      operatorIdByCode.set(entry.bizCode, id);
      const mergedFields = resolveMergedFields(entry) as Partial<Operator>;
      const remoteRow = pkg.current.operators.find((item) => item.bizCode === entry.bizCode);
      operatorPuts.push(
        buildRow<OperatorRow>(
          {
            bizCode: entry.bizCode,
            assignedRoleIds: [],
            createdAt: remoteRow?.createdAt ?? stamp,
          },
          {
            id,
            name: String(mergedFields.name ?? remoteRow?.name ?? '未具名师傅'),
            skillTags: mergedFields.skillTags ?? remoteRow?.skillTags ?? [],
            busySlots: mapBusySlots(
              mergedFields.busySlots as BusySlot[] | undefined,
              remoteRow?.busySlots,
              id,
            ),
            rehearsalHours: Number(mergedFields.rehearsalHours ?? remoteRow?.rehearsalHours ?? 0),
            updatedAt: stamp,
            revision: ROW_REVISION,
          },
        ),
      );
      outcome.operatorsAdded += 1;
      return;
    }
    const existing = local.operators.find((item) => item.bizCode === entry.bizCode);
    if (!existing) return;
    if (entry.status === 'unchanged') return;
    const mergedFields = resolveMergedFields(entry) as Partial<Operator>;
    operatorPuts.push({
      ...existing,
      name: String(mergedFields.name ?? existing.name),
      skillTags: (mergedFields.skillTags as Operator['skillTags']) ?? existing.skillTags,
      busySlots: mapBusySlots(mergedFields.busySlots as BusySlot[] | undefined, existing.busySlots, existing.id),
      rehearsalHours: Number(mergedFields.rehearsalHours ?? existing.rehearsalHours),
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    outcome.operatorsChanged += 1;
  });

  // 剧目
  const playPuts: PlayRow[] = [];
  if (playEntry) {
    const mergedFields = resolveMergedFields(playEntry) as Partial<PlayRow>;
    if (local.play) {
      if (playEntry.status !== 'unchanged' || playEntry.conflicts.length > 0) {
        playPuts.push({
          ...local.play,
          ...pickScalarFields('play', mergedFields),
          // totalScenes 在场景重排后统一回写
          totalScenes: local.play.totalScenes,
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
        outcome.playsChanged += 1;
      }
    } else {
      const remotePlay = pkg.current.play;
      playPuts.push(
        buildRow<PlayRow>(
          {
            bizCode: remotePlay.bizCode,
            totalScenes: 0,
            createdAt: remotePlay.createdAt || stamp,
          },
          {
            id: outcome.playId,
            ...pickScalarFields('play', mergedFields),
            updatedAt: stamp,
            revision: ROW_REVISION,
          },
        ),
      );
      outcome.playsChanged += 1;
    }
  }
  const playLocalId = playPuts[0]?.id ?? local.play?.id ?? outcome.playId;

  // 场次：本机 id / 新增稳定 id 映射
  const sceneIdByCode = new Map<string, string>();
  local.scenes.forEach((scene) => sceneIdByCode.set(scene.bizCode, scene.id));
  const scenePuts: SceneRow[] = [];
  const deletedSceneCodes = new Set<string>();
  sceneEntries.forEach((entry) => {
    if (isSceneDeleted(entry)) {
      deletedSceneCodes.add(entry.bizCode);
      if (entry.local) outcome.scenesDeleted += 1;
      return;
    }
    const mergedFields = resolveMergedFields(entry) as Partial<SceneRow>;
    if (!entry.local && entry.remote) {
      const id = stableLocalId('scene', entry.bizCode);
      sceneIdByCode.set(entry.bizCode, id);
      const remoteRow = pkg.current.scenes.find((item) => item.bizCode === entry.bizCode);
      scenePuts.push(
        buildRow<SceneRow>(
          {
            bizCode: entry.bizCode,
            playId: playLocalId,
            createdAt: remoteRow?.createdAt ?? stamp,
          },
          {
            id,
            ...pickScalarFields('scene', mergedFields),
            updatedAt: stamp,
            revision: ROW_REVISION,
          },
        ),
      );
      outcome.scenesAdded += 1;
      return;
    }
    const existing = local.scenes.find((item) => item.bizCode === entry.bizCode);
    if (!existing) return;
    if (entry.status === 'unchanged') {
      sceneIdByCode.set(entry.bizCode, existing.id);
      return;
    }
    scenePuts.push({
      ...existing,
      ...pickScalarFields('scene', mergedFields),
      playId: playLocalId,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    outcome.scenesChanged += 1;
  });

  // 删除场序去重后按 seq 连续重排（事务内对全剧场次统一执行，这里仅保证插入顺序）
  scenePuts.sort((a, b) => a.seq - b.seq || a.bizCode.localeCompare(b.bizCode));

  // 角色
  const rolePuts: RoleRow[] = [];
  const deletedRoleIds = new Set<string>();
  roleEntries.forEach((entry) => {
    const parentSceneCode = String((entry.remote ?? entry.local)?.sceneBizCode ?? '');
    if (parentSceneCode && deletedSceneCodes.has(parentSceneCode)) {
      if (entry.local) {
        deletedRoleIds.add(local.roles.find((item) => item.bizCode === entry.bizCode)?.id ?? '');
        outcome.cascadedRoles += 1;
      }
      return;
    }
    const del = entry.conflicts.find((conflict) => conflict.conflictKind === 'deleteModify');
    if (entry.local && !entry.remote && (entry.status === 'deleted' || del?.resolution === 'delete')) {
      deletedRoleIds.add(local.roles.find((item) => item.bizCode === entry.bizCode)?.id ?? '');
      outcome.rolesDeleted += 1;
      return;
    }
    const sceneId = parentSceneCode ? sceneIdByCode.get(parentSceneCode) : undefined;
    if (!sceneId) return;
    const mergedFields = resolveMergedFields(entry) as Partial<RoleRow> & {
      propParts?: string[];
    };
    const remoteRef = pkg.current.roles.find((item) => item.bizCode === entry.bizCode);
    // merged.operatorId 已是操耍人业务编号（引擎已做 uuid→编号规范化），这里映射回本机 id
    const operatorCode = mergedFields.operatorId !== undefined ? (mergedFields.operatorId as string | null) : null;
    const operatorId = bindOperatorId(operatorCode, operatorIdByCode, deletedOperatorCodes, plan);
    if (operatorCode && !operatorId) outcome.unboundRoles += 1;

    if (!entry.local && entry.remote) {
      const id = stableLocalId('role', entry.bizCode);
      rolePuts.push(
        buildRow<RoleRow>(
          {
            bizCode: entry.bizCode,
            sceneId,
            ...pickScalarFields('role', mergedFields, ['operatorId', 'propParts']),
            propParts: (mergedFields.propParts as RoleRow['propParts']) ?? remoteRef?.propParts ?? [],
            createdAt: remoteRef?.createdAt ?? stamp,
          },
          { id, operatorId, updatedAt: stamp, revision: ROW_REVISION },
        ),
      );
      outcome.rolesAdded += 1;
      return;
    }
    const existing = local.roles.find((item) => item.bizCode === entry.bizCode);
    if (!existing) return;
    if (entry.status === 'unchanged' && operatorId === existing.operatorId) {
      return;
    }
    rolePuts.push(
      buildRow<RoleRow>(
        {
          ...existing,
          ...pickScalarFields('role', mergedFields, ['operatorId', 'propParts']),
          propParts: (mergedFields.propParts as RoleRow['propParts']) ?? existing.propParts,
          sceneId,
        },
        { operatorId, updatedAt: stamp, revision: ROW_REVISION },
      ),
    );
    outcome.rolesChanged += 1;
  });

  // 锣鼓点
  const cuePuts: CueRow[] = [];
  const deletedCueIds = new Set<string>();
  cueEntries.forEach((entry) => {
    const parentSceneCode = String((entry.remote ?? entry.local)?.sceneBizCode ?? '');
    if (parentSceneCode && deletedSceneCodes.has(parentSceneCode)) {
      if (entry.local) {
        deletedCueIds.add(local.cues.find((item) => item.bizCode === entry.bizCode)?.id ?? '');
        outcome.cascadedCues += 1;
      }
      return;
    }
    const del = entry.conflicts.find((conflict) => conflict.conflictKind === 'deleteModify');
    if (entry.local && !entry.remote && (entry.status === 'deleted' || del?.resolution === 'delete')) {
      deletedCueIds.add(local.cues.find((item) => item.bizCode === entry.bizCode)?.id ?? '');
      outcome.cuesDeleted += 1;
      return;
    }
    const sceneId = parentSceneCode ? sceneIdByCode.get(parentSceneCode) : undefined;
    if (!sceneId) return;
    const mergedFields = resolveMergedFields(entry) as Partial<CueRow>;
    const remoteRef = pkg.current.cues.find((item) => item.bizCode === entry.bizCode);
    // merged.leadOperator 已是操耍人业务编号，映射回本机 id
    const leadCode = mergedFields.leadOperator !== undefined ? (mergedFields.leadOperator as string | null) : null;
    const leadId = bindOperatorId(leadCode, operatorIdByCode, deletedOperatorCodes, plan);
    if (leadCode && !leadId) outcome.unboundCues += 1;

    if (!entry.local && entry.remote) {
      const id = stableLocalId('cue', entry.bizCode);
      cuePuts.push(
        buildRow<CueRow>(
          {
            bizCode: entry.bizCode,
            sceneId,
            ...pickScalarFields('cue', mergedFields, ['leadOperator']),
            createdAt: remoteRef?.createdAt ?? stamp,
          },
          { id, leadOperator: leadId, updatedAt: stamp, revision: ROW_REVISION },
        ),
      );
      outcome.cuesAdded += 1;
      return;
    }
    const existing = local.cues.find((item) => item.bizCode === entry.bizCode);
    if (!existing) return;
    if (entry.status === 'unchanged' && leadId === existing.leadOperator) return;
    cuePuts.push(
      buildRow<CueRow>(
        {
          ...existing,
          ...pickScalarFields('cue', mergedFields, ['leadOperator']),
          sceneId,
        },
        { leadOperator: leadId, updatedAt: stamp, revision: ROW_REVISION },
      ),
    );
    outcome.cuesChanged += 1;
  });

  // 场次级联删除：删场次本身 + 其下未进计划（本地残留）的角色、锣鼓点
  const deletedSceneLocalIds = new Set(
    sceneEntries
      .filter((entry) => deletedSceneCodes.has(entry.bizCode))
      .map((entry) => local.scenes.find((scene) => scene.bizCode === entry.bizCode)?.id)
      .filter((id): id is string => Boolean(id)),
  );

  // 操耍人删除：解绑其名下角色 / 锣鼓点（跨整库，不限本剧目）
  const deletedOperatorLocalIds = new Set(
    [...deletedOperatorCodes]
      .map((code) => local.operators.find((operator) => operator.bizCode === code)?.id)
      .filter((id): id is string => Boolean(id)),
  );

  // 重建操耍人 assignedRoleIds（全库角色 → 按最终 operatorId 归并）
  await db.transaction(
    'rw',
    [db.plays, db.scenes, db.roles, db.cues, db.operators, db.handoverBases, db.mergeSessions],
    async () => {
      // 先落剧目 / 场次 / 操耍人，保证外键目标存在
      if (playPuts.length > 0) await db.plays.bulkPut(playPuts);
      if (scenePuts.length > 0) await db.scenes.bulkPut(scenePuts);
      if (operatorPuts.length > 0) await db.operators.bulkPut(operatorPuts);

      // 场序对全剧现存场次连续重排（未改动行也参与，避免新增/撤场后留空号）
      const allPlayScenes = await db.scenes.where('playId').equals(playLocalId).toArray();
      allPlayScenes.sort((a, b) => a.seq - b.seq || a.bizCode.localeCompare(b.bizCode));
      const seqFixups = allPlayScenes
        .map((scene, index) =>
          scene.seq !== index + 1 ? { ...scene, seq: index + 1, updatedAt: stamp, revision: ROW_REVISION } : null,
        )
        .filter((row): row is SceneRow => row !== null);
      if (seqFixups.length > 0) await db.scenes.bulkPut(seqFixups);

      // 场次撤掉：删场次本身，并清理其下全部角色 / 锣鼓点
      if (deletedSceneLocalIds.size > 0) {
        await db.scenes.bulkDelete([...deletedSceneLocalIds]);
        await db.roles.where('sceneId').anyOf([...deletedSceneLocalIds]).delete();
        await db.cues.where('sceneId').anyOf([...deletedSceneLocalIds]).delete();
      }
      if (deletedRoleIds.size > 0) await db.roles.bulkDelete([...deletedRoleIds].filter(Boolean));
      if (deletedCueIds.size > 0) await db.cues.bulkDelete([...deletedCueIds].filter(Boolean));
      if (rolePuts.length > 0) await db.roles.bulkPut(rolePuts);
      if (cuePuts.length > 0) await db.cues.bulkPut(cuePuts);

      // 操耍人撤掉：相关角色指派与领奏解绑干净
      if (deletedOperatorLocalIds.size > 0) {
        const boundRoles = await db.roles.where('operatorId').anyOf([...deletedOperatorLocalIds]).toArray();
        if (boundRoles.length > 0) {
          await db.roles.bulkPut(
            boundRoles.map((role) => ({ ...role, operatorId: null, updatedAt: stamp, revision: ROW_REVISION })),
          );
          outcome.unboundRoles += boundRoles.length;
        }
        // leadOperator 未建索引，全表过滤后解绑
        const boundCues = (await db.cues.toArray()).filter(
          (cue) => cue.leadOperator !== null && deletedOperatorLocalIds.has(cue.leadOperator),
        );
        if (boundCues.length > 0) {
          await db.cues.bulkPut(
            boundCues.map((cue) => ({ ...cue, leadOperator: null, updatedAt: stamp, revision: ROW_REVISION })),
          );
          outcome.unboundCues += boundCues.length;
        }
        await db.operators.bulkDelete([...deletedOperatorLocalIds]);
      }

      // 回写实演场次数
      const finalSceneCount = scenePuts.length;
      const playRow = await db.plays.get(playLocalId);
      if (playRow && playRow.totalScenes !== finalSceneCount) {
        await db.plays.put({ ...playRow, totalScenes: finalSceneCount, updatedAt: stamp, revision: ROW_REVISION });
      }

      // 重建全库 assignedRoleIds（双向指派关系与最终结果对齐）
      const allOperators = await db.operators.toArray();
      const allRoles = await db.roles.toArray();
      const rolesByOperator = new Map<string, string[]>();
      allRoles.forEach((role) => {
        if (!role.operatorId) return;
        const list = rolesByOperator.get(role.operatorId) ?? [];
        list.push(role.id);
        rolesByOperator.set(role.operatorId, list);
      });
      const operatorFixups = allOperators
        .map((operator) => {
          const roleIds = rolesByOperator.get(operator.id) ?? [];
          const same = roleIds.length === operator.assignedRoleIds.length &&
            roleIds.every((id) => operator.assignedRoleIds.includes(id));
          return same ? null : { ...operator, assignedRoleIds: roleIds, updatedAt: stamp, revision: ROW_REVISION };
        })
        .filter((row): row is OperatorRow => row !== null);
      if (operatorFixups.length > 0) await db.operators.bulkPut(operatorFixups);

      // 合并成功 → 从最终库重拍「上次交接底稿」，供下次打包
      const finalPlay = await db.plays.get(playLocalId);
      if (finalPlay) {
        const finalScenes = await db.scenes.where('playId').equals(playLocalId).toArray();
        const finalSceneIds = finalScenes.map((scene) => scene.id);
        const [finalRoles, finalCues, finalOperators] = await Promise.all([
          finalSceneIds.length > 0 ? db.roles.where('sceneId').anyOf(finalSceneIds).toArray() : Promise.resolve([] as RoleRow[]),
          finalSceneIds.length > 0 ? db.cues.where('sceneId').anyOf(finalSceneIds).toArray() : Promise.resolve([] as CueRow[]),
          db.operators.toArray(),
        ]);
        await db.handoverBases.put({
          playBizCode: plan.playBizCode,
          updatedAt: stamp,
          baseline: {
            play: finalPlay,
            scenes: finalScenes,
            roles: finalRoles,
            cues: finalCues,
            operators: finalOperators,
          },
        });
      }

      // 整包标记已提交；同一 packageId 重试时计划无差异、不会重复追加
      const session = await db.mergeSessions.get(pkg.packageId);
      if (session) {
        await db.mergeSessions.put({ ...session, status: 'committed', updatedAt: stamp });
      }
    },
  );

  return outcome;
}

/* ------------------------------- 字段求解辅助 ------------------------------- */

function resolveMergedFields(entry: EntityPlan): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(entry.merged ?? {}) };
  entry.conflicts.forEach((conflict) => {
    if (conflict.conflictKind === 'field') {
      if (conflict.resolution === 'local') merged[conflict.field] = conflict.localValue;
      else if (conflict.resolution === 'remote') merged[conflict.field] = conflict.remoteValue;
      return;
    }
    if (conflict.conflictKind === 'array') {
      const meta = (ARRAY_FIELD_META[entry.kind] ?? []).find((item) => item.field === conflict.field);
      if (!meta) return;
      const localItems = toItems(entry.local?.[conflict.field], meta).map((item) => item.raw);
      const remoteItems = toItems(entry.remote?.[conflict.field], meta).map((item) => item.raw);
      merged[conflict.field] = resolveArrayValue(conflict, localItems, remoteItems);
    }
  });
  return merged;
}

function pickScalarFields(
  kind: EntityPlan['kind'],
  merged: Record<string, unknown>,
  exclude: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  FIELD_META[kind].forEach((meta) => {
    if (!exclude.includes(meta.field) && merged[meta.field] !== undefined) {
      out[meta.field] = merged[meta.field];
    }
  });
  (ARRAY_FIELD_META[kind] ?? []).forEach((meta) => {
    if (!exclude.includes(meta.field) && merged[meta.field] !== undefined) {
      out[meta.field] = merged[meta.field];
    }
  });
  return out;
}

/** 把已求解的字段合进行并断言为目标行类型（字段集合由 FIELD_META 保证完整） */
function buildRow<T>(base: Record<string, unknown>, extras: Record<string, unknown>): T {
  return { ...base, ...extras } as T;
}

/** 合并时段：按业务编号稳定映射 id（同包重试不重复） */
function mapBusySlots(merged: BusySlot[] | undefined, fallback: BusySlot[] | undefined, operatorId: string): BusySlot[] {
  const list = merged ?? fallback ?? [];
  return list.map((slot) => ({
    id: slot.bizCode ? stableLocalId('busyslot', `${operatorId}:${slot.bizCode}`) : uuid(),
    bizCode: slot.bizCode,
    weekday: slot.weekday,
    startMinute: slot.startMinute,
    durationMinute: slot.durationMinute,
    label: slot.label,
  }));
}

function bindOperatorId(
  code: string | null,
  operatorIdByCode: Map<string, string>,
  deletedOperatorCodes: Set<string>,
  plan: MergePlan,
): string | null {
  if (!code) return null;
  if (deletedOperatorCodes.has(code)) return null;
  if (plan.danglingOperatorCodes.includes(code)) return null;
  return operatorIdByCode.get(code) ?? null;
}
