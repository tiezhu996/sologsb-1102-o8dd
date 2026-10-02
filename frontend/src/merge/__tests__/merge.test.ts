/**
 * 离线排演包合并 · 端到端逻辑测试（Node 内置 test runner + fake-indexeddb）
 * 运行：node --import tsx --test src/merge/__tests__/merge.test.ts （经 esbuild 打包后执行，见 npm 脚本）
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { db, ROW_REVISION, type CueRow, type OperatorRow, type PlayRow, type RoleRow, type SceneRow } from '../../utils/db';
import { stableLocalId } from '../../utils/bizCode';
import {
  buildPackage,
  enrichPackage,
  type BaselineView,
} from '../packageIO';
import { buildMergePlan, unresolvedConflictCount, type MergePlan } from '../mergeEngine';
import { commitMerge, loadLocalScope } from '../commitMerge';
import { applyResolutions } from '../mergeEngine';
import type { HandoverBaseline, RehearsalPackage } from '../../types/rehearsalPackage';
import { nowIso, uuid } from '../../utils/uuid';

function stamp(): string {
  return nowIso();
}

function makePlay(overrides: Partial<PlayRow> = {}): PlayRow {
  const t = stamp();
  return {
    id: uuid(),
    bizCode: 'J-001',
    title: '白蛇传·借伞',
    genre: 'traditional',
    scriptText: '底稿提要',
    totalScenes: 2,
    premiereVenue: '滦州影戏馆',
    status: 'rehearsing',
    createdAt: t,
    updatedAt: t,
    revision: ROW_REVISION,
    ...overrides,
  };
}

function makeOperator(overrides: Partial<OperatorRow> = {}): OperatorRow {
  const t = stamp();
  return {
    id: uuid(),
    bizCode: 'M-001',
    name: '霍连生',
    skillTags: ['qianzi'],
    busySlots: [],
    assignedRoleIds: [],
    rehearsalHours: 10,
    createdAt: t,
    updatedAt: t,
    revision: ROW_REVISION,
    ...overrides,
  };
}

function makeScene(playId: string, overrides: Partial<SceneRow> = {}): SceneRow {
  const t = stamp();
  return {
    id: uuid(),
    bizCode: 'J-001-S01',
    playId,
    seq: 1,
    title: '第一场·游湖',
    durationMin: 14,
    stageNote: '底稿舞台提示',
    needsShadowScreen: 'standard',
    progress: 40,
    createdAt: t,
    updatedAt: t,
    revision: ROW_REVISION,
    ...overrides,
  };
}

function makeRole(sceneId: string, overrides: Partial<RoleRow> = {}): RoleRow {
  const t = stamp();
  return {
    id: uuid(),
    bizCode: 'J-001-S01-R01',
    sceneId,
    name: '白娘子',
    roleType: 'dan',
    propParts: ['toucha'],
    entranceCue: '底稿出场',
    lineNote: '底稿唱白',
    operatorId: null,
    createdAt: t,
    updatedAt: t,
    revision: ROW_REVISION,
    ...overrides,
  };
}

function makeCue(sceneId: string, overrides: Partial<CueRow> = {}): CueRow {
  const t = stamp();
  return {
    id: uuid(),
    bizCode: 'J-001-S01-C01',
    sceneId,
    beatName: 'sijitou',
    instrument: 'bangu',
    atSecond: 8,
    leadOperator: null,
    note: '开场',
    createdAt: t,
    updatedAt: t,
    revision: ROW_REVISION,
    ...overrides,
  };
}

async function seedLocal(): Promise<{
  play: PlayRow;
  scenes: SceneRow[];
  roles: RoleRow[];
  cues: CueRow[];
  operators: OperatorRow[];
}> {
  const play = makePlay();
  const op1 = makeOperator();
  const op2 = makeOperator({ bizCode: 'M-002', name: '苗凤仪', id: uuid() });
  const s1 = makeScene(play.id);
  const s2 = makeScene(play.id, { bizCode: 'J-001-S02', seq: 2, title: '第二场·结亲', durationMin: 18 });
  const r1 = makeRole(s1.id, { operatorId: op1.id });
  const c1 = makeCue(s1.id, { leadOperator: op1.id });
  await db.operators.bulkPut([op1, op2]);
  await db.plays.put(play);
  await db.scenes.bulkPut([s1, s2]);
  await db.roles.put(r1);
  await db.cues.put(c1);
  return { play, scenes: [s1, s2], roles: [r1], cues: [c1], operators: [op1, op2] };
}

async function wipe(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plays, db.scenes, db.roles, db.cues, db.operators, db.handoverBases, db.mergeSessions],
    async () => {
      await Promise.all([
        db.plays.clear(),
        db.scenes.clear(),
        db.roles.clear(),
        db.cues.clear(),
        db.operators.clear(),
        db.handoverBases.clear(),
        db.mergeSessions.clear(),
      ]);
    },
  );
}

/** 从本机范围构造载荷，再模拟分队机器：外键 uuid 全部换成另一套，但业务编号保持一致 */
function buildDetachmentView(base: BaselineView): BaselineView {
  // 分队机器上同一批业务编号的 uuid 与本机完全不同（模拟两台机器）
  const operatorUuid = new Map<string, string>();
  base.operators.forEach((operator) => operatorUuid.set(operator.bizCode, uuid()));
  const sceneUuid = new Map<string, string>();
  base.scenes.forEach((scene) => sceneUuid.set(scene.bizCode, uuid()));

  return {
    play: { ...base.play, id: uuid() },
    operators: base.operators.map((operator) => ({ ...operator, id: operatorUuid.get(operator.bizCode) as string })),
    scenes: base.scenes.map((scene) => ({
      ...scene,
      id: sceneUuid.get(scene.bizCode) as string,
      playId: uuid(),
      playBizCode: scene.playBizCode,
    })),
    roles: base.roles.map((role) => ({
      ...role,
      id: uuid(),
      sceneId: sceneUuid.get(role.sceneBizCode ?? '') as string,
      operatorId: role.operatorBizCode ? (operatorUuid.get(role.operatorBizCode) ?? null) : null,
    })),
    cues: base.cues.map((cue) => ({
      ...cue,
      id: uuid(),
      sceneId: sceneUuid.get(cue.sceneBizCode ?? '') as string,
      leadOperator: cue.leadOperatorBizCode ? (operatorUuid.get(cue.leadOperatorBizCode) ?? null) : null,
    })),
  };
}

function assemblePkg(current: BaselineView, baseline: BaselineView | null, id = 'pkg-1'): RehearsalPackage {
  const raw = buildPackage({
    packageId: id,
    detachmentName: '东路队',
    baseline: baseline as unknown as HandoverBaseline,
    current: current as unknown as HandoverBaseline,
  });
  return enrichPackage(JSON.parse(JSON.stringify(raw)));
}

async function makePkgFromLocal(
  scope: { play: PlayRow; scenes: SceneRow[]; roles: RoleRow[]; cues: CueRow[]; operators: OperatorRow[] },
): Promise<BaselineView> {
  const raw = buildPackage({
    packageId: 'pkg-1',
    detachmentName: '东路队',
    baseline: null,
    current: {
      play: scope.play,
      scenes: scope.scenes,
      roles: scope.roles,
      cues: scope.cues,
      operators: scope.operators,
    },
  });
  return enrichPackage(JSON.parse(JSON.stringify(raw)) as unknown as RehearsalPackage).current;
}

beforeEach(async () => {
  await wipe();
});

describe('业务编号合并', () => {
  it('两台机器 uuid 不同但业务编号一致：认作同一实体，不产生冲突', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    // 分队没改任何业务字段，只改了进度？这里先保持一致，验证不误报
    const pkg = assemblePkg(det, basePayload);
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    assert.equal(unresolvedConflictCount(plan), 0, '不应有冲突');
    const changed = plan.entries.filter((e) => ['modified', 'conflict'].includes(e.status));
    assert.equal(changed.length, 0, 'uuid 不同不应被当成改动');
  });

  it('同一字段两边都改：并列保留为冲突，选定后写入', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    det.play.title = '分队改的剧名';
    // 本机也改
    await db.plays.put({ ...local.play, title: '本机改的剧名' });

    const pkg = assemblePkg(det, basePayload);
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    const playEntry = plan.entries.find((e) => e.kind === 'play');
    assert.ok(playEntry, '有剧目行');
    const fieldConflict = playEntry!.conflicts.find((c) => c.conflictKind === 'field' && c.field === 'title');
    assert.ok(fieldConflict, '剧名两边改 → 字段冲突');
    assert.equal(unresolvedConflictCount(plan), 1);

    // 选分队
    const withResolution = applyResolutions(plan, { 'play:J-001:0': 'remote' });
    await commitMerge(withResolution, pkg, await loadLocalScope('J-001'));
    const after = await db.plays.where('bizCode').equals('J-001').first();
    assert.equal(after?.title, '分队改的剧名');
  });

  it('只一边改：直接采用，不冲突', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    const scene = det.scenes.find((s) => s.bizCode === 'J-001-S01')!;
    scene.durationMin = 25;
    scene.progress = 80;

    const pkg = assemblePkg(det, basePayload);
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    assert.equal(unresolvedConflictCount(plan), 0);
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));
    const s = await db.scenes.where('bizCode').equals('J-001-S01').first();
    assert.equal(s?.durationMin, 25);
    assert.equal(s?.progress, 80);
  });

  it('分队新增场次/角色/锣鼓点：稳定 id 落库，重复提交同一包不重复追加', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    const newSceneId = uuid();
    det.scenes.push({
      id: newSceneId,
      bizCode: 'J-001-S03',
      playId: uuid(),
      playBizCode: 'J-001',
      seq: 3,
      title: '第三场·水漫',
      durationMin: 22,
      stageNote: '双联影窗',
      needsShadowScreen: 'twin',
      progress: 10,
      createdAt: stamp(),
      updatedAt: stamp(),
    });

    const pkg = assemblePkg(det, basePayload, 'pkg-add-scene');
    const scope = await loadLocalScope('J-001');
    let plan = buildMergePlan(scope, pkg);
    assert.equal(unresolvedConflictCount(plan), 0);
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));

    const expectedId = stableLocalId('scene', 'J-001-S03');
    let inserted = await db.scenes.where('bizCode').equals('J-001-S03').toArray();
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].id, expectedId, '新增场次用稳定派生 id');

    // 重放同一包：幂等，不重复追加
    const scope2 = await loadLocalScope('J-001');
    plan = buildMergePlan(scope2, pkg);
    // 已并入后该场在本机存在且与分队一致 → unchanged
    const entry = plan.entries.find((e) => e.kind === 'scene' && e.bizCode === 'J-001-S03');
    assert.equal(entry?.status, 'unchanged', '重复合并同一包应为无变化');
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));
    inserted = await db.scenes.where('bizCode').equals('J-001-S03').toArray();
    assert.equal(inserted.length, 1, '重试不重复追加');
    // 场序连续
    const all = await db.scenes.where('playId').equals(scope2.play!.id).toArray();
    assert.deepEqual(all.map((s) => s.seq).sort(), [1, 2, 3]);
  });

  it('分队撤掉场次：相关角色与锣鼓点级联清掉', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    // 分队删掉第二场（底稿有、分队无）
    det.scenes = det.scenes.filter((s) => s.bizCode !== 'J-001-S02');

    // 给第二场挂一个角色和锣鼓点在本机
    const s2local = local.scenes.find((s) => s.bizCode === 'J-001-S02')!;
    const r2 = makeRole(s2local.id, { bizCode: 'J-001-S02-R01', name: '小青' });
    const c2 = makeCue(s2local.id, { bizCode: 'J-001-S02-C01', atSecond: 30 });
    await db.roles.put(r2);
    await db.cues.put(c2);

    const pkg = assemblePkg(det, basePayload, 'pkg-del-scene');
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    assert.equal(unresolvedConflictCount(plan), 0, '本机没改第二场，直接随包删除');
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));

    const s2 = await db.scenes.where('bizCode').equals('J-001-S02').count();
    assert.equal(s2, 0, '场次删除');
    const r2left = await db.roles.where('bizCode').equals('J-001-S02-R01').count();
    assert.equal(r2left, 0, '角色级联删除');
    const c2left = await db.cues.where('bizCode').equals('J-001-S02-C01').count();
    assert.equal(c2left, 0, '锣鼓点级联删除');
    // 第一场不受影响
    const s1 = await db.scenes.where('bizCode').equals('J-001-S01').count();
    assert.equal(s1, 1);
  });

  it('分队撤掉操耍人：名下角色指派与领奏解绑干净', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    // 分队删掉 M-002；本机给 M-002 派一个角色与一处领奏
    det.operators = det.operators.filter((o) => o.bizCode !== 'M-002');

    const s1 = local.scenes.find((s) => s.bizCode === 'J-001-S01')!;
    const m2 = local.operators.find((o) => o.bizCode === 'M-002')!;
    const rBound = makeRole(s1.id, { bizCode: 'J-001-S01-R02', name: '许仙', operatorId: m2.id });
    const cBound = makeCue(s1.id, { bizCode: 'J-001-S01-C02', atSecond: 50, leadOperator: m2.id });
    await db.roles.put(rBound);
    await db.cues.put(cBound);

    const pkg = assemblePkg(det, basePayload, 'pkg-del-op');
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    assert.equal(unresolvedConflictCount(plan), 0);
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));

    const opLeft = await db.operators.where('bizCode').equals('M-002').count();
    assert.equal(opLeft, 0, '操耍人删除');
    const r = await db.roles.where('bizCode').equals('J-001-S01-R02').first();
    assert.equal(r?.operatorId, null, '角色指派解绑');
    const c = await db.cues.where('bizCode').equals('J-001-S01-C02').first();
    assert.equal(c?.leadOperator, null, '锣鼓点领奏解绑');
  });

  it('跨机指派：分队 uuid 不同但操耍人编号一致时，合并后绑定到本机该编号的人', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    // 底稿角色未指派，分队把它派给 M-002（用分队自己的 uuid）
    const detRole = det.roles.find((r) => r.bizCode === 'J-001-S01-R01')!;
    detRole.operatorId = det.operators.find((o) => o.bizCode === 'M-002')!.id;
    detRole.operatorBizCode = 'M-002';

    const pkg = assemblePkg(det, basePayload, 'pkg-bind');
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    assert.equal(unresolvedConflictCount(plan), 0, '按业务编号认人，不冲突');
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));

    const m2local = local.operators.find((o) => o.bizCode === 'M-002')!;
    const r = await db.roles.where('bizCode').equals('J-001-S01-R01').first();
    assert.equal(r?.operatorId, m2local.id, '绑定到本机 M-002 的 uuid，而非分队 uuid');
  });

  it('旧包无底稿：按当前记录迁移补齐后仍可合并（给出告警）', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    const scene = det.scenes.find((s) => s.bizCode === 'J-001-S01')!;
    scene.progress = 90;
    const pkg = assemblePkg(det, null, 'pkg-no-base');
    assert.equal(pkg.baseline, null);

    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    assert.ok(plan.warnings.some((w) => w.message.includes('缺少上次交接底稿')));
    // 底稿按当前记录补齐：分队改进度相对本机是单边改动
    assert.equal(unresolvedConflictCount(plan), 0);
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));
    const s = await db.scenes.where('bizCode').equals('J-001-S01').first();
    assert.equal(s?.progress, 90);
  });

  it('数组字段两边增删：默认并列保留（并集），也可选只用一边', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    // 角色影件：底稿 toucha；本机加 shenduan，分队加 bingqi
    const detRole = det.roles.find((r) => r.bizCode === 'J-001-S01-R01')!;
    detRole.propParts = ['toucha', 'bingqi'];
    await db.roles.put({ ...local.roles[0], propParts: ['toucha', 'shenduan'] });

    const pkg = assemblePkg(det, basePayload, 'pkg-array');
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    const roleEntry = plan.entries.find((e) => e.bizCode === 'J-001-S01-R01')!;
    const arrConflict = roleEntry.conflicts.find((c) => c.conflictKind === 'array');
    assert.ok(arrConflict, '影件两边各加 → 数组冲突');

    // 不选时阻断提交
    assert.equal(unresolvedConflictCount(plan), 1);
    // 默认 union：两边新增都保留
    const unionPlan = applyResolutions(plan, { 'role:J-001-S01-R01:0': 'union' });
    await commitMerge(unionPlan, pkg, await loadLocalScope('J-001'));
    const r = await db.roles.where('bizCode').equals('J-001-S01-R01').first();
    assert.deepEqual([...(r?.propParts ?? [])].sort(), ['bingqi', 'shenduan', 'toucha']);
  });

  it('一方删除场次另一方修改：产生删/留冲突，选保留则不级联删除', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    // 分队删第二场；本机改第二场标题
    det.scenes = det.scenes.filter((s) => s.bizCode !== 'J-001-S02');
    const s2 = local.scenes.find((x) => x.bizCode === 'J-001-S02')!;
    await db.scenes.put({ ...s2, title: '本机改名第二场' });

    const pkg = assemblePkg(det, basePayload, 'pkg-del-mod');
    const scope = await loadLocalScope('J-001');
    const plan = buildMergePlan(scope, pkg);
    const entry = plan.entries.find((e) => e.kind === 'scene' && e.bizCode === 'J-001-S02')!;
    const delConflict = entry.conflicts.find((c) => c.conflictKind === 'deleteModify');
    assert.ok(delConflict, '一边删一边改 → 删除/修改冲突');
    assert.equal(delConflict!.deletedBy, 'remote');
    assert.equal(unresolvedConflictCount(plan), 1);

    const kept = applyResolutions(plan, { 'scene:J-001-S02:0': 'keep' });
    await commitMerge(kept, pkg, await loadLocalScope('J-001'));
    const s2Left = await db.scenes.where('bizCode').equals('J-001-S02').first();
    assert.ok(s2Left, '选择保留则场次不删');
    assert.equal(s2Left?.title, '本机改名第二场');
  });

  it('悬挂操耍人编号：引用不存在的人时解绑为待指派', async () => {
    const local = await seedLocal();
    const basePayload = await makePkgFromLocal(local);
    const det = buildDetachmentView(basePayload);
    const detRole = det.roles.find((r) => r.bizCode === 'J-001-S01-R01')!;
    detRole.operatorBizCode = 'M-999';
    detRole.operatorId = uuid(); // 分队某台机器的 uuid

    const pkg = assemblePkg(det, basePayload, 'pkg-dangling');
    const scope = await loadLocalScope('J-001');
    const plan: MergePlan = buildMergePlan(scope, pkg);
    assert.ok(plan.danglingOperatorCodes.includes('M-999'));
    await commitMerge(plan, pkg, await loadLocalScope('J-001'));
    const r = await db.roles.where('bizCode').equals('J-001-S01-R01').first();
    assert.equal(r?.operatorId, null, '不存在的操耍人编号 → 解绑');
  });
});
