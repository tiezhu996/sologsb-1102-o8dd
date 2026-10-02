/**
 * v2 → v3 升级迁移自测：旧库无业务编号 / 无底稿字段
 * 运行：npx esbuild scripts/testMigration.ts --bundle --platform=node --format=esm | node
 *
 * 先按旧 v2 结构建库灌旧格式数据，再动态加载 v3 的 db 触发升级。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

const DB_NAME = 'gbshadowplay';
const stamp = '2026-09-01T00:00:00.000Z';

/* ---- 1. 用旧 v2 结构建库 ---- */
class OldDb extends Dexie {
  plays!: Dexie.Table;
  scenes!: Dexie.Table;
  roles!: Dexie.Table;
  operators!: Dexie.Table;
  cues!: Dexie.Table;
  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      plays: 'id, title, genre, status, createdAt',
      scenes: 'id, playId, seq, progress',
      roles: 'id, sceneId, operatorId, roleType',
      operators: 'id, name',
      cues: 'id, sceneId, atSecond, instrument',
    });
    this.version(2).stores({
      plays: 'id, title, genre, status, createdAt, updatedAt',
      scenes: 'id, playId, seq, progress, needsShadowScreen',
      roles: 'id, sceneId, operatorId, roleType, name',
      operators: 'id, name, rehearsalHours',
      cues: 'id, sceneId, atSecond, instrument, beatName',
    });
  }
}

const oldDb = new OldDb();
await oldDb.open();
const opId = 'op-uuid-1';
const playId = 'play-uuid-1';
const sceneId = 'scene-uuid-1';
await oldDb.operators.put({
  id: opId,
  name: '老艺人甲',
  skillTags: ['qianzi'],
  busySlots: [{ id: 'slot-uuid-1', weekday: 3, startMinute: 0, durationMinute: 120, label: '旧时段' }],
  assignedRoleIds: [],
  rehearsalHours: 5,
  createdAt: stamp,
  updatedAt: stamp,
  revision: 2,
});
await oldDb.plays.put({
  id: playId,
  title: '旧剧目',
  genre: 'traditional',
  scriptText: '旧提要',
  totalScenes: 1,
  premiereVenue: '旧戏台',
  status: 'preparing',
  createdAt: stamp,
  updatedAt: stamp,
  revision: 2,
});
await oldDb.scenes.put({
  id: sceneId,
  playId,
  seq: 1,
  title: '第一场',
  durationMin: 10,
  stageNote: '',
  needsShadowScreen: 'small',
  progress: 30,
  createdAt: stamp,
  updatedAt: stamp,
  revision: 2,
});
await oldDb.roles.put({
  id: 'role-uuid-1',
  sceneId,
  name: '旧角色',
  roleType: 'sheng',
  propParts: ['toucha'],
  entranceCue: '',
  lineNote: '',
  operatorId: opId,
  createdAt: stamp,
  updatedAt: stamp,
  revision: 2,
});
await oldDb.cues.put({
  id: 'cue-uuid-1',
  sceneId,
  beatName: 'jijifeng',
  instrument: 'daluo',
  atSecond: 12,
  leadOperator: opId,
  note: '旧鼓点',
  createdAt: stamp,
  updatedAt: stamp,
  revision: 2,
});
await oldDb.close();

/* ---- 2. 加载 v3 db 触发升级 ---- */
const { db, DB_SCHEMA_VERSION, getHandoverBase } = await import('../src/utils/db');
assert(DB_SCHEMA_VERSION === 3, '当前为 v3');
await db.open();

const plays = await db.plays.toArray();
const scenes = await db.scenes.toArray();
const roles = await db.roles.toArray();
const cues = await db.cues.toArray();
const operators = await db.operators.toArray();

console.log('\n== v2 → v3 迁移');
assert(plays.length === 1 && /^JU-\d{4,}$/.test(plays[0].playCode), '旧剧目补上 playCode');
assert(scenes.length === 1 && /^CH-\d{4,}$/.test(scenes[0].sceneCode), '旧场次补上 sceneCode');
assert(roles.length ===1 && /^YING-\d{4,}$/.test(roles[0].roleCode), '旧角色补上 roleCode');
assert(cues.length === 1 && /^LUO-\d{4,}$/.test(cues[0].cueCode), '旧鼓点补上 cueCode');
assert(operators.length === 1 && /^CAO-\d{4,}$/.test(operators[0].operatorCode), '旧操耍人补上 operatorCode');
assert(/^SLOT-\d{4,}$/.test(operators[0].busySlots[0].slotCode ?? ''), '旧档期补上 slotCode');
assert(roles[0].operatorId === opId, '本机 uuid 外键原样保留，未被硬套');
assert(plays[0].revision === 3 && roles[0].revision === 3, '行 revision 升到 3');

// 计数器
const counters = await db.meta.toArray();
const keys = new Set(counters.map((c) => c.key));
assert(
  ['counter:play', 'counter:scene', 'counter:role', 'counter:operator', 'counter:cue', 'counter:slot'].every((k) =>
    keys.has(k),
  ),
  '六类计数器就位',
);

// 首次交接底稿：按当前记录迁移补齐，且关系用业务编号闭环
const base = await getHandoverBase(plays[0].playCode);
assert(Boolean(base), '旧库自动建立交接底稿');
const baseRole = base?.snapshot.roles[0];
assert(baseRole?.operatorCode === operators[0].operatorCode, '底稿里角色指派对到操耍人业务编号');
const baseCue = base?.snapshot.cues[0];
assert(baseCue?.leadOperatorCode === operators[0].operatorCode, '底稿里鼓点领奏对到业务编号');
assert(baseRole?.sceneCode === scenes[0].sceneCode, '底稿里角色归属场次业务编号');
assert(base?.snapshot.operators[0].busySlots[0].slotCode.startsWith('SLOT-'), '底稿档期带 slotCode');

// leadOperator 新索引可用
const led = await db.cues.where('leadOperator').equals(opId).toArray();
assert(led.length === 1, '新索引 leadOperator 可查询');

// 新写入自动发号且不与迁移号撞
const { nextCode } = await import('../src/utils/db');
const newCode = await nextCode('play');
const seqOfNew = Number(newCode.split('-')[1]);
const seqOfMigrated = Number(plays[0].playCode.split('-')[1]);
assert(seqOfNew > seqOfMigrated, '新发号顺序号大于迁移号，不撞号');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
