/**
 * 排演包的打包、解析与结构规整
 * - 打包时把本机 uuid 外键翻译成业务编号（playBizCode / sceneBizCode / operatorBizCode…），
 *   两台机器编号不同也能认关系，绝不硬套对方 uuid
 * - 解析时容忍旧格式（v2 存档无 bizCode / 无 bizCode 外键）：按当前记录迁移补齐
 */
import type { Play } from '../types/play';
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator, BusySlot } from '../types/operator';
import type { PercussionCue } from '../types/cue';
import type { HandoverBaseline, RehearsalPackage } from '../types/rehearsalPackage';

export const PACKAGE_KIND = 'gbshadowplay-rehearsal-package';
export const PACKAGE_VERSION = 1;

export class PackageFormatError extends Error {}

/** 包内的传输形态：外键一律用业务编号，并保留本机 uuid 供同机往返 */
export type PlayPayload = Play;
export interface ScenePayload extends Omit<Scene, 'playId'> {
  playId: string | null;
  playBizCode: string;
}
export interface RolePayload extends Omit<ShadowRole, 'sceneId' | 'operatorId'> {
  sceneId: string | null;
  operatorId: string | null;
  sceneBizCode: string;
  operatorBizCode: string | null;
}
export interface CuePayload extends Omit<PercussionCue, 'sceneId' | 'leadOperator'> {
  sceneId: string | null;
  leadOperator: string | null;
  sceneBizCode: string;
  leadOperatorBizCode: string | null;
}
export interface OperatorPayload extends Operator {
  busySlots: Array<BusySlot>;
}

export interface BaselinePayload {
  play: PlayPayload;
  scenes: ScenePayload[];
  roles: RolePayload[];
  cues: CuePayload[];
  operators: OperatorPayload[];
}

/** enrich 后供合并引擎消费的视图：外键用业务编号 */
export interface SceneView extends Scene {
  playBizCode?: string;
}
export interface RoleView extends ShadowRole {
  sceneBizCode?: string;
  operatorBizCode?: string | null;
}
export interface CueView extends PercussionCue {
  sceneBizCode?: string;
  leadOperatorBizCode?: string | null;
}
export interface BaselineView {
  play: Play;
  scenes: SceneView[];
  roles: RoleView[];
  cues: CueView[];
  operators: Operator[];
}
export interface RehearsalPackageView extends Omit<RehearsalPackage, 'baseline' | 'current'> {
  baseline: BaselineView | null;
  current: BaselineView;
}

export interface RehearsalPackagePayload {
  kind: typeof PACKAGE_KIND;
  packageVersion: number;
  packageId: string;
  detachmentName: string;
  createdAt: string;
  playBizCode: string;
  baseline: BaselinePayload | null;
  current: BaselinePayload;
}

/* ---------------------------------- 打包 ---------------------------------- */

interface PackSource {
  play: Play;
  scenes: HandoverBaseline['scenes'];
  roles: HandoverBaseline['roles'];
  cues: HandoverBaseline['cues'];
  operators: Operator[];
}

/** 把本机记录翻译成排演包载荷（uuid 外键 → 业务编号） */
export function toBaselinePayload(source: PackSource): BaselinePayload {
  const operatorCodeById = new Map(source.operators.map((operator) => [operator.id, operator.bizCode]));

  return {
    play: source.play,
    scenes: source.scenes.map((scene) => ({
      ...scene,
      playId: scene.playId,
      playBizCode: source.play.bizCode,
    })),
    roles: source.roles.map((role) => {
      const sceneCode =
        role.sceneBizCode ||
        source.scenes.find((scene) => scene.id === role.sceneId)?.bizCode ||
        inferSceneCodeFromRole(role.bizCode);
      // 已有业务编号（如指向已不存在的操耍人）优先保留，避免悬挂指派在打包时被抹掉
      const operatorBizCode =
        role.operatorBizCode !== undefined
          ? role.operatorBizCode
          : role.operatorId
            ? (operatorCodeById.get(role.operatorId) ?? null)
            : null;
      return {
        ...role,
        sceneId: role.sceneId,
        sceneBizCode: sceneCode,
        operatorId: role.operatorId,
        operatorBizCode,
      };
    }),
    cues: source.cues.map((cue) => {
      const sceneCode =
        cue.sceneBizCode ||
        source.scenes.find((scene) => scene.id === cue.sceneId)?.bizCode ||
        inferSceneCodeFromCue(cue.bizCode);
      const leadOperatorBizCode =
        cue.leadOperatorBizCode !== undefined
          ? cue.leadOperatorBizCode
          : cue.leadOperator
            ? (operatorCodeById.get(cue.leadOperator) ?? null)
            : null;
      return {
        ...cue,
        sceneId: cue.sceneId,
        sceneBizCode: sceneCode,
        leadOperator: cue.leadOperator,
        leadOperatorBizCode,
      };
    }),
    operators: source.operators.map((operator) => ({ ...operator })),
  };
}

function inferSceneCodeFromRole(roleCode: string): string {
  const idx = roleCode.indexOf('-R');
  return idx > 0 ? roleCode.slice(0, idx) : roleCode;
}

function inferSceneCodeFromCue(cueCode: string): string {
  const idx = cueCode.indexOf('-C');
  return idx > 0 ? cueCode.slice(0, idx) : cueCode;
}

/** 组装排演包文件内容 */
export function buildPackage(params: {
  packageId: string;
  detachmentName: string;
  baseline: HandoverBaseline | null;
  current: HandoverBaseline;
}): RehearsalPackagePayload {
  return {
    kind: PACKAGE_KIND,
    packageVersion: PACKAGE_VERSION,
    packageId: params.packageId,
    detachmentName: params.detachmentName.trim() || '未具名分队',
    createdAt: new Date().toISOString(),
    playBizCode: params.current.play.bizCode,
    baseline: params.baseline ? toBaselinePayload(params.baseline) : null,
    current: toBaselinePayload(params.current),
  };
}

/* ---------------------------------- 解析 ---------------------------------- */

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(row: Record<string, unknown>, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

function num(row: Record<string, unknown>, key: string, fallback = 0): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

function strArray(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 解析并校验排演包；旧格式缺字段时尽量按当前记录迁移补齐，解析不了才抛错 */
export function parsePackage(raw: unknown): RehearsalPackage {
  const root = asObject(raw);
  if (root.kind !== PACKAGE_KIND) {
    throw new PackageFormatError('不是皮影排演包文件（缺少排演包标识）');
  }
  const current = parseBaseline(asObject(root.current));
  if (!current.play) {
    throw new PackageFormatError('排演包内缺少剧目记录');
  }
  const playBizCode = str(root, 'playBizCode') || current.play.bizCode;
  return {
    kind: PACKAGE_KIND,
    packageVersion: Number(root.packageVersion ?? PACKAGE_VERSION),
    packageId: str(root, 'packageId') || `${playBizCode}-${str(root, 'createdAt') || Date.now()}`,
    detachmentName: str(root, 'detachmentName', '未具名分队'),
    createdAt: str(root, 'createdAt'),
    playBizCode,
    baseline: root.baseline ? parseBaseline(asObject(root.baseline)) : null,
    current,
  };
}

function parseBaseline(node: Record<string, unknown>): HandoverBaseline {
  const playNode = asObject(node.play);
  const play: Play = {
    id: str(playNode, 'id'),
    bizCode: str(playNode, 'bizCode'),
    title: str(playNode, 'title', '未命名剧目'),
    genre: (str(playNode, 'genre', 'traditional') as Play['genre']),
    scriptText: str(playNode, 'scriptText'),
    totalScenes: num(playNode, 'totalScenes', 0),
    premiereVenue: str(playNode, 'premiereVenue'),
    status: (str(playNode, 'status', 'preparing') as Play['status']),
    createdAt: str(playNode, 'createdAt'),
    updatedAt: str(playNode, 'updatedAt'),
  };

  const scenes = asArray(node.scenes).map((item) => {
    const row = asObject(item);
    return {
      id: str(row, 'id'),
      bizCode: str(row, 'bizCode'),
      playId: str(row, 'playId'),
      playBizCode: str(row, 'playBizCode'),
      seq: num(row, 'seq', 1),
      title: str(row, 'title'),
      durationMin: num(row, 'durationMin', 12),
      stageNote: str(row, 'stageNote'),
      needsShadowScreen: str(row, 'needsShadowScreen', 'standard') as Scene['needsShadowScreen'],
      progress: Math.max(0, Math.min(100, num(row, 'progress', 0))),
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  });

  const operators: Operator[] = asArray(node.operators).map((item) => {
    const row = asObject(item);
    const busySlots: BusySlot[] = asArray(row.busySlots).map((slotItem, index) => {
      const slot = asObject(slotItem);
      return {
        id: str(slot, 'id'),
        bizCode: str(slot, 'bizCode') || `${str(row, 'bizCode')}-B${String(index + 1).padStart(2, '0')}`,
        weekday: num(slot, 'weekday', 1) as BusySlot['weekday'],
        startMinute: num(slot, 'startMinute', 0),
        durationMinute: num(slot, 'durationMinute', 120),
        label: str(slot, 'label', '排练'),
      };
    });
    return {
      id: str(row, 'id'),
      bizCode: str(row, 'bizCode'),
      name: str(row, 'name', '未具名师傅'),
      skillTags: strArray(row, 'skillTags') as Operator['skillTags'],
      busySlots,
      assignedRoleIds: strArray(row, 'assignedRoleIds'),
      rehearsalHours: num(row, 'rehearsalHours', 0),
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  });

  const roles = asArray(node.roles).map((item) => {
    const row = asObject(item);
    return {
      id: str(row, 'id'),
      bizCode: str(row, 'bizCode'),
      sceneId: str(row, 'sceneId'),
      sceneBizCode: str(row, 'sceneBizCode'),
      name: str(row, 'name'),
      roleType: str(row, 'roleType', 'dan') as ShadowRole['roleType'],
      propParts: strArray(row, 'propParts') as ShadowRole['propParts'],
      entranceCue: str(row, 'entranceCue'),
      lineNote: str(row, 'lineNote'),
      operatorId: typeof row.operatorId === 'string' ? str(row, 'operatorId') : null,
      operatorBizCode: typeof row.operatorBizCode === 'string' ? str(row, 'operatorBizCode') : null,
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  });

  const cues = asArray(node.cues).map((item) => {
    const row = asObject(item);
    return {
      id: str(row, 'id'),
      bizCode: str(row, 'bizCode'),
      sceneId: str(row, 'sceneId'),
      sceneBizCode: str(row, 'sceneBizCode'),
      beatName: str(row, 'beatName', 'sijitou') as PercussionCue['beatName'],
      instrument: str(row, 'instrument', 'bangu') as PercussionCue['instrument'],
      atSecond: Math.max(0, num(row, 'atSecond', 0)),
      leadOperator: typeof row.leadOperator === 'string' ? str(row, 'leadOperator') : null,
      leadOperatorBizCode: typeof row.leadOperatorBizCode === 'string' ? str(row, 'leadOperatorBizCode') : null,
      note: str(row, 'note'),
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  });

  return { play, scenes, roles, cues, operators };
}

/**
 * 给解析出的包补业务编号外键与缺失编号（旧包迁移）：
 * sceneBizCode / operatorBizCode / leadOperatorBizCode 不全时，
 * 用载荷内的 uuid 外键映射，再退化到从业务编号推断。
 */
export function enrichPackage(pkg: RehearsalPackage): RehearsalPackageView {
  const enrichBaseline = (baseline: HandoverBaseline | null): BaselineView | null => {
    if (!baseline) return null;
    const sceneCodeById = new Map(baseline.scenes.map((scene) => [scene.id, scene.bizCode]));
    const operatorCodeById = new Map(baseline.operators.map((operator) => [operator.id, operator.bizCode]));

    const scenes: SceneView[] = baseline.scenes.map((scene) => ({ ...scene, playBizCode: baseline.play.bizCode }));
    const roles: RoleView[] = baseline.roles.map((role) => {
      // 载荷自带的业务编号优先（可能指向本机操耍人档中不存在的人，需保留以触发解绑告警）
      const sceneBizCode =
        (role as RoleView).sceneBizCode || sceneCodeById.get(role.sceneId) || inferSceneCodeFromRole(role.bizCode);
      const operatorBizCode =
        (role as RoleView).operatorBizCode !== undefined
          ? (role as RoleView).operatorBizCode
          : role.operatorId
            ? (operatorCodeById.get(role.operatorId) ?? null)
            : null;
      return { ...role, sceneBizCode, operatorBizCode };
    });
    const cues: CueView[] = baseline.cues.map((cue) => {
      const sceneBizCode =
        (cue as CueView).sceneBizCode || sceneCodeById.get(cue.sceneId) || inferSceneCodeFromCue(cue.bizCode);
      const leadOperatorBizCode =
        (cue as CueView).leadOperatorBizCode !== undefined
          ? (cue as CueView).leadOperatorBizCode
          : cue.leadOperator
            ? (operatorCodeById.get(cue.leadOperator) ?? null)
            : null;
      return { ...cue, sceneBizCode, leadOperatorBizCode };
    });
    return { play: baseline.play, scenes, roles, cues, operators: baseline.operators };
  };

  const current = enrichBaseline(pkg.current);
  if (!current) throw new PackageFormatError('排演包缺少改动记录');
  return {
    ...pkg,
    baseline: enrichBaseline(pkg.baseline),
    current,
  };
}
