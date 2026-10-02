/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 * - 表的增删改查与整库导入导出
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table, type Transaction } from 'dexie';
import type { Play } from '../types/play';
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator } from '../types/operator';
import type { PercussionCue } from '../types/cue';
import type { HandoverBaseline, MergeSessionRecord, RehearsalPackage } from '../types/rehearsalPackage';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import {
  buildCueCode,
  buildOperatorCode,
  buildPlayCode,
  buildRoleCode,
  buildSceneCode,
  nextSequencedCode,
} from './bizCode';

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

export const ROW_REVISION = 3;

/** 交接底稿行：按剧目业务编号存一份 */
export interface HandoverBaseRow {
  /** 主键 = 剧目业务编号（J-001） */
  playBizCode: string;
  updatedAt: string;
  baseline: HandoverBaseline;
}

class ShadowPlayDatabase extends Dexie {
  plays!: Table<PlayRow, string>;
  scenes!: Table<SceneRow, string>;
  roles!: Table<RoleRow, string>;
  operators!: Table<OperatorRow, string>;
  cues!: Table<CueRow, string>;
  handoverBases!: Table<HandoverBaseRow, string>;
  mergeSessions!: Table<MergeSessionRecord, string>;

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

    // v2：新增 revision 行修订号；场次补充索引，锣鼓点补充 playId 冗余便于按剧目统计
    this.version(2).stores({
      plays: 'id, title, genre, status, createdAt, updatedAt',
      scenes: 'id, playId, seq, progress, needsShadowScreen',
      roles: 'id, sceneId, operatorId, roleType, name',
      operators: 'id, name, rehearsalHours',
      cues: 'id, sceneId, atSecond, instrument, beatName',
    });

    // v3：全部实体补「业务编号」（跨分队认关系用，uuid 只在本机有效）；
    // 新增 handoverBases（上次交接底稿）与 mergeSessions（合并进度与整包，供失败重试）两表
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plays: 'id, bizCode, title, genre, status, createdAt, updatedAt',
        scenes: 'id, bizCode, playId, seq, progress, needsShadowScreen',
        roles: 'id, bizCode, sceneId, operatorId, roleType, name',
        operators: 'id, bizCode, name, rehearsalHours',
        cues: 'id, bizCode, sceneId, atSecond, instrument, beatName',
        handoverBases: 'playBizCode, updatedAt',
        mergeSessions: 'id, status, updatedAt',
      })
      .upgrade((tx) => migrateBizCodes(tx));
  }
}

/** v3 升级：按既有顺序为全部行补业务编号、时间戳与 revision */
async function migrateBizCodes(tx: Transaction): Promise<void> {
  const stamp = nowIso();
  const [plays, scenes, roles, cues, operators] = await Promise.all([
    tx.table<PlayRow, string>('plays').toArray(),
    tx.table<SceneRow, string>('scenes').toArray(),
    tx.table<RoleRow, string>('roles').toArray(),
    tx.table<CueRow, string>('cues').toArray(),
    tx.table<OperatorRow, string>('operators').toArray(),
  ]);

  const ensureStamp = <T extends { createdAt?: string; updatedAt?: string }>(row: T): void => {
    if (typeof row.updatedAt !== 'string') row.updatedAt = stamp;
    if (typeof row.createdAt !== 'string') row.createdAt = row.updatedAt;
  };

  // 操耍人：按建档顺序 M-001…
  [...operators]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .forEach((operator, index) => {
      if (typeof operator.bizCode !== 'string' || operator.bizCode === '') {
        operator.bizCode = buildOperatorCode(index + 1);
      }
      operator.busySlots?.forEach((slot, slotIndex) => {
        if (typeof slot.bizCode !== 'string' || slot.bizCode === '') {
          slot.bizCode = `${operator.bizCode}-B${String(slotIndex + 1).padStart(2, '0')}`;
        }
      });
      ensureStamp(operator);
      operator.revision = ROW_REVISION;
    });

  // 剧目：按建档顺序 J-001…
  const playCodeById = new Map<string, string>();
  [...plays]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((play, index) => {
      const code = typeof play.bizCode === 'string' && play.bizCode !== '' ? play.bizCode : buildPlayCode(index + 1);
      play.bizCode = code;
      playCodeById.set(play.id, code);
      ensureStamp(play);
      play.revision = ROW_REVISION;
    });

  // 场次：剧目内按场序 …-S01
  const sceneCodeById = new Map<string, string>();
  plays.forEach((play) => {
    const playCode = playCodeById.get(play.id) ?? '';
    scenes
      .filter((scene) => scene.playId === play.id)
      .sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
      .forEach((scene, index) => {
        const code =
          typeof scene.bizCode === 'string' && scene.bizCode !== ''
            ? scene.bizCode
            : buildSceneCode(playCode, index + 1);
        scene.bizCode = code;
        sceneCodeById.set(scene.id, code);
        ensureStamp(scene);
        scene.revision = ROW_REVISION;
      });
  });

  // 影人角色：场区内按建档顺序 …-R01
  scenes.forEach((scene) => {
    const sceneCode = sceneCodeById.get(scene.id) ?? '';
    roles
      .filter((role) => role.sceneId === scene.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .forEach((role, index) => {
        if (typeof role.bizCode !== 'string' || role.bizCode === '') {
          role.bizCode = buildRoleCode(sceneCode, index + 1);
        }
        ensureStamp(role);
        role.revision = ROW_REVISION;
      });
  });

  // 锣鼓点：场区内按秒点、建档顺序 …-C01
  scenes.forEach((scene) => {
    const sceneCode = sceneCodeById.get(scene.id) ?? '';
    cues
      .filter((cue) => cue.sceneId === scene.id)
      .sort((a, b) => a.atSecond - b.atSecond || a.createdAt.localeCompare(b.createdAt))
      .forEach((cue, index) => {
        if (typeof cue.bizCode !== 'string' || cue.bizCode === '') {
          cue.bizCode = buildCueCode(sceneCode, index + 1);
        }
        ensureStamp(cue);
        cue.revision = ROW_REVISION;
      });
  });

  await Promise.all([
    tx.table<PlayRow, string>('plays').bulkPut(plays),
    tx.table<SceneRow, string>('scenes').bulkPut(scenes),
    tx.table<RoleRow, string>('roles').bulkPut(roles),
    tx.table<CueRow, string>('cues').bulkPut(cues),
    tx.table<OperatorRow, string>('operators').bulkPut(operators),
  ]);
}

export const db = new ShadowPlayDatabase();

/**
 * 运行时兜底补齐业务编号：
 * 旧快照（v2 导出、无 bizCode）覆盖导入后，升级钩子不会触发，靠这里迁移补齐再合并。
 */
export async function ensureBizCodes(): Promise<void> {
  const [plays, scenes, roles, cues, operators] = await Promise.all([
    db.plays.toArray(),
    db.scenes.toArray(),
    db.roles.toArray(),
    db.cues.toArray(),
    db.operators.toArray(),
  ]);

  const playCodes = new Set(plays.map((play) => play.bizCode).filter(Boolean));
  const patchPlays = plays
    .filter((play) => !play.bizCode)
    .map((play) => ({ ...play, bizCode: nextSequencedCode([...playCodes], buildPlayCode), revision: ROW_REVISION }));
  patchPlays.forEach((play) => playCodes.add(play.bizCode));

  const playCodeById = new Map<string, string>();
  [...plays, ...patchPlays].forEach((play) => playCodeById.set(play.id, play.bizCode));

  const sceneCodeById = new Map<string, string>();
  const patchScenes: SceneRow[] = [];
  const sceneGroups = new Map<string, SceneRow[]>();
  scenes.forEach((scene) => {
    const list = sceneGroups.get(scene.playId) ?? [];
    list.push(scene);
    sceneGroups.set(scene.playId, list);
  });
  sceneGroups.forEach((group) => {
    const playCode = playCodeById.get(group[0]?.playId ?? '') ?? 'J-X';
    const used = group.map((scene) => scene.bizCode).filter(Boolean);
    [...group]
      .sort((a, b) => a.seq - b.seq)
      .forEach((scene) => {
        if (scene.bizCode) {
          sceneCodeById.set(scene.id, scene.bizCode);
          return;
        }
        const code = nextSequencedCode(used, (seq) => buildSceneCode(playCode, seq));
        used.push(code);
        sceneCodeById.set(scene.id, code);
        patchScenes.push({ ...scene, bizCode: code, revision: ROW_REVISION });
      });
  });

  const patchRoles: RoleRow[] = [];
  const roleGroups = new Map<string, RoleRow[]>();
  roles.forEach((role) => {
    const list = roleGroups.get(role.sceneId) ?? [];
    list.push(role);
    roleGroups.set(role.sceneId, list);
  });
  roleGroups.forEach((group) => {
    const sceneCode = sceneCodeById.get(group[0]?.sceneId ?? '') ?? '';
    const used = group.map((role) => role.bizCode).filter(Boolean);
    group.forEach((role) => {
      if (!role.bizCode) {
        const code = nextSequencedCode(used, (seq) => buildRoleCode(sceneCode, seq));
        used.push(code);
        patchRoles.push({ ...role, bizCode: code, revision: ROW_REVISION });
      }
    });
  });

  const patchCues: CueRow[] = [];
  const cueGroups = new Map<string, CueRow[]>();
  cues.forEach((cue) => {
    const list = cueGroups.get(cue.sceneId) ?? [];
    list.push(cue);
    cueGroups.set(cue.sceneId, list);
  });
  cueGroups.forEach((group) => {
    const sceneCode = sceneCodeById.get(group[0]?.sceneId ?? '') ?? '';
    const used = group.map((cue) => cue.bizCode).filter(Boolean);
    [...group]
      .sort((a, b) => a.atSecond - b.atSecond)
      .forEach((cue) => {
        if (!cue.bizCode) {
          const code = nextSequencedCode(used, (seq) => buildCueCode(sceneCode, seq));
          used.push(code);
          patchCues.push({ ...cue, bizCode: code, revision: ROW_REVISION });
        }
      });
  });

  const operatorCodes = new Set(operators.map((operator) => operator.bizCode).filter(Boolean));
  const patchOperators: OperatorRow[] = [];
  operators.forEach((operator) => {
    let changed = false;
    let code = operator.bizCode;
    if (!code) {
      code = nextSequencedCode([...operatorCodes], buildOperatorCode);
      operatorCodes.add(code);
      changed = true;
    }
    const slots = operator.busySlots.map((slot, index) => {
      if (slot.bizCode) return slot;
      changed = true;
      return { ...slot, bizCode: `${code}-B${String(index + 1).padStart(2, '0')}` };
    });
    if (changed) patchOperators.push({ ...operator, bizCode: code ?? operator.bizCode, busySlots: slots, revision: ROW_REVISION });
  });

  if (
    patchPlays.length === 0 &&
    patchScenes.length === 0 &&
    patchRoles.length === 0 &&
    patchCues.length === 0 &&
    patchOperators.length === 0
  ) {
    return;
  }

  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, db.operators, async () => {
    if (patchPlays.length > 0) await db.plays.bulkPut(patchPlays);
    if (patchScenes.length > 0) await db.scenes.bulkPut(patchScenes);
    if (patchRoles.length > 0) await db.roles.bulkPut(patchRoles);
    if (patchCues.length > 0) await db.cues.bulkPut(patchCues);
    if (patchOperators.length > 0) await db.operators.bulkPut(patchOperators);
  });
}

/** 打开数据库：首次使用时灌入示例班社数据，保证界面不为空壳 */
export async function initDatabase(): Promise<void> {
  await db.open();
  // 兼容旧快照覆盖导入后缺失业务编号的历史数据：先迁移补齐再供界面使用
  await ensureBizCodes();
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

export async function getPlayByCode(bizCode: string): Promise<PlayRow | undefined> {
  return db.plays.where('bizCode').equals(bizCode).first();
}

export async function putPlay(row: PlayRow): Promise<void> {
  await db.plays.put(row);
}

export async function removePlay(id: string): Promise<void> {
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, async () => {
    const scenes = await db.scenes.where('playId').equals(id).toArray();
    const sceneIds = scenes.map((scene) => scene.id);
    if (sceneIds.length > 0) {
      await db.roles.where('sceneId').anyOf(sceneIds).delete();
      await db.cues.where('sceneId').anyOf(sceneIds).delete();
    }
    await db.scenes.where('playId').equals(id).delete();
    await db.plays.delete(id);
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

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(row);
}

export async function putScenes(rows: SceneRow[]): Promise<void> {
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

export async function putRole(row: RoleRow): Promise<void> {
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

export async function putOperator(row: OperatorRow): Promise<void> {
  await db.operators.put(row);
}

export async function putOperators(rows: OperatorRow[]): Promise<void> {
  await db.operators.bulkPut(rows);
}

export async function removeOperator(id: string): Promise<void> {
  await db.transaction('rw', db.operators, db.roles, db.cues, async () => {
    const bound = await db.roles.where('operatorId').equals(id).toArray();
    if (bound.length > 0) {
      await db.roles.bulkPut(bound.map((role) => ({ ...role, operatorId: null, updatedAt: nowIso() })));
    }
    // leadOperator 未建索引，全表过滤后解绑
    const boundCues = (await db.cues.toArray()).filter((cue) => cue.leadOperator === id);
    if (boundCues.length > 0) {
      await db.cues.bulkPut(boundCues.map((cue) => ({ ...cue, leadOperator: null, updatedAt: nowIso() })));
    }
    await db.operators.delete(id);
  });
}

/* ----------------------------- 锣鼓点 ----------------------------- */

export async function listCuesByScene(sceneId: string): Promise<CueRow[]> {
  const rows = await db.cues.where('sceneId').equals(sceneId).toArray();
  return rows.sort((a, b) => a.atSecond - b.atSecond);
}

export async function listCuesByScenes(sceneIds: string[]): Promise<CueRow[]> {
  if (sceneIds.length === 0) return [];
  const rows = await db.cues.where('sceneId').anyOf(sceneIds).toArray();
  return rows.sort((a, b) => a.atSecond - b.atSecond);
}

export async function putCue(row: CueRow): Promise<void> {
  await db.cues.put(row);
}

export async function removeCue(id: string): Promise<void> {
  await db.cues.delete(id);
}

/* --------------------------- 交接底稿 --------------------------- */

export async function getHandoverBase(playBizCode: string): Promise<HandoverBaseRow | undefined> {
  return db.handoverBases.get(playBizCode);
}

export async function putHandoverBase(row: HandoverBaseRow): Promise<void> {
  await db.handoverBases.put(row);
}

/* --------------------------- 合并会话 --------------------------- */

export async function getMergeSession(packageId: string): Promise<MergeSessionRecord | undefined> {
  return db.mergeSessions.get(packageId);
}

export async function listMergeSessions(): Promise<MergeSessionRecord[]> {
  return db.mergeSessions.orderBy('updatedAt').reverse().toArray();
}

export async function putMergeSession(session: MergeSessionRecord): Promise<void> {
  await db.mergeSessions.put(session);
}

export async function removeMergeSession(packageId: string): Promise<void> {
  await db.mergeSessions.delete(packageId);
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

/** 导出整库快照（去掉内部 revision 字段） */
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

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.operators, db.cues, async () => {
    await Promise.all([
      db.plays.clear(),
      db.scenes.clear(),
      db.roles.clear(),
      db.operators.clear(),
      db.cues.clear(),
    ]);
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION });
    await db.plays.bulkPut(snapshot.plays.map(rev));
    await db.scenes.bulkPut(snapshot.scenes.map(rev));
    await db.roles.bulkPut(snapshot.roles.map(rev));
    await db.operators.bulkPut(snapshot.operators.map(rev));
    await db.cues.bulkPut(snapshot.cues.map(rev));
  });
  // 旧版快照可能没有业务编号，导入后立即迁移补齐
  await ensureBizCodes();
}

/** 清空全部数据并重新灌入示例数据 */
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
  const [plays, scenes, roles, operators, cues] = await Promise.all([
    db.plays.count(),
    db.scenes.count(),
    db.roles.count(),
    db.operators.count(),
    db.cues.count(),
  ]);
  return { plays, scenes, roles, operators, cues };
}

export type { RehearsalPackage };
