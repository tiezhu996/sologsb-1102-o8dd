/**
 * v2 → v3 结构迁移测试：旧数据（无 bizCode / busySlots 无 bizCode）打开后按既有顺序补齐。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, DB_NAME, initDatabase } from '../../utils/db';

async function withFreshDb(run: () => Promise<void>): Promise<void> {
  await db.close();
  await new Promise<void>((resolve, reject) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onsuccess = () => resolve();
    del.onerror = () => reject(del.error);
    del.onblocked = () => reject(new Error('delete blocked'));
  });
  await run();
}

describe('v2 → v3 迁移', () => {
  it('旧数据缺业务编号：升级后按建档/场序补齐，且外键编号可推断', async () => {
    await withFreshDb(async () => {
      // 用 v2 结构直接建库并灌一条旧格式剧目 / 操耍人（无 bizCode、busySlots 无 bizCode、无 revision）
      const old = new Dexie(DB_NAME);
      old.version(2).stores({
        plays: 'id, title, genre, status, createdAt, updatedAt',
        scenes: 'id, playId, seq, progress, needsShadowScreen',
        roles: 'id, sceneId, operatorId, roleType, name',
        operators: 'id, name, rehearsalHours',
        cues: 'id, sceneId, atSecond, instrument, beatName',
      });
      await old.open();
      const playId = 'p-old-1';
      const opId = 'op-old-1';
      const sceneId = 's-old-1';
      const stamp = '2026-01-01T00:00:00.000Z';
      await old.table('operators').put({
        id: opId,
        name: '老师傅',
        skillTags: ['qianzi'],
        busySlots: [{ id: 'slot-1', weekday: 1, startMinute: 0, durationMinute: 120, label: '排练' }],
        assignedRoleIds: [],
        rehearsalHours: 5,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await old.table('plays').put({
        id: playId,
        title: '旧戏',
        genre: 'traditional',
        scriptText: '',
        totalScenes: 1,
        premiereVenue: '',
        status: 'preparing',
        createdAt: stamp,
        updatedAt: stamp,
      });
      await old.table('scenes').put({
        id: sceneId,
        playId,
        seq: 1,
        title: '第一场',
        durationMin: 12,
        stageNote: '',
        needsShadowScreen: 'standard',
        progress: 0,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await old.table('roles').put({
        id: 'r-old-1',
        sceneId,
        name: '主角',
        roleType: 'sheng',
        propParts: ['toucha'],
        entranceCue: '',
        lineNote: '',
        operatorId: opId,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await old.table('cues').put({
        id: 'c-old-1',
        sceneId,
        beatName: 'sijitou',
        instrument: 'bangu',
        atSecond: 10,
        leadOperator: opId,
        note: '',
        createdAt: stamp,
        updatedAt: stamp,
      });
      await old.close();

      // 打开现行库触发 v3 升级迁移；旧库为空会自动 seed，但这里有数据不会 seed
      await initDatabase();

      const play = await db.plays.get(playId);
      assert.equal(play?.bizCode, 'J-001');
      const scene = await db.scenes.get(sceneId);
      assert.equal(scene?.bizCode, 'J-001-S01');
      const operator = await db.operators.get(opId);
      assert.equal(operator?.bizCode, 'M-001');
      assert.equal(operator?.busySlots[0]?.bizCode, 'M-001-B01', '冲突时段补业务编号');
      const role = await db.roles.get('r-old-1');
      assert.equal(role?.bizCode, 'J-001-S01-R01');
      const cue = await db.cues.get('c-old-1');
      assert.equal(cue?.bizCode, 'J-001-S01-C01');
      // 时间戳兜底
      assert.ok(play?.createdAt && play.updatedAt);
      assert.equal(play?.revision, 3);
    });
  });
});
