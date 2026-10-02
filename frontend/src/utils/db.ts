/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 * - 表的增删改查与整库导入导出
 * - 纯前端应用：不依赖任何后端或数据库服务
 *
 * v3 起所有实体带「业务编号」（playCode / sceneCode / roleCode / operatorCode / cueCode，
 * 操耍人时段带 slotCode）：跨分队合并只认业务编号，不认本机 uuid。
 */
import Dexie, { type Table } from 'dexie';
import type { Play } from '../types/play';
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator, BusySlot } from '../types/operator';
import type { PercussionCue } from '../types/cue';
import type { PackageSnapshot, RehearsalPackage } from '../types/package';
import type { ResolutionMap } from './mergeEngine';
import { nowIso } from './uuid';
import { formatCode, counterKey, parseCodeSeq, type CodePrefixKey } from './code';
import { seedDatabase } from './seed';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据库名 */
export const DB_NAME = 'gbshadowplay';

/** 带结构修订号的持久化实体 */
export interface Revisioned {
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number;
}

export type PlayRow = Play & Revisioned;
export type SceneRow = Scene & Revisioned;
export type RoleRow = ShadowRole & Revisioned;
export type OperatorRow = Operator & Revisioned;
export type CueRow = PercussionCue & Revisioned;

/** 写入时允许缺业务编号，由 db 层统一发放（老调用方无需逐处改造） */
export type NewPlayRow = Omit<PlayRow, 'playCode'> & { playCode?: string };
export type NewSceneRow = Omit<SceneRow, 'sceneCode'> & { sceneCode?: string };
export type NewRoleRow = Omit<RoleRow, 'roleCode'> & { roleCode?: string };
export type NewOperatorRow = Omit<OperatorRow, 'operatorCode'> & { operatorCode?: string };
export type NewCueRow = Omit<CueRow, 'cueCode'> & { cueCode?: string };

export const ROW_REVISION = 3;

/** 通用键值表：业务编号计数器等 */
export interface MetaRow {
  key: string;
  value: number | string;
}

/** 每个剧目的「上次交接底稿」，分队导出排演包时作为 base 带上 */
export interface HandoverBaseRow {
  /** 主键 = playCode */
  playCode: string;
  snapshot: PackageSnapshot;
  updatedAt: string;
}

export type MergeSessionStatus = 'pending' | 'applied' | 'failed';

export interface MergeReport {
  adds: number;
  updates: number;
  deletes: number;
  fieldConflicts: number;
  entityConflicts: number;
  warnings: string[];
  baselineMigrated: boolean;
  appliedAt: string;
}

/** 一次排演包合并会话：失败重试同一包时，整包与已核对进度都保留，不重复追加 */
export interface MergeSessionRow {
  id: string;
  packageCode: string;
  playCode: string;
  brigadeName: string;
  /** 整包原样保留，重试时直接复用 */
  packageJson: RehearsalPackage;
  status: MergeSessionStatus;
  /** 冲突已选定结果（只存 id → 选择），进度持久化 */
  resolutions: ResolutionMap;
  /** 缺底稿的旧包：导入时按本机当前记录迁移出的基线，重试时复用 */
  baselineSnapshot: PackageSnapshot | null;
  /** 应用成功后的落盘汇报 */
  report?: MergeReport;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/* ------------------------- 业务编号计数器 ------------------------- */

const counterCache = new Map<CodePrefixKey, number>();

/** 生成下一个业务编号（顺序号持久化到 meta 表，保证跨会话不重号） */
export async function nextCode(kind: CodePrefixKey): Promise<string> {
  let seq = counterCache.get(kind);
  if (seq === undefined) {
    const stored = await db.meta.get(counterKey(kind));
    seq = typeof stored?.value === 'number' ? stored.value : 0;
  }
  seq += 1;
  counterCache.set(kind, seq);
  await db.meta.put({ key: counterKey(kind), value: seq });
  return formatCode(kind, seq);
}

/** 事务内同步计数分配器：先播种再顺序发号，用于升级迁移 */
class TxCounter {
  private seq: number;

  constructor(seed: number) {
    this.seq = seed;
  }

  next(kind: CodePrefixKey): string {
    this.seq += 1;
    return formatCode(kind, this.seq);
  }

  get current(): number {
    return this.seq;
  }
}

function maxSeqOf(kind: CodePrefixKey, codes: Array<string | undefined>): number {
  let max = 0;
  codes.forEach((code) => {
    const seq = parseCodeSeq(kind, code);
    if (seq !== null && seq > max) max = seq;
  });
  return max;
}

/** 给缺业务编号的一组行补号（异步，发号即落 meta） */
async function fillRowCodes<TRow extends object>(
  rows: TRow[],
  kind: CodePrefixKey,
  codeField: keyof TRow,
): Promise<void> {
  for (const row of rows) {
    if (typeof row[codeField] === 'string' && (row[codeField] as string) !== '') continue;
    (row as Record<string, unknown>)[codeField as string] = await nextCode(kind);
  }
}

/** 给操耍人时段补 slotCode（直接改传入数组） */
export async function fillSlotCodes(operators: Array<{ busySlots: BusySlot[] }>): Promise<void> {
  for (const operator of operators) {
    for (const slot of operator.busySlots) {
      if (typeof slot.slotCode === 'string' && slot.slotCode !== '') continue;
      slot.slotCode = await nextCode('slot');
    }
  }
}

/** 把计数器播种到指定值（seed 灌库使用；大于当前值才生效） */
export async function seedCounters(values: Partial<Record<CodePrefixKey, number>>): Promise<void> {
  for (const [kind, value] of Object.entries(values) as Array<[CodePrefixKey, number]>) {
    const current = counterCache.get(kind) ?? 0;
    if (value > current) counterCache.set(kind, value);
    const stored = await db.meta.get(counterKey(kind));
    if (typeof stored?.value !== 'number' || value > stored.value) {
      await db.meta.put({ key: counterKey(kind), value: Math.max(value, typeof stored?.value === 'number' ? stored.value : 0) });
    }
  }
}

/**
 * 导入异机存档 / 合入异机新增行后：把各类计数器顶到现有最大业务编号之后，
 * 保证本机后续发号不与异机号相撞。
 */
export async function bumpCountersFromCodes(codesByKind: Partial<Record<CodePrefixKey, Array<string | undefined>>>): Promise<void> {
  const next: Partial<Record<CodePrefixKey, number>> = {};
  (Object.entries(codesByKind) as Array<[CodePrefixKey, Array<string | undefined>]>).forEach(([kind, codes]) => {
    const max = maxSeqOf(kind, codes);
    if (max > 0) next[kind] = max;
  });
  await seedCounters(next);
}

class ShadowPlayDatabase extends Dexie {
  plays!: Table<PlayRow, string>;
  scenes!: Table<SceneRow, string>;
  roles!: Table<RoleRow, string>;
  operators!: Table<OperatorRow, string>;
  cues!: Table<CueRow, string>;
  meta!: Table<MetaRow, string>;
  handoverBases!: Table<HandoverBaseRow, string>;
  mergeSessions!: Table<MergeSessionRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仅基础自增字段，保留历史数据）
    this.version(1).stores({
      plays: 'id, title, genre, status, createdAt',
      scenes: 'id, playId, seq, progress',
      roles: 'id, sceneId, operatorId, roleType',
      operators: 'id, name',
      cues: 'id, sceneId, atSecond, instrument',
    });

    // v2：新增 revision 行修订号；场次补充索引，锣鼓点补充索引
    this.version(2)
      .stores({
        plays: 'id, title, genre, status, createdAt, updatedAt',
        scenes: 'id, playId, seq, progress, needsShadowScreen',
        roles: 'id, sceneId, operatorId, roleType, name',
        operators: 'id, name, rehearsalHours',
        cues: 'id, sceneId, atSecond, instrument, beatName',
      })
      .upgrade(async (tx) => {
        // 迁移：补齐 revision，并兜底历史数据里缺失的字段
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('plays'),
          tx.table('scenes'),
          tx.table('roles'),
          tx.table('operators'),
          tx.table('cues'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.updatedAt !== 'string') row.updatedAt = nowIso();
            if (typeof row.createdAt !== 'string') row.createdAt = row.updatedAt;
          });
        }
      });

    // v3：业务编号 + meta 计数器 + 交接底稿 + 合并会话
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plays: 'id, playCode, title, genre, status, createdAt, updatedAt',
        scenes: 'id, sceneCode, playId, seq, progress, needsShadowScreen',
        roles: 'id, roleCode, sceneId, operatorId, roleType, name',
        operators: 'id, operatorCode, name, rehearsalHours',
        cues: 'id, cueCode, sceneId, atSecond, instrument, beatName, leadOperator',
        meta: 'key',
        handoverBases: 'playCode, updatedAt',
        mergeSessions: 'id, packageCode, status, createdAt, playCode',
      })
      .upgrade(async (tx) => {
        const playsTable = tx.table<PlayRow, string>('plays');
        const scenesTable = tx.table<SceneRow, string>('scenes');
        const rolesTable = tx.table<RoleRow, string>('roles');
        const operatorsTable = tx.table<OperatorRow, string>('operators');
        const cuesTable = tx.table<CueRow, string>('cues');
        const metaTable = tx.table<MetaRow, string>('meta');
        const handoverTable = tx.table<HandoverBaseRow, string>('handoverBases');

        const [plays, scenes, roles, operators, cues] = await Promise.all([
          playsTable.toCollection().toArray(),
          scenesTable.toCollection().toArray(),
          rolesTable.toCollection().toArray(),
          operatorsTable.toCollection().toArray(),
          cuesTable.toCollection().toArray(),
        ]);

        const sortByStrings = (a: string, b: string): number => a.localeCompare(b);
        const sortedPlays = [...plays].sort((a, b) =>
          sortByStrings(`${a.createdAt}|${a.id}`, `${b.createdAt}|${b.id}`),
        );
        const sortedScenes = [...scenes].sort((a, b) =>
          sortByStrings(`${a.playId}|${a.seq}|${a.id}`, `${b.playId}|${b.seq}|${b.id}`),
        );
        const sortedOperators = [...operators].sort((a, b) =>
          sortByStrings(`${a.name}|${a.id}`, `${b.name}|${b.id}`),
        );
        const sortedRoles = [...roles].sort((a, b) =>
          sortByStrings(`${a.sceneId}|${a.createdAt}|${a.id}`, `${b.sceneId}|${b.createdAt}|${b.id}`),
        );
        const sortedCues = [...cues].sort((a, b) =>
          sortByStrings(`${a.sceneId}|${a.atSecond}|${a.id}`, `${b.sceneId}|${b.atSecond}|${b.id}`),
        );

        // 按稳定顺序发号；同一批升级的同源数据，两边发出来的号也一致
        const allocPlay = new TxCounter(maxSeqOf('play', plays.map((row) => row.playCode)));
        const allocScene = new TxCounter(maxSeqOf('scene', scenes.map((row) => row.sceneCode)));
        const allocRole = new TxCounter(maxSeqOf('role', roles.map((row) => row.roleCode)));
        const allocOperator = new TxCounter(maxSeqOf('operator', operators.map((row) => row.operatorCode)));
        const allocCue = new TxCounter(maxSeqOf('cue', cues.map((row) => row.cueCode)));
        let slotSeq = 0;

        sortedPlays.forEach((row) => {
          if (!row.playCode) row.playCode = allocPlay.next('play');
          row.revision = ROW_REVISION;
        });
        sortedScenes.forEach((row) => {
          if (!row.sceneCode) row.sceneCode = allocScene.next('scene');
          row.revision = ROW_REVISION;
        });
        sortedOperators.forEach((row) => {
          if (!row.operatorCode) row.operatorCode = allocOperator.next('operator');
          (row.busySlots ?? []).forEach((slot) => {
            if (!slot.slotCode) {
              slotSeq += 1;
              slot.slotCode = formatCode('slot', slotSeq);
            }
          });
          row.revision = ROW_REVISION;
        });
        sortedRoles.forEach((row) => {
          if (!row.roleCode) row.roleCode = allocRole.next('role');
          row.revision = ROW_REVISION;
        });
        sortedCues.forEach((row) => {
          if (!row.cueCode) row.cueCode = allocCue.next('cue');
          row.revision = ROW_REVISION;
        });

        await Promise.all([
          playsTable.bulkPut(sortedPlays),
          scenesTable.bulkPut(sortedScenes),
          rolesTable.bulkPut(sortedRoles),
          operatorsTable.bulkPut(sortedOperators),
          cuesTable.bulkPut(sortedCues),
          metaTable.bulkPut(
            (
              [
                ['play', allocPlay.current],
                ['scene', allocScene.current],
                ['role', allocRole.current],
                ['operator', allocOperator.current],
                ['cue', allocCue.current],
                ['slot', slotSeq],
              ] as Array<[CodePrefixKey, number]>
            ).map(([kind, value]) => ({ key: counterKey(kind), value })),
          ),
        ]);
        counterCache.set('play', allocPlay.current);
        counterCache.set('scene', allocScene.current);
        counterCache.set('role', allocRole.current);
        counterCache.set('operator', allocOperator.current);
        counterCache.set('cue', allocCue.current);
        counterCache.set('slot', slotSeq);

        // 给现有剧目建立「上次交接底稿」：以当前全量数据作为首次基线
        const stamp = nowIso();
                const sceneCodeById = new Map(sortedScenes.map((row) => [row.id, row.sceneCode]));
        const operatorCodeById = new Map(sortedOperators.map((row) => [row.id, row.operatorCode]));
        await Promise.all(
          sortedPlays.map(async (play) => {
            const playScenes = sortedScenes.filter((row) => row.playId === play.id);
            const sceneIds = new Set(playScenes.map((row) => row.id));
            const playRoles = sortedRoles.filter((row) => sceneIds.has(row.sceneId));
            const playCues = sortedCues.filter((row) => sceneIds.has(row.sceneId));
            await handoverTable.put({
              playCode: play.playCode,
              updatedAt: stamp,
              snapshot: {
                play: {
                  playCode: play.playCode,
                  title: play.title,
                  genre: play.genre,
                  scriptText: play.scriptText,
                  totalScenes: play.totalScenes,
                  premiereVenue: play.premiereVenue,
                  status: play.status,
                },
                scenes: playScenes.map((row) => ({
                  sceneCode: row.sceneCode,
                  playCode: play.playCode,
                  seq: row.seq,
                  title: row.title,
                  durationMin: row.durationMin,
                  stageNote: row.stageNote,
                  needsShadowScreen: row.needsShadowScreen,
                  progress: row.progress,
                })),
                roles: playRoles.map((row) => ({
                  roleCode: row.roleCode,
                  sceneCode: sceneCodeById.get(row.sceneId) ?? '',
                  name: row.name,
                  roleType: row.roleType,
                  propParts: [...row.propParts],
                  entranceCue: row.entranceCue,
                  lineNote: row.lineNote,
                  operatorCode: row.operatorId ? operatorCodeById.get(row.operatorId) ?? null : null,
                })),
                cues: playCues.map((row) => ({
                  cueCode: row.cueCode,
                  sceneCode: sceneCodeById.get(row.sceneId) ?? '',
                  beatName: row.beatName,
                  instrument: row.instrument,
                  atSecond: row.atSecond,
                  leadOperatorCode: row.leadOperator ? operatorCodeById.get(row.leadOperator) ?? null : null,
                  note: row.note,
                })),
                operators: sortedOperators.map((row) => ({
                  operatorCode: row.operatorCode,
                  name: row.name,
                  skillTags: [...row.skillTags],
                  busySlots: row.busySlots.map((slot) => ({
                    slotCode: slot.slotCode as string,
                    weekday: slot.weekday,
                    startMinute: slot.startMinute,
                    durationMinute: slot.durationMinute,
                    label: slot.label,
                  })),
                  rehearsalHours: row.rehearsalHours,
                })),
              },
            });
          }),
        );
      });
  }
}

export const db = new ShadowPlayDatabase();

/** 打开数据库：首次使用时灌入示例班社数据，保证界面不为空壳 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.plays.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 剧目 ------------------------------ */

export async function listPlays(): Promise<PlayRow[]> {
  return db.plays.orderBy('createdAt').reverse().toArray();
}

export async function getPlay(id: string): Promise<PlayRow | undefined> {
  return db.plays.get(id);
}

export async function getPlayByCode(playCode: string): Promise<PlayRow | undefined> {
  return db.plays.where('playCode').equals(playCode).first();
}

export async function putPlay(input: NewPlayRow): Promise<void> {
  const row: PlayRow = { ...(input as PlayRow), playCode: input.playCode ?? (await nextCode('play')) };
  await db.plays.put(row);
}

export async function removePlay(id: string): Promise<void> {
  await db.transaction('rw', [db.plays, db.scenes, db.roles, db.cues, db.handoverBases], async () => {
    const play = await db.plays.get(id);
    const scenes = await db.scenes.where('playId').equals(id).toArray();
    const sceneIds = scenes.map((scene) => scene.id);
    if (sceneIds.length > 0) {
      await db.roles.where('sceneId').anyOf(sceneIds).delete();
      await db.cues.where('sceneId').anyOf(sceneIds).delete();
    }
    await db.scenes.where('playId').equals(id).delete();
    await db.plays.delete(id);
    if (play) await db.handoverBases.delete(play.playCode);
  });
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenesByPlay(playId: string): Promise<SceneRow[]> {
  const rows = await db.scenes.where('playId').equals(playId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function getScene(id: string): Promise<SceneRow | undefined> {
  return db.scenes.get(id);
}

export async function putScene(input: NewSceneRow): Promise<void> {
  const row: SceneRow = { ...(input as SceneRow), sceneCode: input.sceneCode ?? (await nextCode('scene')) };
  await db.scenes.put(row);
}

export async function putScenes(inputs: NewSceneRow[]): Promise<void> {
  const rows: SceneRow[] = [];
  for (const input of inputs) {
    rows.push({ ...(input as SceneRow), sceneCode: input.sceneCode ?? (await nextCode('scene')) });
  }
  await db.scenes.bulkPut(rows);
}

export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', db.scenes, db.roles, db.cues, async () => {
    await db.roles.where('sceneId').equals(id).delete();
    await db.cues.where('sceneId').equals(id).delete();
    await db.scenes.delete(id);
  });
}

/* ---------------------------- 影人角色 ---------------------------- */

export async function listRolesByScene(sceneId: string): Promise<RoleRow[]> {
  return db.roles.where('sceneId').equals(sceneId).toArray();
}

export async function listRolesByScenes(sceneIds: string[]): Promise<RoleRow[]> {
  if (sceneIds.length === 0) return [];
  return db.roles.where('sceneId').anyOf(sceneIds).toArray();
}

export async function listAllRoles(): Promise<RoleRow[]> {
  return db.roles.toArray();
}

export async function putRole(input: NewRoleRow): Promise<void> {
  const row: RoleRow = { ...(input as RoleRow), roleCode: input.roleCode ?? (await nextCode('role')) };
  await db.roles.put(row);
}

export async function removeRole(id: string): Promise<void> {
  await db.roles.delete(id);
}

/* ----------------------------- 操耍人 ----------------------------- */

export async function listOperators(): Promise<OperatorRow[]> {
  const rows = await db.operators.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getOperator(id: string): Promise<OperatorRow | undefined> {
  return db.operators.get(id);
}

export async function putOperator(input: NewOperatorRow): Promise<void> {
  const busySlots = input.busySlots.map((slot) => ({ ...slot }));
  await fillSlotCodes([{ busySlots }]);
  const row: OperatorRow = {
    ...(input as OperatorRow),
    operatorCode: input.operatorCode ?? (await nextCode('operator')),
    busySlots,
  };
  await db.operators.put(row);
}

export async function putOperators(inputs: NewOperatorRow[]): Promise<void> {
  const rows: OperatorRow[] = [];
  for (const input of inputs) {
    const busySlots = input.busySlots.map((slot) => ({ ...slot }));
    await fillSlotCodes([{ busySlots }]);
    rows.push({ ...(input as OperatorRow), operatorCode: input.operatorCode ?? (await nextCode('operator')), busySlots });
  }
  await db.operators.bulkPut(rows);
}

export async function removeOperator(id: string): Promise<void> {
  await db.transaction('rw', db.operators, db.roles, db.cues, async () => {
    const bound = await db.roles.where('operatorId').equals(id).toArray();
    if (bound.length > 0) {
      await db.roles.bulkPut(bound.map((role) => ({ ...role, operatorId: null, updatedAt: nowIso() })));
    }
    await db.cues.where('leadOperator').equals(id).modify({ leadOperator: null });
    await db.operators.delete(id);
  });
}

/* ----------------------------- 锣鼓点 ----------------------------- */

export async function listCuesByScene(sceneId: string): Promise<CueRow[]> {
  const rows = await db.cues.where('sceneId').equals(sceneId).toArray();
  return rows.sort((a, b) => a.atSecond - b.atSecond);
}

export async function putCue(input: NewCueRow): Promise<void> {
  const row: CueRow = { ...(input as CueRow), cueCode: input.cueCode ?? (await nextCode('cue')) };
  await db.cues.put(row);
}

export async function removeCue(id: string): Promise<void> {
  await db.cues.delete(id);
}

/* --------------------------- 交接底稿 --------------------------- */

export async function getHandoverBase(playCode: string): Promise<HandoverBaseRow | undefined> {
  return db.handoverBases.get(playCode);
}

export async function putHandoverBase(row: HandoverBaseRow): Promise<void> {
  await db.handoverBases.put(row);
}

/* --------------------------- 合并会话 --------------------------- */

export async function listMergeSessions(): Promise<MergeSessionRow[]> {
  const rows = await db.mergeSessions.orderBy('createdAt').reverse().toArray();
  return rows;
}

export async function getMergeSession(id: string): Promise<MergeSessionRow | undefined> {
  return db.mergeSessions.get(id);
}

export async function getMergeSessionByPackage(packageCode: string): Promise<MergeSessionRow | undefined> {
  return db.mergeSessions.where('packageCode').equals(packageCode).first();
}

export async function putMergeSession(row: MergeSessionRow): Promise<void> {
  await db.mergeSessions.put(row);
}

export async function removeMergeSession(id: string): Promise<void> {
  await db.mergeSessions.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  /** 快照标识，固定为数据库名 */
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plays: Play[];
  scenes: Scene[];
  roles: ShadowRole[];
  operators: Operator[];
  cues: PercussionCue[];
}

/** 导出整库快照（去掉内部 revision 字段，业务编号随档带走） */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plays, scenes, roles, operators, cues] = await Promise.all([
    db.plays.toArray(),
    db.scenes.toArray(),
    db.roles.toArray(),
    db.operators.toArray(),
    db.cues.toArray(),
  ]);
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row;
    return rest;
  };
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plays: plays.map(strip),
    scenes: scenes.map(strip),
    roles: roles.map(strip),
    operators: operators.map(strip),
    cues: cues.map(strip),
  };
}

/** 旧档迁移：缺业务编号的行按当前顺序补齐、时段补号，再覆盖导入 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const plays = snapshot.plays.map((row) => ({ ...row })) as NewPlayRow[];
  const scenes = snapshot.scenes.map((row) => ({ ...row })) as NewSceneRow[];
  const roles = snapshot.roles.map((row) => ({ ...row })) as NewRoleRow[];
  const operators = snapshot.operators.map((row) => ({ ...row })) as NewOperatorRow[];
  const cues = snapshot.cues.map((row) => ({ ...row })) as NewCueRow[];

  // 同档内若带了老格式编号，先以其最大值播种，再给缺号行发新号
  await fillRowCodes(plays, 'play', 'playCode');
  await fillRowCodes(scenes, 'scene', 'sceneCode');
  await fillRowCodes(operators, 'operator', 'operatorCode');
  await fillSlotCodes(operators);
  await fillRowCodes(roles, 'role', 'roleCode');
  await fillRowCodes(cues, 'cue', 'cueCode');
  const stampRows = <T extends object>(rows: T[]): T[] =>
    rows.map((row) => ({ ...row, revision: ROW_REVISION }));

  await db.transaction(
    'rw',
    [db.plays, db.scenes, db.roles, db.operators, db.cues, db.handoverBases, db.meta],
    async () => {
      await Promise.all([
        db.plays.clear(),
        db.scenes.clear(),
        db.roles.clear(),
        db.operators.clear(),
        db.cues.clear(),
        db.handoverBases.clear(),
      ]);
      await db.plays.bulkPut(stampRows(plays) as PlayRow[]);
      await db.scenes.bulkPut(stampRows(scenes) as SceneRow[]);
      await db.roles.bulkPut(stampRows(roles) as RoleRow[]);
      await db.operators.bulkPut(stampRows(operators) as OperatorRow[]);
      await db.cues.bulkPut(stampRows(cues) as CueRow[]);
      // 顶号：导入的异机编号可能比本机计数器大
      await bumpCountersFromCodes({
        play: plays.map((row) => row.playCode),
        scene: scenes.map((row) => row.sceneCode),
        role: roles.map((row) => row.roleCode),
        operator: operators.map((row) => row.operatorCode),
        cue: cues.map((row) => row.cueCode),
        slot: operators.flatMap((row) => row.busySlots.map((slot) => slot.slotCode)),
      });
    },
  );
}

/** 清空全部数据并重新灌入示例数据（业务编号计数器不动，保证不重号） */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plays, db.scenes, db.roles, db.operators, db.cues, db.handoverBases, db.mergeSessions],
    async () => {
      await Promise.all([
        db.plays.clear(),
        db.scenes.clear(),
        db.roles.clear(),
        db.operators.clear(),
        db.cues.clear(),
        db.handoverBases.clear(),
        db.mergeSessions.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 粗略统计各表行数，用于页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [plays, scenes, roles, operators, cues, pendingMerges] = await Promise.all([
    db.plays.count(),
    db.scenes.count(),
    db.roles.count(),
    db.operators.count(),
    db.cues.count(),
    db.mergeSessions.where('status').equals('pending').count(),
  ]);
  return { plays, scenes, roles, operators, cues, pendingMerges };
}
