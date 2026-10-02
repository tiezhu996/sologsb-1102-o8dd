/**
 * 排演包的构建与解析
 *
 * - 构建：从本机 IndexedDB 读取剧目全量数据 → 剥掉本机 uuid → 包内只留业务编号；
 *   base 取「上次交接底稿」，同一交接周期重复导出时 packageCode 保持稳定。
 * - 解析：校验包格式与归属关系（所有 sceneCode/roleCode/cueCode/operatorCode 必须能对上）。
 */
import {
  db,
  getHandoverBase,
  listAllRoles,
  listCuesByScene,
  listOperators,
  listScenesByPlay,
  getPlay,
  type CueRow,
  type OperatorRow,
  type PlayRow,
  type RoleRow,
  type SceneRow,
} from './db';
import type { BusySlot } from '../types/operator';
import {
  PACKAGE_KIND,
  PACKAGE_VERSION,
  type PackageCue,
  type PackageOperator,
  type PackagePlay,
  type PackageRole,
  type PackageScene,
  type PackageValidationIssue,
  type RehearsalPackage,
} from '../types/package';
import { nowIso } from './uuid';

/** 同一剧目的导出版本周期标识：底稿更新前重复导出保持同 packageCode */
const PACKAGE_SERIES_PREFIX = 'series:';

function playToPackage(row: PlayRow): PackagePlay {
  return {
    playCode: row.playCode,
    title: row.title,
    genre: row.genre,
    scriptText: row.scriptText,
    totalScenes: row.totalScenes,
    premiereVenue: row.premiereVenue,
    status: row.status,
  };
}

function sceneToPackage(row: SceneRow): PackageScene {
  return {
    sceneCode: row.sceneCode,
    playCode: '', // 由调用方填（它知道所属剧目 playCode）
    seq: row.seq,
    title: row.title,
    durationMin: row.durationMin,
    stageNote: row.stageNote,
    needsShadowScreen: row.needsShadowScreen,
    progress: row.progress,
  };
}

function roleToPackage(row: RoleRow, sceneCodeById: Map<string, string>): PackageRole {
  return {
    roleCode: row.roleCode,
    sceneCode: sceneCodeById.get(row.sceneId) ?? '',
    name: row.name,
    roleType: row.roleType,
    propParts: [...row.propParts],
    entranceCue: row.entranceCue,
    lineNote: row.lineNote,
    operatorCode: null, // 由调用方按 operatorCodeById 填
  };
}

function cueToPackage(row: CueRow, sceneCodeById: Map<string, string>): PackageCue {
  return {
    cueCode: row.cueCode,
    sceneCode: sceneCodeById.get(row.sceneId) ?? '',
    beatName: row.beatName,
    instrument: row.instrument,
    atSecond: row.atSecond,
    leadOperatorCode: null,
    note: row.note,
  };
}

function slotToPackage(slot: BusySlot) {
  return {
    slotCode: slot.slotCode ?? '',
    weekday: slot.weekday,
    startMinute: slot.startMinute,
    durationMinute: slot.durationMinute,
    label: slot.label,
  };
}

function operatorToPackage(row: OperatorRow): PackageOperator {
  return {
    operatorCode: row.operatorCode,
    name: row.name,
    skillTags: [...row.skillTags],
    busySlots: row.busySlots.map(slotToPackage),
    rehearsalHours: row.rehearsalHours,
  };
}

export interface SnapshotRows {
  play: PlayRow;
  scenes: SceneRow[];
  roles: RoleRow[];
  cues: CueRow[];
  operators: OperatorRow[];
}

/** 本机行 → 包快照（去掉全部本机 uuid 外键） */
export function rowsToSnapshot(rows: SnapshotRows): import('../types/package').PackageSnapshot {
  const { play, scenes, roles, cues, operators } = rows;
  const sceneCodeById = new Map(scenes.map((scene) => [scene.id, scene.sceneCode]));
  const operatorCodeById = new Map(operators.map((operator) => [operator.id, operator.operatorCode]));
  return {
    play: playToPackage(play),
    scenes: scenes.map((scene) => ({ ...sceneToPackage(scene), playCode: play.playCode })),
    roles: roles.map((role) => ({
      ...roleToPackage(role, sceneCodeById),
      operatorCode: role.operatorId ? operatorCodeById.get(role.operatorId) ?? null : null,
    })),
    cues: cues.map((cue) => ({
      ...cueToPackage(cue, sceneCodeById),
      leadOperatorCode: cue.leadOperator ? operatorCodeById.get(cue.leadOperator) ?? null : null,
    })),
    operators: operators.map(operatorToPackage),
  };
}

/** 读取本机某剧目的全量行（含班社全部操耍人档） */
export async function loadPlayRows(play: PlayRow): Promise<SnapshotRows> {
  const scenes = await listScenesByPlay(play.id);
  const sceneIds = scenes.map((scene) => scene.id);
  const [allRoles, operators] = await Promise.all([listAllRoles(), listOperators()]);
  const roles = allRoles.filter((role) => sceneIds.includes(role.sceneId));
  const cueLists = await Promise.all(sceneIds.map((sceneId) => listCuesByScene(sceneId)));
  const cues = cueLists.flat();
  return { play, scenes, roles, cues, operators };
}

/** 生成 / 复用包业务编号：同一交接周期（底稿未刷新）重复导出不换号 */
async function nextPackageCode(playCode: string): Promise<string> {
  const key = PACKAGE_SERIES_PREFIX + playCode;
  const existing = await db.meta.get(key);
  if (typeof existing?.value === 'string') return existing.value;
  const date = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const code = `BAO-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
  await db.meta.put({ key, value: code });
  return code;
}

/** 合并成功后调用：结束本导出周期，下次导出换新包号 */
export async function resetPackageSeries(playCode: string): Promise<void> {
  await db.meta.delete(PACKAGE_SERIES_PREFIX + playCode);
}

export interface BuildPackageInput {
  playId: string;
  brigadeName: string;
  note?: string;
}

/** 导出分队排演包（base = 上次交接底稿，current = 本机当前） */
export async function buildRehearsalPackage(input: BuildPackageInput): Promise<RehearsalPackage> {
  const play = await getPlay(input.playId);
  if (!play) throw new Error('剧目不存在，无法导出排演包');
  const rows = await loadPlayRows(play);
  const current = rowsToSnapshot(rows);
  const baseRow = await getHandoverBase(play.playCode);
  const packageCode = await nextPackageCode(play.playCode);
  return {
    kind: PACKAGE_KIND,
    packageVersion: PACKAGE_VERSION,
    packageCode,
    brigadeName: input.brigadeName.trim() || '未具名分队',
    note: (input.note ?? '').trim(),
    exportedAt: nowIso(),
    base: baseRow ? cloneSnapshot(baseRow.snapshot) : null,
    current,
  };
}

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 触发浏览器下载（与 export.ts 保持同一实现，包文件单独走 .rpk.json 便于辨认） */
function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** 构建并下载排演包 */
export async function exportRehearsalPackageFile(input: BuildPackageInput): Promise<{ filename: string; pkg: RehearsalPackage }> {
  const pkg = await buildRehearsalPackage(input);
  const safeName = pkg.current.play.title.replace(/[\\/:*?"<>|]/g, '_');
  const filename = `排演包-${safeName}-${pkg.brigadeName}-${pkg.packageCode}.rpk.json`;
  download(filename, JSON.stringify(pkg, null, 2));
  return { filename, pkg };
}

/** 解析并校验排演包文件文本 */
export function parseRehearsalPackage(text: string): { pkg?: RehearsalPackage; issues: PackageValidationIssue[] } {
  const issues: PackageValidationIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { issues: [{ level: 'error', message: '文件不是合法 JSON' }] };
  }
  const pkg = parsed as Partial<RehearsalPackage>;
  if (!pkg || typeof pkg !== 'object') {
    return { issues: [{ level: 'error', message: '包内容为空' }] };
  }
  if (pkg.kind !== PACKAGE_KIND) {
    issues.push({ level: 'error', message: `包标识不正确（应为 ${PACKAGE_KIND}），可能不是排演包文件` });
  }
  if (typeof pkg.packageVersion !== 'number') {
    issues.push({ level: 'warning', message: '包缺少结构版本号，按最新结构尝试读取' });
  } else if (pkg.packageVersion > PACKAGE_VERSION) {
    issues.push({ level: 'error', message: `包结构版本 v${pkg.packageVersion} 比本机 v${PACKAGE_VERSION} 新，请先升级应用` });
  }
  if (typeof pkg.packageCode !== 'string' || pkg.packageCode === '') {
    issues.push({ level: 'error', message: '包缺少 packageCode，无法做幂等去重' });
  }
  if (!pkg.current || typeof pkg.current !== 'object') {
    issues.push({ level: 'error', message: '包缺少 current（这次改动截面）' });
    return { issues };
  }
  issues.push(...validateSnapshot(pkg.current, 'current'));
  if (pkg.base !== null && pkg.base !== undefined) {
    issues.push(...validateSnapshot(pkg.base, 'base'));
  }
  return { pkg: pkg as RehearsalPackage, issues };
}

/** 校验快照内归属关系全部通过业务编号闭环 */
export function validateSnapshot(
  snapshot: unknown,
  section: 'current' | 'base',
): PackageValidationIssue[] {
  const issues: PackageValidationIssue[] = [];
  const s = snapshot as Partial<import('../types/package').PackageSnapshot>;
  if (!s || typeof s !== 'object' || !s.play) {
    issues.push({ level: 'error', message: `${section} 缺少剧目行` });
    return issues;
  }
  const playCode = s.play.playCode;
  const sceneCodes = new Set((s.scenes ?? []).map((row) => row.sceneCode));
  const operatorCodes = new Set((s.operators ?? []).map((row) => row.operatorCode));
  const addErr = (message: string): void => {
    issues.push({ level: 'error', message: `[${section}] ${message}` });
  };

  if (!playCode) addErr('剧目缺少 playCode');
  (s.scenes ?? []).forEach((row) => {
    if (row.playCode !== playCode) addErr(`场次「${row.title}」的 playCode 与剧目不一致`);
    if (!row.sceneCode) addErr(`场次「${row.title}」缺少 sceneCode`);
  });
  const sceneCodeCount = new Map<string, number>();
  (s.scenes ?? []).forEach((row) => sceneCodeCount.set(row.sceneCode, (sceneCodeCount.get(row.sceneCode) ?? 0) + 1));
  sceneCodeCount.forEach((count, code) => {
    if (count > 1) addErr(`场次编号 ${code} 重复出现 ${count} 次`);
  });
  (s.roles ?? []).forEach((row) => {
    if (!sceneCodes.has(row.sceneCode)) addErr(`角色「${row.name}」挂在不存在的场次 ${row.sceneCode} 上`);
    if (row.operatorCode !== null && !operatorCodes.has(row.operatorCode)) {
      addErr(`角色「${row.name}」指派给了不存在的操耍人 ${row.operatorCode}`);
    }
  });
  (s.cues ?? []).forEach((row) => {
    if (!sceneCodes.has(row.sceneCode)) addErr(`锣鼓点 ${row.cueCode} 挂在不存在的场次 ${row.sceneCode} 上`);
    if (row.leadOperatorCode !== null && !operatorCodes.has(row.leadOperatorCode)) {
      addErr(`锣鼓点 ${row.cueCode} 的领奏指向不存在的操耍人 ${row.leadOperatorCode}`);
    }
  });
  (s.operators ?? []).forEach((operator) => {
    const slotCodes = new Set<string>();
    operator.busySlots.forEach((slot) => {
      if (!slot.slotCode) addErr(`操耍人「${operator.name}」有档期缺少 slotCode`);
      else if (slotCodes.has(slot.slotCode)) addErr(`操耍人「${operator.name}」档期编号 ${slot.slotCode} 重复`);
      slotCodes.add(slot.slotCode);
    });
  });
  return issues;
}
