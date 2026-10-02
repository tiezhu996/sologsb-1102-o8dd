/**
 * 排演包服务：打包、开包、合并会话与核对进度的持久化
 * - 会话主键 = packageId：合并失败后重试同一包，整包与已核对进度都保留，不重复追加
 * - 首次打包没有历史底稿时，以当前记录作为底稿落库（remote 与 base 一致，不会产生虚假差异）
 */
import {
  db,
  getHandoverBase,
  getMergeSession,
  listMergeSessions,
  putHandoverBase,
  putMergeSession,
  removeMergeSession,
  type CueRow,
  type OperatorRow,
  type PlayRow,
  type RoleRow,
  type SceneRow,
} from '../utils/db';
import { nowIso, uuid } from '../utils/uuid';
import {
  buildPackage,
  enrichPackage,
  parsePackage,
  PackageFormatError,
  type RehearsalPackagePayload,
  type RehearsalPackageView,
} from './packageIO';
import { applyResolutions, buildMergePlan, unresolvedConflictCount, type MergePlan } from './mergeEngine';
import { commitMerge, loadLocalScope, type LocalScope } from './commitMerge';
import type {
  ArrayPolicy,
  DeletePolicy,
  FieldSide,
  MergeOutcome,
  MergeSessionRecord,
  RehearsalPackage,
} from '../types/rehearsalPackage';

export { PackageFormatError };

/** 打包所需的本机范围（剧目 + 其下场次/角色/锣鼓点 + 全档操耍人） */
async function loadScopeByPlayId(playId: string) {
  const play = await db.plays.get(playId);
  if (!play) throw new Error('未找到该剧目');
  const scenes = await db.scenes.where('playId').equals(playId).toArray();
  const sceneIds = scenes.map((scene) => scene.id);
  const [roles, cues, operators] = await Promise.all([
    sceneIds.length > 0 ? db.roles.where('sceneId').anyOf(sceneIds).toArray() : Promise.resolve([] as RoleRow[]),
    sceneIds.length > 0 ? db.cues.where('sceneId').anyOf(sceneIds).toArray() : Promise.resolve([] as CueRow[]),
    db.operators.toArray(),
  ]);
  return { play, scenes, roles, cues, operators };
}

export interface BuiltPackage {
  payload: RehearsalPackagePayload;
  packageId: string;
}

/** 为分队打排演包：含上次交接底稿 + 这次改动（当前记录） */
export async function createRehearsalPackage(playId: string, detachmentName: string): Promise<BuiltPackage> {
  const scope = await loadScopeByPlayId(playId);
  const existingBase = await getHandoverBase(scope.play.bizCode);

  // 首次打包：以当前记录作为底稿落库，保证三向合并有 base 可比
  if (!existingBase) {
    await putHandoverBase({
      playBizCode: scope.play.bizCode,
      updatedAt: nowIso(),
      baseline: {
        play: scope.play,
        scenes: scope.scenes,
        roles: scope.roles,
        cues: scope.cues,
        operators: scope.operators,
      },
    });
  }

  const payload = buildPackage({
    packageId: uuid(),
    detachmentName,
    baseline: existingBase?.baseline ?? {
      play: scope.play,
      scenes: scope.scenes,
      roles: scope.roles,
      cues: scope.cues,
      operators: scope.operators,
    },
    current: {
      play: scope.play,
      scenes: scope.scenes,
      roles: scope.roles,
      cues: scope.cues,
      operators: scope.operators,
    },
  });
  return { payload, packageId: payload.packageId };
}

/** 打开排演包文件内容：解析 + 旧包迁移补齐 + 找回/建立合并会话 */
export async function openRehearsalPackage(rawText: string): Promise<{
  pkg: RehearsalPackageView;
  session: MergeSessionRecord;
  plan: MergePlan;
  scope: LocalScope;
  reopened: boolean;
}> {
  let parsed: RehearsalPackage;
  try {
    parsed = parsePackage(JSON.parse(rawText));
  } catch (error) {
    if (error instanceof PackageFormatError) throw error;
    throw new PackageFormatError(error instanceof Error ? `排演包无法解析：${error.message}` : '排演包无法解析');
  }
  const pkg = enrichPackage(parsed);

  const scope = await loadLocalScope(pkg.playBizCode);
  const existing = await getMergeSession(pkg.packageId);
  const reopened = Boolean(existing);
  const session: MergeSessionRecord =
    existing ??
    ({
      id: pkg.packageId,
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      detachmentName: pkg.detachmentName,
      playBizCode: pkg.playBizCode,
      pkg: parsed,
      resolutions: {},
      lastSummary: null,
    } satisfies MergeSessionRecord);
  if (!existing) await putMergeSession(session);

  const plan = applyResolutions(buildMergePlan(scope, pkg), session.resolutions);
  session.lastSummary = {
    total: plan.entries.length,
    conflicts: unresolvedConflictCount(plan),
  };
  return { pkg, session, plan, scope, reopened };
}

/** 保存某条冲突的核对选择（随选随存，中断/失败后进度不丢） */
export async function saveResolution(params: {
  sessionId: string;
  key: string;
  value: FieldSide | ArrayPolicy | DeletePolicy;
}): Promise<void> {
  const session = await getMergeSession(params.sessionId);
  if (!session || session.status === 'committed') return;
  session.resolutions[params.key] = params.value;
  session.updatedAt = nowIso();
  await putMergeSession(session);
}

/** 提交合并：全部冲突核对完后一次性写入；成功标记整包已提交 */
export async function submitMerge(
  session: MergeSessionRecord,
  plan: MergePlan,
  pkg: RehearsalPackageView,
  scope: LocalScope,
): Promise<MergeOutcome> {
  const outcome = await commitMerge(plan, pkg, scope);
  const latest = await getMergeSession(session.id);
  if (latest) {
    await putMergeSession({ ...latest, status: 'committed', updatedAt: nowIso() });
  }
  return outcome;
}

/** 放弃合并：整包保留为已放弃，可日后查档，但不再参与合并 */
export async function abandonMerge(sessionId: string): Promise<void> {
  const session = await getMergeSession(sessionId);
  if (!session || session.status === 'committed') return;
  await putMergeSession({ ...session, status: 'abandoned', updatedAt: nowIso() });
}

/** 从历史会话重新打开同一包（重试）：已核对进度与整包都保留 */
export async function reopenSession(sessionId: string): Promise<{
  pkg: RehearsalPackageView;
  session: MergeSessionRecord;
  plan: MergePlan;
  scope: LocalScope;
}> {
  const session = await getMergeSession(sessionId);
  if (!session) throw new Error('合并记录已不存在');
  const pkg = enrichPackage(session.pkg);
  const scope = await loadLocalScope(pkg.playBizCode);
  const plan = applyResolutions(buildMergePlan(scope, pkg), session.resolutions);
  return { pkg, session, plan, scope };
}

export async function fetchMergeSessions(): Promise<MergeSessionRecord[]> {
  return listMergeSessions();
}

export async function deleteMergeSession(sessionId: string): Promise<void> {
  await removeMergeSession(sessionId);
}

/** 排演包文件名 */
export function packageFileName(payload: RehearsalPackagePayload): string {
  const date = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `排演包-${payload.detachmentName}-${payload.playBizCode}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`;
}

/** 触发排演包下载 */
export function downloadPackage(payload: RehearsalPackagePayload): string {
  const filename = packageFileName(payload);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return filename;
}

export type {
  CueRow,
  OperatorRow,
  PlayRow,
  RoleRow,
  SceneRow,
};
