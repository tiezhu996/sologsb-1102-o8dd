/**
 * 排演包合并编排服务
 *
 * 职责：
 * 1. 读包 → 取本机当前 → 取底稿（旧包缺底稿时按本机当前记录迁移补齐）→ 生成合并方案并落会话；
 * 2. 保存冲突核对进度；
 * 3. 选定齐全后一次性落盘：按业务编号认关系映射回本机 uuid，绝不用包里（不存在）的 uuid 硬套；
 * 4. 场次 / 操耍人撤掉时，角色指派、锣鼓点、领奏关系级联处理干净；
 * 5. 失败可重试同一包：会话保留整包与已核对进度，成功落盘幂等、不重复追加。
 */
import {
  bumpCountersFromCodes,
  db,
  getMergeSessionByPackage,
  listAllRoles,
  listOperators,
  listScenesByPlay,
  getPlayByCode,
  putHandoverBase,
  putMergeSession,
  type CueRow,
  type MergeReport,
  type MergeSessionRow,
  type OperatorRow,
  type PlayRow,
  type RoleRow,
  type SceneRow,
} from './db';
import type {
  PackageCue,
  PackageOperator,
  PackageRole,
  PackageScene,
  PackageSnapshot,
  RehearsalPackage,
} from '../types/package';
import {
  buildMergedDataset,
  createMergePlan,
  datasetFromSnapshot,
  isPlanResolved,
  planStats,
  type MergeDataset,
  type MergePlan,
  type ResolutionMap,
} from './mergeEngine';
import { loadPlayRows, resetPackageSeries, rowsToSnapshot } from './packageIO';
import { nowIso, uuid } from './uuid';

/** 本机某剧目的包格式快照 */
async function localSnapshot(playCode: string): Promise<PackageSnapshot | null> {
  const play = await getPlayByCode(playCode);
  if (!play) return null;
  const rows = await loadPlayRows(play);
  return rowsToSnapshot(rows);
}

/** 包底稿：优先用包自带 base；缺失时按本机当前记录迁移补齐（旧数据 / 旧包路径） */
async function resolveBaseline(pkg: RehearsalPackage): Promise<{ baseline: PackageSnapshot; migrated: boolean }> {
  if (pkg.base) return { baseline: pkg.base, migrated: false };
  const migrated = await localSnapshot(pkg.current.play.playCode);
  if (!migrated) {
    // 本机也没有这出戏：以空截面为底稿，整包即新增
    return { baseline: { ...pkg.current, scenes: [], roles: [], cues: [], operators: [] }, migrated: true };
  }
  return { baseline: migrated, migrated: true };
}

/** 构造合并方案（纯函数），会话由调用方持久化 */
export async function buildPlanForPackage(
  pkg: RehearsalPackage,
  baselineSnapshot: PackageSnapshot,
  migrated: boolean,
): Promise<MergePlan> {
  const localSnap = (await localSnapshot(pkg.current.play.playCode)) ?? {
    ...pkg.current,
    scenes: [],
    roles: [],
    cues: [],
    operators: [],
  };
  const local = datasetFromSnapshot(localSnap);
  const base = datasetFromSnapshot(baselineSnapshot);
  const remote = datasetFromSnapshot(pkg.current);
  return createMergePlan(
    local,
    base,
    remote,
    {
      packageCode: pkg.packageCode,
      packageLabel: pkg.current.play.title,
      brigadeName: pkg.brigadeName,
      exportedAt: pkg.exportedAt,
      playCode: pkg.current.play.playCode,
    },
    { baselineMigrated: migrated },
  );
}

/**
 * 导入排演包：建立或复用合并会话。
 * 同一 packageCode 的包再次导入（含失败重试）→ 原会话与核对进度原样保留，不重建、不追加。
 */
export async function openSessionForPackage(pkg: RehearsalPackage): Promise<{ session: MergeSessionRow; reused: boolean }> {
  const existing = await getMergeSessionByPackage(pkg.packageCode);
  // 同一包再次导入：未完成的（含失败的）复用会话，进度保留；已完成的直接返回，不重复追加
  if (existing) return { session: existing, reused: true };

  const { baseline, migrated } = await resolveBaseline(pkg);
  await buildPlanForPackage(pkg, baseline, migrated); // 预演一次，让结构错误在入会话前抛出
  const stamp = nowIso();
  const session: MergeSessionRow = {
    id: uuid(),
    packageCode: pkg.packageCode,
    playCode: pkg.current.play.playCode,
    brigadeName: pkg.brigadeName,
    packageJson: pkg,
    status: 'pending',
    resolutions: {},
    baselineSnapshot: baseline,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 1,
  };
  await putMergeSession(session);
  return { session, reused: false };
}

/** 保存冲突核对进度（自动保存） */
export async function saveResolutions(sessionId: string, resolutions: ResolutionMap): Promise<MergeSessionRow> {
  const session = await db.mergeSessions.get(sessionId);
  if (!session) throw new Error('合并会话不存在或已被清理');
  if (session.status === 'applied') return session;
  const next: MergeSessionRow = { ...session, resolutions: { ...resolutions }, updatedAt: nowIso() };
  await putMergeSession(next);
  return next;
}

/** 重算方案（会话内当前数据可能在应用前已变化，每次进入页面按最新数据生成） */
export async function recomputePlan(session: MergeSessionRow): Promise<{ plan: MergePlan; migrated: boolean }> {
  const migrated = session.baselineSnapshot !== null && session.packageJson.base === null;
  const plan = await buildPlanForPackage(session.packageJson, session.baselineSnapshot as PackageSnapshot, migrated);
  return { plan, migrated };
}

export class UnresolvedConflictsError extends Error {
  constructor(public readonly remaining: number) {
    super(`还有 ${remaining} 处冲突未选定`);
    this.name = 'UnresolvedConflictsError';
  }
}

export class SessionAppliedError extends Error {
  constructor() {
    super('该排演包已合并落盘，无需重复应用');
    this.name = 'SessionAppliedError';
  }
}

/**
 * 应用合并（选定齐全后）。
 * - 幂等：已 applied 的会话直接返回原报告；
 * - 失败不留半成品：全部写入在一个 Dexie 事务里；
 * - 成功后刷新该剧目交接底稿 = 合并结果，结束包系列号。
 */
export async function applyMerge(
  sessionId: string,
  resolutions: ResolutionMap,
): Promise<{ session: MergeSessionRow; plan: MergePlan; report: MergeReport }> {
  const session = await db.mergeSessions.get(sessionId);
  if (!session) throw new Error('合并会话不存在或已被清理');
  if (session.status === 'applied' && session.report) {
    const plan = await buildPlanForPackage(
      session.packageJson,
      session.baselineSnapshot as PackageSnapshot,
      session.packageJson.base === null,
    );
    return { session, plan, report: session.report };
  }

  const migrated = session.packageJson.base === null;
  const plan = await buildPlanForPackage(session.packageJson, session.baselineSnapshot as PackageSnapshot, migrated);
  if (!isPlanResolved(plan, resolutions)) {
    throw new UnresolvedConflictsError(countUnresolved(plan, resolutions));
  }

  const merged = buildMergedDataset(plan, resolutions);

  try {
    const report = await persistMerged(session.packageJson.current.play.playCode, merged, plan);
    const stamp = nowIso();
    const done: MergeSessionRow = {
      ...session,
      resolutions: { ...resolutions },
      status: 'applied',
      report,
      errorMessage: undefined,
      updatedAt: stamp,
    };
    await putMergeSession(done);
    await resetPackageSeries(plan.playCode);
    return { session: done, plan, report };
  } catch (error) {
    // 失败：会话保留 pending（或 failed），整包与核对进度不丢，重试不重复追加
    const stamp = nowIso();
    const failed: MergeSessionRow = {
      ...session,
      resolutions: { ...resolutions },
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : '落盘失败',
      updatedAt: stamp,
    };
    await putMergeSession(failed);
    throw error;
  }
}

function countUnresolved(plan: MergePlan, resolutions: ResolutionMap): number {
  const fields = plan.conflicts.filter(
    (conflict) => resolutions[conflict.id] !== 'local' && resolutions[conflict.id] !== 'remote',
  ).length;
  const entities = plan.entityConflicts.filter(
    (conflict) => resolutions[conflict.id] !== 'keep' && resolutions[conflict.id] !== 'delete',
  ).length;
  return fields + entities;
}

/** 把合并结果落盘：按业务编号映射本机 uuid，新增发新 uuid，撤掉的清理 */
async function persistMerged(playCode: string, merged: MergeDataset, plan: MergePlan): Promise<MergeReport> {
  const stats = planStats(plan);
  const warnings = plan.warnings.map((warning) => warning.message);

  await db.transaction(
    'rw',
    [db.plays, db.scenes, db.roles, db.cues, db.operators, db.handoverBases, db.mergeSessions, db.meta],
    async () => {
      const stamp = nowIso();
      const existingPlay = await getPlayByCodeTx(playCode);

      /* ----- 剧目 ----- */
      let playId = existingPlay?.id ?? uuid();
      if (merged.play) {
        const playRow: PlayRow = {
          id: playId,
          playCode,
          title: merged.play.title,
          genre: merged.play.genre,
          scriptText: merged.play.scriptText,
          totalScenes: merged.play.totalScenes,
          premiereVenue: merged.play.premiereVenue,
          status: merged.play.status,
          createdAt: existingPlay?.createdAt ?? stamp,
          updatedAt: stamp,
          revision: 3,
        };
        await db.plays.put(playRow);
      } else {
        // 剧目整体不存在于合并结果：清理该剧目本机数据
        playId = '';
      }

      /* ----- 操耍人（班社级）：先落库，拿到 业务编号 → 本机 uuid ----- */
      const existingOperators = await db.operators.toArray();
      const operatorIdByCode = new Map(existingOperators.map((row) => [row.operatorCode, row.id]));
      const mergedOperatorCodes = new Set(merged.operators.keys());
      // 操耍人是班社级档案（包里是全量快照）：只处理「包覆盖到（底稿/包内有）」的人，
      // 绝不误删本机另有、包没覆盖的人；覆盖到却在最终结果里消失 = 班社撤了此人，
      // 全局解绑所有剧目的角色指派与鼓点领奏后删行。
      const coveredOperatorCodes = new Set(
        plan.changes.operators
          .filter((change) => change.base !== null || change.remote !== null || change.local !== null)
          .map((change) => change.code),
      );
      const removedOperators = existingOperators.filter(
        (row) => !mergedOperatorCodes.has(row.operatorCode) && coveredOperatorCodes.has(row.operatorCode),
      );
      for (const removed of removedOperators) {
        const boundRoles = await db.roles.where('operatorId').equals(removed.id).toArray();
        if (boundRoles.length > 0) {
          await db.roles.bulkPut(
            boundRoles.map((role) => ({ ...role, operatorId: null, updatedAt: stamp, revision: 3 })),
          );
        }
        const ledCues = await db.cues.where('leadOperator').equals(removed.id).toArray();
        if (ledCues.length > 0) {
          await db.cues.bulkPut(
            ledCues.map((cue) => ({ ...cue, leadOperator: null, updatedAt: stamp, revision: 3 })),
          );
        }
        await db.operators.delete(removed.id);
        operatorIdByCode.delete(removed.operatorCode);
      }
      const operatorRows: OperatorRow[] = [];
      merged.operators.forEach((operator) => {
        const id = operatorIdByCode.get(operator.operatorCode) ?? uuid();
        operatorIdByCode.set(operator.operatorCode, id);
        const existing = existingOperators.find((row) => row.operatorCode === operator.operatorCode);
        operatorRows.push({
          id,
          operatorCode: operator.operatorCode,
          name: operator.name,
          skillTags: [...operator.skillTags],
          busySlots: operator.busySlots.map((slot) => ({
            id: uuid(),
            slotCode: slot.slotCode,
            weekday: slot.weekday,
            startMinute: slot.startMinute,
            durationMinute: slot.durationMinute,
            label: slot.label,
          })),
          assignedRoleIds: existing?.assignedRoleIds ?? [],
          rehearsalHours: operator.rehearsalHours,
          createdAt: existing?.createdAt ?? stamp,
          updatedAt: stamp,
          revision: 3,
        });
      });
      await db.operators.bulkPut(operatorRows);

      if (!playId) {
        // 无剧目场景：只落操耍人变更后结束
        return;
      }

      /* ----- 场次：业务编号 → 本机 uuid ----- */
      const existingScenes = await listScenesByPlayTx(playId);
      const sceneIdByCode = new Map(existingScenes.map((row) => [row.sceneCode, row.id]));
      const mergedSceneCodes = new Set(merged.scenes.keys());
      const removedSceneIds = existingScenes
        .filter((row) => !mergedSceneCodes.has(row.sceneCode))
        .map((row) => row.id);
      if (removedSceneIds.length > 0) {
        await db.roles.where('sceneId').anyOf(removedSceneIds).delete();
        await db.cues.where('sceneId').anyOf(removedSceneIds).delete();
        await db.scenes.bulkDelete(removedSceneIds);
      }
      const sceneRows: SceneRow[] = [];
      merged.scenes.forEach((scene) => {
        const id = sceneIdByCode.get(scene.sceneCode) ?? uuid();
        sceneIdByCode.set(scene.sceneCode, id);
        const existing = existingScenes.find((row) => row.sceneCode === scene.sceneCode);
        sceneRows.push({
          id,
          sceneCode: scene.sceneCode,
          playId,
          seq: scene.seq,
          title: scene.title,
          durationMin: scene.durationMin,
          stageNote: scene.stageNote,
          needsShadowScreen: scene.needsShadowScreen,
          progress: scene.progress,
          createdAt: existing?.createdAt ?? stamp,
          updatedAt: stamp,
          revision: 3,
        });
      });
      await db.scenes.bulkPut(sceneRows);

      /* ----- 角色 ----- */
      const allExistingRoles = await listAllRoles();
      const playSceneIdSetAll = new Set([...sceneIdByCode.values(), ...removedSceneIds]);
      const existingRoles = allExistingRoles.filter((row) => playSceneIdSetAll.has(row.sceneId));
      const mergedSceneIdSet = new Set(sceneRows.map((row) => row.id));
      // 删除：本机属于本剧目的角色，业务编号不在合并结果里（随撤场次的已先清理）
      const mergedRoleCodes = new Set(merged.roles.keys());
      const removedRoles = existingRoles.filter((row) => !mergedRoleCodes.has(row.roleCode));
      if (removedRoles.length > 0) await db.roles.bulkDelete(removedRoles.map((row) => row.id));

      const roleRows: RoleRow[] = [];
      merged.roles.forEach((role) => {
        const sceneId = sceneIdByCode.get(role.sceneCode);
        if (!sceneId || !mergedSceneIdSet.has(sceneId)) return; // 双保险：场次没了角色不留
        const existing = existingRoles.find((row) => row.roleCode === role.roleCode);
        const id = existing?.id ?? uuid();
        roleRows.push({
          id,
          roleCode: role.roleCode,
          sceneId,
          name: role.name,
          roleType: role.roleType,
          propParts: [...role.propParts],
          entranceCue: role.entranceCue,
          lineNote: role.lineNote,
          operatorId: role.operatorCode ? operatorIdByCode.get(role.operatorCode) ?? null : null,
          createdAt: existing?.createdAt ?? stamp,
          updatedAt: stamp,
          revision: 3,
        });
      });
      await db.roles.bulkPut(roleRows);

      /* ----- 锣鼓点 ----- */
      const allExistingCues = await db.cues.toArray();
      const oldPlayCues = allExistingCues.filter((cue) => playSceneIdSetAll.has(cue.sceneId));
      const mergedCueCodes = new Set(merged.cues.keys());
      const removedCueIds = oldPlayCues.filter((row) => !mergedCueCodes.has(row.cueCode)).map((row) => row.id);
      if (removedCueIds.length > 0) await db.cues.bulkDelete(removedCueIds);

      const cueRows: CueRow[] = [];
      merged.cues.forEach((cue) => {
        const sceneId = sceneIdByCode.get(cue.sceneCode);
        if (!sceneId || !mergedSceneIdSet.has(sceneId)) return;
        const existing = allExistingCues.find((row) => row.cueCode === cue.cueCode);
        cueRows.push({
          id: existing?.id ?? uuid(),
          cueCode: cue.cueCode,
          sceneId,
          beatName: cue.beatName,
          instrument: cue.instrument,
          atSecond: cue.atSecond,
          leadOperator: cue.leadOperatorCode ? operatorIdByCode.get(cue.leadOperatorCode) ?? null : null,
          note: cue.note,
          createdAt: existing?.createdAt ?? stamp,
          updatedAt: stamp,
          revision: 3,
        });
      });
      await db.cues.bulkPut(cueRows);

      /* ----- 操耍人 assignedRoleIds 双向同步 ----- */
      const finalPlaySceneIds = new Set(sceneRows.map((row) => row.id));
      const roleIdsByOperator = new Map<string, string[]>();
      roleRows.forEach((role) => {
        if (role.operatorId === null) return;
        const list = roleIdsByOperator.get(role.operatorId) ?? [];
        list.push(role.id);
        roleIdsByOperator.set(role.operatorId, list);
      });
      await Promise.all(
        operatorRows.map(async (operator) => {
          const assigned = roleIdsByOperator.get(operator.id) ?? [];
          // 这出戏之外的指派保留：从现存角色里补齐别戏的
          const otherAssigned = (await db.roles.where('operatorId').equals(operator.id).toArray())
            .filter((role) => !finalPlaySceneIds.has(role.sceneId))
            .map((role) => role.id);
          const nextAssigned = Array.from(new Set([...assigned, ...otherAssigned]));
          const same =
            nextAssigned.length === operator.assignedRoleIds.length &&
            nextAssigned.every((id) => operator.assignedRoleIds.includes(id));
          if (!same) {
            await db.operators.put({ ...operator, assignedRoleIds: nextAssigned });
          }
        }),
      );

      /* ----- 场次总数兜底 ----- */
      if (merged.play) {
        const finalPlay = await db.plays.get(playId);
        if (finalPlay && finalPlay.totalScenes !== sceneRows.length) {
          await db.plays.put({ ...finalPlay, totalScenes: sceneRows.length, updatedAt: stamp, revision: 3 });
        }
      }

      /* ----- 刷新交接底稿 = 合并结果（去掉本机 id） ----- */
      const finalPlay = await db.plays.get(playId);
      if (finalPlay) {
        const finalRows = await loadPlayRowsTx(finalPlay);
        const snapshot = rowsToSnapshot(finalRows);
        await putHandoverBase({ playCode, snapshot, updatedAt: stamp });
      }

      // 顶号：合入的异机业务编号可能比本机计数器大，避免后续本机发号撞号
      await bumpCountersFromCodes({
        play: merged.play ? [merged.play.playCode] : [],
        scene: [...merged.scenes.keys()],
        role: [...merged.roles.keys()],
        cue: [...merged.cues.keys()],
        operator: [...merged.operators.keys()],
        slot: [...merged.operators.values()].flatMap((op) => op.busySlots.map((slot) => slot.slotCode)),
      });
    },
  );

  const report: MergeReport = {
    adds: stats.adds,
    updates: stats.updates,
    deletes: stats.deletes,
    fieldConflicts: stats.fieldConflicts,
    entityConflicts: stats.entityConflicts,
    warnings,
    baselineMigrated: plan.baselineMigrated,
    appliedAt: nowIso(),
  };
  return report;
}

/* ----- 事务内读取辅助（Dexie 事务内复用连接） ----- */

async function getPlayByCodeTx(playCode: string): Promise<PlayRow | undefined> {
  return db.plays.where('playCode').equals(playCode).first();
}

async function listScenesByPlayTx(playId: string): Promise<SceneRow[]> {
  const rows = await db.scenes.where('playId').equals(playId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

async function loadPlayRowsTx(play: PlayRow): Promise<{
  play: PlayRow;
  scenes: SceneRow[];
  roles: RoleRow[];
  cues: CueRow[];
  operators: OperatorRow[];
}> {
  const scenes = await listScenesByPlay(play.id);
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const [roles, cues, operators] = await Promise.all([
    listAllRoles(),
    db.cues.toArray(),
    listOperators(),
  ]);
  return {
    play,
    scenes,
    roles: roles.filter((role) => sceneIds.has(role.sceneId)),
    cues: cues.filter((cue) => sceneIds.has(cue.sceneId)),
    operators,
  };
}

/** 会话清理 */
export async function discardSession(sessionId: string): Promise<void> {
  await db.mergeSessions.delete(sessionId);
}

/** 包内行类型供 UI 使用 */
export type { PackageScene, PackageRole, PackageCue, PackageOperator };
